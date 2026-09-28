# 策略证据筛查与准入门 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only, immutable market-data screen and replace the live BTC momentum entry with a fail-closed, externally validated BTC lead-lag probability evidence gate.

**Architecture:** A pure research core validates snapshots, tests whether external BTC spot/perpetual features lead subsequent Chainlink TWAP (using the window declared by each market rule) and Polymarket probability changes, calibrates an eligible probability model, and applies cost-aware trade eligibility. It reuses the existing OKX alignment and `external_price_lead` baseline behind a shared market-data adapter. A separate collector writes append-only public-market snapshots into a unique run directory; it records raw Polymarket/Chainlink RTDS reports as settlement truth. A report generator verifies integrity and evaluates seven held-out days. The live runner can create an intent only when a valid, recent `ELIGIBLE_FOR_REVIEW` report and current fair-probability checks both pass; existing live approvals and risk controls remain additional gates.

**Tech Stack:** Node.js ESM, built-in `fetch`, `node:crypto`, `node:fs/promises`, Bash, existing Gamma/CLOB/OKX public endpoints, `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-24-strategy-evidence-gate-design.md`

## Global Constraints

- Add no package dependency and read no credentials in collector/report tools.
- Collector has no execution, ledger, account, claim, or live-gateway import.
- Every collection run uses `runs/strategy-screen/<run-id>/`; refuse an existing directory and never overwrite raw data.
- Raw snapshots are append-only JSONL; incomplete market data is recorded as invalid, never converted to zero prices.
- A 30-minute run tests collection only. The current 7-day VPS screen also tests collection and can only return `DATA_INSUFFICIENT` or `SCREEN_FAIL`; it can never emit `ELIGIBLE_FOR_REVIEW`. That eligibility still requires 14 continuous days, approximately 4,000 completed five-minute markets, 95% valid snapshots, and the spec's seven-day held-out criteria.
- All costs use tradable prices: buy at ask and sell at bid, plus the market's exact taker fee `shares * feeRate * price * (1-price)`; midpoint is not a fill price.
- The only deployable candidate is a pre-registered external-lead probability model. The driftless-volatility probability is a benchmark and cannot trade by itself.
- Live remains blocked unless an explicit, integrity-checked, non-expired `ELIGIBLE_FOR_REVIEW` report is supplied. Existing `LIVE_DRY_RUN`, human approval and risk gates are not weakened.
- Do not commit or push unless the human explicitly asks.

---

### Task 0: Pre-registered candidate research protocol

**Files:**
- Create: `docs/strategy_research/BTC_5M_LEAD_LAG_PROTOCOL.md`
- Create: `tests/fixtures/strategy_evidence/lead_lag_fixture.jsonl`
- Modify: `tests/test_strategy_evidence.mjs`

**Interfaces:**
- Defines candidate IDs `no_trade`, `volatility_baseline`, and `external_lead_probability`.
- Defines the only promotion rule: compare all candidates on the same seven held-out natural days; only `external_lead_probability` may produce `ELIGIBLE_FOR_REVIEW`.
- Defines `evaluateLeadLag({ snapshots, featureLagSec }) -> { ok: boolean, reason: string, metrics: object }` fixtures used by Task 1.

- [ ] **Step 1: Write failing candidate-protocol tests**

```js
import { evaluateLeadLag } from '../src/core/research/strategy_evidence.mjs';

const result = evaluateLeadLag({ snapshots: leadLagFixture, featureLagSec: 1 });
assert.equal(result.ok, true);
assert.ok(result.metrics.forward_effect > 0);
assert.equal(
  evaluateLeadLag({ snapshots: shuffledFixture, featureLagSec: 1 }).ok,
  false,
);
```

- [ ] **Step 2: Run the test to verify it fails for missing lead-lag evaluator**

Run: `node --test tests/test_strategy_evidence.mjs`

Expected: FAIL because `evaluateLeadLag` is not exported.

- [ ] **Step 3: Write the protocol and fixture**

