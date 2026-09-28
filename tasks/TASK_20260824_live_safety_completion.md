# Task: Live safety completion and account-flow closure

## 0. Task Summary

在不改变策略、仓位规模和风险阈值的前提下，补齐实盘交易的安全边界：阻止误触发实盘、保持 recovery 状态、让撤单与账户身份可验证，并将资金/claim/仪表盘写入能力收敛为显式审批的独立流程。

当前结论：**在本任务完成并验收前，不得执行非 dry-run 的 canary、recovery 或 claim。**

实施状态（2026-08-24）：Phase A/B/C/E 已完成代码与独立复审；Phase D 已完成账户范围内的余额/allowance 读取、每笔最大允许 notional 的资金闸门、资金操作禁用、redeemable 持仓检测，以及默认关闭的 Builder Relayer claim adapter。claim 写入 durable intent 后才提交，重启时只查询原 transaction；没有 Builder 配置、显式开关或单独实盘授权时不得提交。

## 1. Human decisions required before implementation

以下均会影响真实资产或 recovery 语义，不能由 Codex 自行决定。

| Decision | Recommended default | Approval needed |
| --- | --- | --- |
| Execution account identity | 当前配置使用 Polymarket proxy/funder 模式；将已配置的 `POLY_FUNDER` 作为唯一持仓归属账户，并在启动时交叉校验，失败即 halt | 已可按现有配置实施；人类只需确认该 funder 确为日常使用的 Polymarket 交易账户 |
| Recovery cancellation | 仅自动撤销能由 bot client-order-id 和本地证据共同确认的超时订单；未知交易所订单只 halt、记录，不撤 | **已批准**；沿用 60 秒 unresolved timeout |
| Funding / allowance | 本轮只实现余额与 allowance 的账户级检查和可诊断报错；不实现 deposit、withdraw、transfer 或自动 allowance 更新 | **已批准**；资金保持外部/手工转入 |
| Claim | 实现受控自动 claim：仅账户持仓关联、最终已结算且赢家份额已验证的市场；每次领取具备幂等记录、审计日志与失败重试 | **已批准**；不得对仅“全站已结算”但无账户持仓证据的市场领取 |
| Dashboard writes | 绑定 loopback，移除或默认禁用 `/api/adopt`；账本修复改为显式、受认证的运维命令 | **已批准**：仅允许本机访问 |
| Client migration | 固定已验证的 `py-clob-client` 版本并增加契约测试；不在本轮升级 SDK | 确认是否把 SDK v2 迁移列入后续独立任务 |

## 2. Implementation sequence

### Phase A — Freeze unsafe entry points (no external-order behavior)

**Files**
- `ops/scripts/run_live_canary_regression_gate.sh`
- `ops/scripts/pre_live_go_no_go.sh`
- `ops/scripts/run_live_canary_with_proxy.sh`
- `tests/test_operational_paths.mjs`

**Changes**
1. Make every regression/canary wrapper dry-run by default and require one explicit environment gate for a non-dry run.
2. Correct stale source-path checks in the go/no-go script.
3. Split read-only preflight from recovery commands that can mutate exchange state; the default go/no-go command must not call a mutating recovery action.
4. Add static tests that reject a script whose default path can enter non-dry-run mode without the explicit gate.

**Acceptance criteria**
- A plain invocation of every live wrapper cannot submit or cancel an exchange order.
- A non-dry-run invocation fails closed unless the explicit gate is set.
- Go/no-go validates the current `src/core/execution/recovery_controller.mjs` path.

### Phase B — Preserve recovery and make cancellation real

**Files**
- `src/runners/polymarket_state_reset_for_canary.mjs`
- `ops/scripts/run_live_canary_with_proxy.sh`
- `src/core/execution/recovery_controller.mjs`
- `src/core/execution/limit_order_executor.mjs`
- focused tests under `tests/`

**Changes**
1. Replace the blanket canary state reset with a narrowly scoped preparation step that never deletes `intents`, `intent_index`, unresolved orders, halt evidence, or recovery metadata.
2. Pass the approved `liveCancel` callback through recovery and call it only for an order meeting the approved bot-owned/evidence requirements.
3. Persist a cancellation-attempt record before/after the request so crash recovery cannot repeat an ambiguous cancel blindly.
4. On unknown ownership, failed identity validation, or ambiguous cancel result, halt with a structured reason instead of adopting or cancelling.

**Tests (write first)**
- A pre-existing unresolved intent survives canary preparation.
- A confirmed bot-owned stale order invokes cancellation once and records the result.
- An unknown exchange order never invokes cancellation.
- A restart after an ambiguous cancel remains halted until reconciliation supplies definitive evidence.

**Acceptance criteria**
- The configured recovery cancellation policy is observable in logs and state.
- No recovery route silently drops a provided live-cancel callback.
- Idempotency evidence survives a canary invocation.

### Phase C — Establish account identity and bounded reconciliation

**Files**
- `execution/live_gateway_bridge.py`
- `src/core/execution/live_execution_gateway.mjs`
- `src/core/execution/recovery_controller.mjs`
- `src/runners/polymarket_live_preflight.mjs`
- focused gateway/recovery tests

