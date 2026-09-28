# Historical Strategy Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the invalid exploratory historical reports with a reproducible, fail-closed offline screen for timestamp-aligned external-price lead/lag data.

**Architecture:** A new pure research module accepts explicitly unit-tagged historical points and produces only causal pairs: the external return ending at `t` and the Polymarket change from `t` to `t + horizon`. A small CLI reads immutable JSON input and writes a report. Missing Chainlink settlement truth, executable historical costs, coverage, or sample depth yields `DATA_INSUFFICIENT`; it never asserts an edge or enables trading.

**Tech Stack:** Node.js ESM, node:test, no new dependencies.

**Spec:** `docs/strategy_research/BTC_5M_LEAD_LAG_PROTOCOL.md`

## Global Constraints

- Read-only research; no execution, ledger, risk, or live configuration changes.
- Historical inputs require explicit `s` or `ms` timestamp units; implicit conversion is prohibited.
- Existing protocol gates remain authoritative: missing data is `DATA_INSUFFICIENT`.
- Delete only the identified invalid spike artifacts under ignored `data/` plus its generated report.

---

### Task 1: Causal alignment primitives

**Files:**
- Create: `src/core/research/historical_strategy_screen.mjs`
- Create: `tests/test_historical_strategy_screen.mjs`

**Interfaces:**
- Produces `normalizeHistoricalPoint(point, timestampUnit)` and `buildCausalPairs({ external, polymarket, horizonMs })`.

- [x] Write failing tests that reject a missing unit, reject duplicate/out-of-order points, and prove the target uses only `t + horizon`.
- [x] Run `node --test tests/test_historical_strategy_screen.mjs`; verify the import fails because the module is absent.
- [x] Implement the minimal explicit-unit normalizer and exact timestamp matcher.
- [x] Re-run the focused test until it passes.

### Task 2: Fail-closed historical verdict

**Files:**
- Modify: `src/core/research/historical_strategy_screen.mjs`
- Modify: `tests/test_historical_strategy_screen.mjs`

**Interfaces:**
- Produces `evaluateHistoricalScreen({ pairs, expectedPairs, hasChainlinkSettlementTruth, hasExecutableCosts, minPairs, minCoverage })`.

- [x] Write failing tests for missing Chainlink truth/costs, insufficient coverage, and a complete negative-effect sample returning `SCREEN_FAIL`.
- [x] Run the focused test and verify the missing export failure.
- [x] Implement the minimal verdict evaluator and report metrics.
- [x] Re-run the focused test until it passes.

### Task 3: Reproducible offline command and artifact cleanup

**Files:**
- Create: `src/tools/polymarket_historical_strategy_screen.mjs`
- Modify: `package.json`
- Delete: `docs/STRATEGY_OPTIMIZATION_REPORT.md` and all `data/historical_*`, `data/lead_lag_short_horizons*`, `data/direction_accuracy*`, `data/order_book_analysis*`, `data/extreme_price_level*` files created by the failed spike.

- [x] Write a failing subprocess test for input parsing and a `DATA_INSUFFICIENT` report when required evidence flags are absent.
- [x] Run the focused test and verify failure before the CLI exists.
- [x] Implement the read-only CLI with explicit input/output paths and add `pm:historical-screen`.
- [x] Delete the invalid artifacts only after their replacement test is green.
- [x] Run focused tests, syntax checks, `git diff --check`, and document unavailable package scripts.