The protocol must state that all candidates are fixed before the seven held-out days begin; selection by the held-out results is prohibited. It must define the external features exactly: OKX BTC spot/perpetual mid return at 1/3/10/30 seconds, spot-perpetual basis, and top-of-book imbalance. It must require a positive forward effect from each training day and each held-out day after timestamp alignment, with a permutation/shuffled control that does not pass. It must state that no-trade is the default and that raw order-book snapshots are the source of truth.

- [ ] **Step 4: Run the protocol test**

Run: `node --test tests/test_strategy_evidence.mjs`

Expected: FAIL only because Task 1 has not yet implemented the evaluator; the fixture and documentation must parse/read successfully.

### Task 1: Pure fair-probability and report-admission core

**Files:**
- Create: `src/core/research/strategy_evidence.mjs`
- Create: `tests/test_strategy_evidence.mjs`

**Interfaces:**
- Produces `validateSnapshot(snapshot) -> { ok: boolean, reasons: string[] }`.
- Produces `estimateYesFairProbability({ startTwap, currentTwap, secondsRemaining, logReturns }) -> number | null`.
- Produces `parseTwapWindowSec(marketDescription) -> number | null`; unknown or conflicting rule text returns `null`.
- Produces `evaluateLeadLag({ snapshots, featureLagSec }) -> { ok: boolean, reason: string, metrics: object }`.
- Produces `calculateTakerFee({ shares, price, feeRate }) -> number`.
- Produces `decideTrade({ yesFairProbability, yesAsk, noAsk, yesBid, noBid, yesAskSize, noAskSize, minSize, feeRate, edgeBuffer, secondsRemaining }) -> { action: 'buy_yes'|'buy_no'|'hold', reason: string }`.
- Produces `evaluateEvidence({ snapshots, minDurationSec, minValidRatio, maxGapSec, holdoutRatio, minHoldoutTrades, minCompletedMarkets }) -> { verdict: 'DATA_INSUFFICIENT'|'SCREEN_FAIL'|'ELIGIBLE_FOR_REVIEW', reasons: string[], metrics: object }`.
- Produces `verifyEvidenceReport({ report, rawSha256, nowMs, maxAgeMs }) -> { ok: boolean, reason: string }`.

- [ ] **Step 1: Write the failing core-behaviour tests**

```js
import assert from 'node:assert/strict';
import {
  decideTrade,
  estimateYesFairProbability,
  evaluateEvidence,
  verifyEvidenceReport,
} from '../src/core/research/strategy_evidence.mjs';

assert.equal(estimateYesFairProbability({ startPrice: 100, spotPrice: 100, secondsRemaining: 60, logReturns: Array(60).fill(0.001) }), null);
assert.deepEqual(
  decideTrade({ yesFairProbability: 0.60, yesAsk: 0.59, noAsk: 0.42, yesBid: 0.57, noBid: 0.40, yesAskSize: 10, noAskSize: 10, minSize: 5, feeRate: 0.07, edgeBuffer: 0.02, secondsRemaining: 90 }),
  { action: 'hold', reason: 'edge_below_cost_buffer' },
);
assert.equal(evaluateEvidence({ snapshots: [], minDurationSec: 86400, minValidRatio: 0.95, maxGapSec: 10, holdoutRatio: 0.3, minHoldoutTrades: 30, minCompletedMarkets: 100 }).verdict, 'DATA_INSUFFICIENT');
assert.equal(verifyEvidenceReport({ report: { verdict: 'SCREEN_FAIL' }, rawSha256: 'a', nowMs: 1, maxAgeMs: 1 }).ok, false);
```

- [ ] **Step 2: Run the test to verify it fails for missing exports**

Run: `node --test tests/test_strategy_evidence.mjs`

Expected: FAIL because `src/core/research/strategy_evidence.mjs` does not exist.

- [ ] **Step 3: Implement the smallest pure core**