**Changes**
1. Add an explicit, validated account-owner input for position and trade ownership; do not compare maker/taker owners to an API key.
2. Return the owner identity, balance, allowance, query cursor/page count, and truncation state in bridge responses needed by preflight/recovery.
3. Replace unbounded `get_trades()` scans with explicit bounded pagination. If the configured window cannot establish a complete answer, return `inconclusive` and halt rather than infer an empty position.
4. Disable automatic exposure adoption by default until the identity and evidence model passes the new tests; surface an explicit operator action for any adoption.
5. Add a preflight failure when the configured owner identity cannot be validated against the chosen signing/funder model.

**Tests (write first)**
- Maker and taker trades are attributed using the configured owner, not API credentials.
- A multi-page response respects the configured bound and returns inconclusive when exhausted.
- Inconclusive reconciliation cannot clear a halt or fabricate a flat position.
- Missing allowance / insufficient balance produces a precise preflight failure without attempting a transfer.

**Acceptance criteria**
- Recovery and positions use one documented account identity.
- Exchange-history scans are bounded and their confidence is explicit.
- A data-source timeout cannot be mistaken for “no exposure”.

### Phase D — Separate funds and claims from trading execution

**Files**
- `execution/live_gateway_bridge.py`
- `src/runners/polymarket_live_preflight.mjs`
- `src/ops/auto_claim_worker.mjs`
- `docs/ARCHITECTURE.md`
- `docs/PROJECT_CONTEXT.md`

**Changes**
1. Make preflight consume account-scoped balance and allowance data, retaining both fields in the bridge response.
2. Explicitly label funding as external/manual in this release; no bridge action for deposit, withdrawal, transfer, or allowance mutation.
3. Change claim discovery to report only resolved markets where the configured account has evidence of a winning, claimable holding; do not write globally resolved markets to `claims.pending`.
4. Implement the approved claim adapter as a separate, explicit asset-moving operation. It must use the configured account identity, record a durable claim intent before submission, record the transaction/relayer result after submission, and reconcile on restart before retrying.
5. Permit automatic claim only after final resolution and account-scoped holding verification. Treat a timeout or unknown transaction state as pending reconciliation, never as a successful or failed claim.
6. Add a low-available-balance advisory that prioritizes reconciling already-approved pending claims before beginning a new trading run; it must not override existing risk gates or submit an order.

**Acceptance criteria**
- Insufficient usable balance or allowance blocks a run with an actionable message.
- A resolved market with no account exposure is not considered a claim candidate.
- Each automatic claim has one durable intent and auditable terminal/reconciliation state; restart cannot blindly submit a second claim.
- An unavailable claim path cannot be reported as a successful claim or silently counted as usable balance.

### Phase E — Lock down dashboard operations

**Files**
- `src/web/dashboard_api.mjs`
- `tests/test_operational_paths.mjs`
- `ops/runbooks/ENTRYPOINTS.md`

**Changes**
1. Bind the dashboard to loopback by default and remove wildcard CORS for mutating routes.
2. Remove `/api/adopt` unless the human approves an authenticated operator workflow. If retained, require a configured authentication mechanism, an explicit confirmation token, audit log, and preserve the existing halt until reconciliation is verified.
3. Make the read-only contract true: GET routes must not mutate state; all state repair must be explicit and logged.

**Acceptance criteria**
- A remote unauthenticated request cannot mutate `trader_state.json`.
- Dashboard documentation accurately distinguishes read-only views from any approved operator command.

## 3. Verification matrix

Run after each relevant phase:

```bash
node --test tests/test_operational_paths.mjs
node --test tests/test_execution_convergence.mjs
node --test tests/test_pretrade_accounting.mjs
node --check src/core/execution/recovery_controller.mjs
node --check src/web/dashboard_api.mjs
python3 -m py_compile execution/live_gateway_bridge.py
bash -n ops/scripts/*.sh
```

Then run only read-only operational checks:

```bash
RUN_VIA_SH=1 node src/runners/polymarket_live_preflight.mjs --mode live
```

`npm test`, `npm run lint`, and `npm run build` must be attempted and reported. This repository currently has no `package.json` scripts for those commands, so the command absence must be reported along with the focused substitutes above.

Non-dry-run canary, real cancellation, and real claim are excluded from automated validation. Their implementation is approved, but their first real-exchange execution still requires a separate human go-ahead after code review and functional acceptance.

## 4. Review and functional acceptance

### Codex

Implement one phase at a time with small diffs. Do not change strategy logic, sizing, market selection, risk thresholds, storage schema, or production secrets. Report tests run and the explicit real-exchange acceptance gaps.

### OpenClaw review

Reject if any path can enter non-dry-run mode by default, erase recovery evidence, infer ownership from API credentials, treat incomplete history as no position, cancel unknown orders, or leave an unauthenticated dashboard mutation endpoint.

### Human final acceptance

Approve the decisions in section 1 before Phase B onward. Actual live cancellation, transfer/allowance update, claim execution, or non-dry-run order requires a separate post-review go-ahead.

## 5. Risks / limitations

- The exact claim adapter/relayer contract route must be selected from current official Polymarket documentation during implementation; no contract address or transaction method is assumed in this plan.
- A local test or CLOB health response does not establish live-order or settlement correctness.
- Current worktree changes predating this plan remain uncommitted and must be reviewed separately; this planning task makes no production change.