```js
export function estimateYesFairProbability({ startPrice, spotPrice, secondsRemaining, logReturns }) {
  const variance = sampleVariance(logReturns);
  if (!(startPrice > 0 && spotPrice > 0 && secondsRemaining > 0 && variance > 0)) return null;
  const z = Math.log(spotPrice / startPrice) / Math.sqrt(variance * secondsRemaining);
  return normalCdf(z);
}

export function calculateTakerFee({ shares, price, feeRate }) {
  return shares * feeRate * price * (1 - price);
}

export function decideTrade(input) {
  if (input.secondsRemaining < 60) return { action: 'hold', reason: 'near_settlement' };
  if (!(input.yesAsk > 0 && input.noAsk > 0 && input.yesBid > 0 && input.noBid > 0)) return { action: 'hold', reason: 'incomplete_book' };
  const yesRoundTripCost = input.yesAsk - input.yesBid + calculateTakerFee({ shares: 1, price: input.yesAsk, feeRate: input.feeRate }) + calculateTakerFee({ shares: 1, price: input.yesBid, feeRate: input.feeRate });
  const noRoundTripCost = input.noAsk - input.noBid + calculateTakerFee({ shares: 1, price: input.noAsk, feeRate: input.feeRate }) + calculateTakerFee({ shares: 1, price: input.noBid, feeRate: input.feeRate });
  const yesEdge = input.yesFairProbability - input.yesAsk - yesRoundTripCost - input.edgeBuffer;
  const noEdge = (1 - input.yesFairProbability) - input.noAsk - noRoundTripCost - input.edgeBuffer;
  if (input.yesAskSize >= input.minSize && yesEdge > 0) return { action: 'buy_yes', reason: 'yes_cost_adjusted_edge' };
  if (input.noAskSize >= input.minSize && noEdge > 0) return { action: 'buy_no', reason: 'no_cost_adjusted_edge' };
  return { action: 'hold', reason: 'edge_below_cost_buffer' };
}
```

Implement deterministic normal-CDF and sample-variance helpers without third-party dependencies. `evaluateLeadLag` must use only external features timestamped before the target Polymarket change, compare aligned forward effects with the shuffled control, and reject any day without positive forward effect. `evaluateEvidence` must reject timestamp regressions, coverage/gap failures, inadequate 14-day duration, incomplete-market count, failed lead-lag evaluation and held-out trade count before evaluating PnL. A held-out simulation opens at ask and closes at bid, deducts the exact fee `shares * feeRate * price * (1-price)` on each taker leg, and keeps training/holdout natural-day sets disjoint. `verifyEvidenceReport` must require exact raw hash, `ELIGIBLE_FOR_REVIEW`, a finite generated time inside age, and the report's stored quality/metrics requirements.

- [ ] **Step 4: Run core tests and inspect coverage semantics**

Run: `node --test tests/test_strategy_evidence.mjs`

Expected: PASS. Add explicit fixtures proving (a) fair probability cannot use future returns, (b) midpoint-profit/real-spread-loss is `SCREEN_FAIL`, and (c) a stale or mismatched report is rejected.

### Task 2: Immutable public-market collection run

**Files:**
- Create: `src/core/research/external_btc_market_data.mjs`
- Create: `src/tools/polymarket_strategy_screen_collector.mjs`
- Create: `ops/scripts/run_strategy_screen.sh`
- Modify: `src/tools/polymarket_external_lead_dataset.mjs`
- Modify: `package.json`
- Modify: `tests/test_strategy_evidence.mjs`

**Interfaces:**
- Consumes `--durationSec`, optional `--runId`, optional `--outputRoot`; default output root is `runs/strategy-screen`.
- Produces a completed run directory with `manifest.json` and append-only `raw.jsonl`.
- Produces `fetchExternalBtcMarketSnapshot({ fetchJson, nowMs }) -> { spot, perpetual, spotBook, perpetualBook, source_timestamps }` for both the new collector and the existing historical alignment tool.
- Produces `subscribeChainlinkPriceReports({ onReport, onError }) -> { close: () => void }`; raw reports are the only source for a market's opening and current settlement benchmark after a `parseTwapWindowSec`-declared rolling window is applied.
- Adds `pm:strategy-screen` package script for direct, read-only use.

- [ ] **Step 1: Extend the test with filesystem and fetch fixtures**

```js
const result = await runCollector({
  durationSec: 2,
  runId: '20260824T000000Z-test',
  outputRoot: fixtureRoot,
  fetchJson: fakePublicMarketFetch,
  now: fakeClock,
});
assert.equal(result.manifest.exit_reason, 'duration_elapsed');
assert.equal(result.manifest.raw_sha256.length, 64);
await assert.rejects(() => runCollector({ durationSec: 1, runId: result.runId, outputRoot: fixtureRoot, fetchJson: fakePublicMarketFetch, now: fakeClock }), /run_directory_exists/);
assert.equal(await readFile(result.rawPath, 'utf8'), originalRaw);
```

- [ ] **Step 2: Run the test to verify it fails for missing collector**

Run: `node --test tests/test_strategy_evidence.mjs`

Expected: FAIL because `runCollector` is unavailable.

- [ ] **Step 3: Implement collection with no execution imports**

```js
const runDir = resolve(outputRoot, runId);
await mkdir(runDir, { recursive: false });
await writeFile(manifestPath, JSON.stringify({ schema_version: 1, run_id: runId, started_at: nowIso(), status: 'running', read_only: true }) + '\n', { flag: 'wx' });
for (;;) {
  const row = await collectSnapshot();
  await appendFile(rawPath, JSON.stringify(row) + '\n', 'utf8');
  if (Date.now() >= deadline) break;
  await sleep(1000);
}
```

Extract the OKX public fetch/parsing logic from `polymarket_external_lead_dataset.mjs` into `external_btc_market_data.mjs`; retain the historical candle alignment command as a compatibility adapter. Add a Polymarket RTDS Chainlink BTC/USD raw-price subscriber to the same adapter, with a mocked-message test and a fail-closed reconnect/error state. Parse each market's declared TWAP window from its rule text; reject missing, ambiguous or conflicting windows. Discover active `btc-updown-5m` markets using the existing rolling-selector-compatible Gamma fields. For each selected YES/NO token, request the public CLOB book and record best bid, best ask and quantity from the actual book side, plus the current market fee schedule. Use the shared adapter to record public OKX BTC spot and perpetual midprice, top-of-book quantity and all source timestamps, and calculate the Chainlink rolling TWAP from the raw reports. Latch the first valid TWAP at or after the market's `eventStartTime` as its opening benchmark; no market may be evaluated until that value exists. On normal completion or controlled failure, calculate SHA-256 of `raw.jsonl`, atomically replace only `manifest.json` with a terminal manifest, and do not alter raw content. The Bash launcher must set `RUN_VIA_SH=1`, import only proxy settings, generate a run ID if absent, print paths/status, and invoke no scheduler or trading script.

- [ ] **Step 4: Add package script and command safety assertions**

Add:

```json
"pm:strategy-screen": "NODE_USE_ENV_PROXY=1 node src/tools/polymarket_strategy_screen_collector.mjs"
```

Assert collector source does not import `execution/`, `state/`, `live_gateway_bridge`, `loadTradeState`, or credentials. Assert launcher has no `launchctl`, `at`, or live runner invocation.

- [ ] **Step 5: Run collector tests and static checks**

Run: `node --test tests/test_strategy_evidence.mjs && node --check src/tools/polymarket_strategy_screen_collector.mjs && bash -n ops/scripts/run_strategy_screen.sh`

Expected: PASS.

### Task 3: Integrity-checked report command and strategy screen result

**Files:**
- Create: `src/tools/polymarket_strategy_screen_report.mjs`
- Modify: `src/core/research/strategy_evidence.mjs`
- Modify: `src/tools/polymarket_replay_paper.mjs`
- Modify: `tests/test_strategy_evidence.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes `--runDir`; reads only `manifest.json` and `raw.jsonl` from it.
- Produces `report.json` with exact raw SHA-256, generation time, thresholds, metrics, reasons and verdict.
- Adds `pm:strategy-report` package script.

- [ ] **Step 1: Write failing report tests**

```js
await writeFile(join(runDir, 'manifest.json'), JSON.stringify({ status: 'completed', raw_sha256: expectedHash }) + '\n');
await writeFile(join(runDir, 'raw.jsonl'), validRows.map(JSON.stringify).join('\n') + '\n');
const report = await generateReport({ runDir, nowMs: fixedNow });
assert.equal(report.verdict, 'DATA_INSUFFICIENT');
assert.ok(report.reasons.includes('duration_below_minimum'));
await appendFile(join(runDir, 'raw.jsonl'), '{"tampered":true}\n');
await assert.rejects(() => generateReport({ runDir, nowMs: fixedNow }), /raw_sha256_mismatch/);
```

- [ ] **Step 2: Run the test to verify it fails for missing report command**

Run: `node --test tests/test_strategy_evidence.mjs`

Expected: FAIL because `generateReport` is unavailable.

- [ ] **Step 3: Implement report generation**

```js
const rawSha256 = await sha256File(join(runDir, 'raw.jsonl'));
if (rawSha256 !== manifest.raw_sha256) throw new Error('raw_sha256_mismatch');
const snapshots = await readJsonLines(join(runDir, 'raw.jsonl'));
const evaluation = evaluateEvidence({ snapshots, ...DEFAULT_THRESHOLDS });
const report = { schema_version: 1, run_id: manifest.run_id, raw_sha256: rawSha256, generated_at: new Date(nowMs).toISOString(), thresholds: DEFAULT_THRESHOLDS, ...evaluation };
await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
```

Reject nonterminal manifests, malformed JSONL, missing/invalid raw hash, and existing `report.json`; never silently replace an earlier report. Route the existing `external_price_lead` replay through the shared evaluator as the nondeployable momentum baseline, replacing its proxy spread and fixed-fee assumptions with actual book/fee fields when supplied. A 30-minute fixture must be `DATA_INSUFFICIENT`; a 14-day synthetic fixture must prove every daily leading-effect, held-out volume and cost-aware PnL requirement before `ELIGIBLE_FOR_REVIEW`; a synthetic bid/ask loss or one failed daily lead-lag test is `SCREEN_FAIL`.

- [ ] **Step 4: Add package script and run report tests**

Add:

```json
"pm:strategy-report": "node src/tools/polymarket_strategy_screen_report.mjs"
```

Run: `node --test tests/test_strategy_evidence.mjs && node --check src/tools/polymarket_strategy_screen_report.mjs`

Expected: PASS.

### Task 4: Fail-closed live evidence and fair-price guard

**Files:**
- Create: `src/core/risk/strategy_evidence_guard.mjs`
- Modify: `src/runners/polymarket_paper_trading_realtime.mjs`
- Modify: `ops/scripts/start_polymarket_live_recoverable.sh`
- Modify: `ops/scripts/run_live_canary_with_proxy.sh`
- Modify: `tests/test_strategy_evidence.mjs`
- Modify: `tests/test_operational_paths.mjs`

**Interfaces:**
- Produces `loadAndVerifyStrategyReport({ path, rawSha256, nowMs, maxAgeMs, readFile }) -> Promise<{ ok: boolean, reason: string }>`.
- Produces `evaluateLiveFairPrice({ market, snapshot, cfg }) -> { action: 'buy_yes'|'buy_no'|'hold', reason: string }` by calling Task 1's pure functions.
- Consumes `--strategyReportPath` and `--strategyReportMaxAgeSec`; for `--mode live`, report path is mandatory and absence blocks every intent.

- [ ] **Step 1: Write failing live-gate tests**

```js
const missing = await loadAndVerifyStrategyReport({ path: '', rawSha256: 'x', nowMs: 1, maxAgeMs: 1, readFile });
assert.deepEqual(missing, { ok: false, reason: 'strategy_report_required' });
const blocked = evaluateLiveFairPrice({ market: { startPrice: null }, snapshot: completeBook, cfg: liveCfg });
assert.equal(blocked.action, 'hold');
assert.equal(blocked.reason, 'start_price_unavailable');
```

Extend operational tests to assert that the live runner checks the report before `buildLimitIntent`, while dry-run/shadow does not load a report or modify it.

- [ ] **Step 2: Run the test to verify it fails for missing guard module**

Run: `node --test tests/test_strategy_evidence.mjs tests/test_operational_paths.mjs`

Expected: FAIL because `strategy_evidence_guard.mjs` does not exist and live runner lacks report gating.

- [ ] **Step 3: Implement the guard and replace the direction rule**

```js
if (CFG.mode === 'live' && !strategyReportGate.ok) {
  await event('STRATEGY_EVIDENCE_BLOCKED', { run_id: runId, reason: strategyReportGate.reason });
  await sleep(200);
  continue;
}
const candidate = evaluateLiveFairPrice({ market: current.market, snapshot: currentSnapshot, cfg: CFG });
if (candidate.action === 'hold') {
  await event('STRATEGY_SIGNAL_SKIPPED', { run_id: runId, reason: candidate.reason, market_id: current.marketId });
  await sleep(200);
  continue;
}
```

Replace only the block that turns `r1`/`r3` into `buy_yes`/`buy_no`; preserve existing size calculation, validation mode, pre-trade guard, ledger, recovery and live risk checks. Fetch the live bid/ask book alongside a fresh Chainlink TWAP value for the selected tokens. Fail closed when the market does not specify the Chainlink TWAP rule, a start/current TWAP is unavailable or stale, the market is within 60 seconds of settlement, either book is incomplete, or minimum visible size is inadequate. The launcher scripts must forward report path/age arguments but must not supply a default path, so ordinary live invocation safely blocks until a human provides a reviewed report.

- [ ] **Step 4: Run focused and existing safety tests**

Run:

```bash
node --test tests/test_strategy_evidence.mjs tests/test_operational_paths.mjs tests/test_recovery_safety.mjs tests/test_live_config_guard.mjs tests/test_execution_fix.mjs tests/test_convergence.mjs
node --check src/runners/polymarket_paper_trading_realtime.mjs
node --check src/core/risk/strategy_evidence_guard.mjs
bash -n ops/scripts/run_strategy_screen.sh ops/scripts/start_polymarket_live_recoverable.sh ops/scripts/run_live_canary_with_proxy.sh
git diff --check
```

Expected: PASS. Verify `npm test`, `npm run lint`, and `npm run build`; report each absent script explicitly instead of inventing an equivalent.

### Task 5: Operator documentation and final read-only smoke run

**Files:**
- Modify: `README.md`
- Modify: `docs/PROJECT_CONTEXT.md`
- Modify: `ops/runbooks/ENTRYPOINTS.md`
- Modify: `tests/test_operational_paths.mjs`

**Interfaces:**
- Documents `bash ops/scripts/run_strategy_screen.sh` and `node src/tools/polymarket_strategy_screen_report.mjs --runDir <absolute-run-dir>`.
- Documents that the 24-hour validation process is read-only, and `ELIGIBLE_FOR_REVIEW` is not an authorisation to trade.

- [ ] **Step 1: Write failing documentation/entrypoint assertions**

```js
const readme = await readFile(resolve(repoRoot, 'README.md'), 'utf8');
assert.match(readme, /run_strategy_screen\.sh/);
assert.match(readme, /ELIGIBLE_FOR_REVIEW/);
assert.match(readme, /14 个自然日/);
```

- [ ] **Step 2: Run the test to verify it fails before documentation**

Run: `node --test tests/test_operational_paths.mjs`

Expected: FAIL because the entrypoints and 14-day evidence constraint are not documented.

- [ ] **Step 3: Document bounded operations and report meaning**

Document a 30-minute collector command as a pipeline smoke test, then the continuous 14-day validation procedure: seven fixed training days followed by seven held-out natural days. State data directory layout, report outcomes, non-overwrite behavior, external-lead hypothesis and that an eligible report needs separate human live approval. Do not document a command that submits orders.

- [ ] **Step 4: Run all verification and a short, read-only collector smoke run**

Run:

```bash
npm test
npm run lint
npm run build
node --test tests/test_strategy_evidence.mjs tests/test_operational_paths.mjs tests/test_recovery_safety.mjs tests/test_live_config_guard.mjs tests/test_execution_fix.mjs tests/test_convergence.mjs
node --check src/tools/polymarket_strategy_screen_collector.mjs src/tools/polymarket_strategy_screen_report.mjs src/runners/polymarket_paper_trading_realtime.mjs
bash -n ops/scripts/run_strategy_screen.sh ops/scripts/run_live_canary_with_proxy.sh ops/scripts/start_polymarket_live_recoverable.sh
RUN_VIA_SH=1 bash ops/scripts/run_strategy_screen.sh --durationSec 10
git diff --check
```

Expected: package scripts that do not exist must report their absence; all available checks pass. The 10-second smoke run must create a unique run directory, write no trading state and create no order.
