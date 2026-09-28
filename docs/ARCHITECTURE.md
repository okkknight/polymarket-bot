# ARCHITECTURE

Polymarket BTC Rolling Market 自动交易系统架构（统一版）

更新时间：2026-03-11
项目根目录：仓库根目录。

---

## 1. 文档定位

本文件合并原：
- `SYSTEM_ARCHITECTURE.md`（As-Is：当前实现）
- `PRODUCTION_ARCHITECTURE.md`（To-Be：目标生产架构）

目标：作为**唯一架构事实源（SSOT）**，避免双文档漂移。

---

## 2. As-Is：当前可运行架构

```text
Market Data (Gamma/CLOB + BTC feed)
        ↓
Rolling Market Selector
        ↓
Signal + Strategy Logic
        ↓
Execution Adapter (shadow/live gateway)
        ↓
Realtime Runner (paper/shadow/live)
        ↓
CSV / JSONL Logs + Verdict Artifacts
```

### 2.1 当前主模块
- `src/core/rolling_market_selector.mjs`
- `src/runners/polymarket_paper_trading_realtime.mjs`
- `src/core/polymarket_execution_adapter.mjs`
- `src/core/execution/limit_order_executor.mjs`
- `src/core/execution/recovery_controller.mjs`
- `src/core/execution/live_execution_gateway.mjs`
- `src/core/state/trade_state_store.mjs`
- `src/core/state/runtime_state_controller.mjs`

### 2.2 当前运行编排
- `ops/scripts/run_live_canary_with_proxy.sh`
- `ops/scripts/preflight_strict_live.sh`
- `ops/scripts/run_live_canary_strict_sync.sh`
- `ops/scripts/run_canary_regression_gate.sh`
- `ops/scripts/start_polymarket_live_recoverable.sh`

### 2.3 当前已实现能力（摘要）
- 订单 intent 建模 + 幂等 `client_order_id`
- pre-trade guard（含 `RECONCILING` 状态阻塞）
- 订单状态机、状态查询、reconcile
- 运行时状态机：`RUNNING -> RECONCILING -> (RUNNING|HALTED)`
- bounded reconcile（`RECONCILE_GRACE_SEC/INTERVAL_SEC/MAX_RETRY`）
- 恢复流程与状态持久化（`data/trader_state.json`）
- strict-sync 结束结论：`FINAL_RESULT` + `data/last_run_summary.json`
- Run Verdict Center：`data/run_verdict.json`

### 2.4 关键事件（摘要）
- 交易执行：`ORDER_SUBMIT_REQUESTED / ORDER_ACKNOWLEDGED / ORDER_FILLED`
- 对账恢复：`ORDER_RECONCILE_* / RECOVERY_* / RECONCILE_*`
- 风控停机：`SAFE_HALT_TRIGGERED / RUNNER_BLOCKED_BY_HALT`
- 收尾结论：`FINAL_RESULT / RUNNER_SUMMARY`

---

## 3. To-Be：目标生产架构

### 3.1 三层账本模型

1) **Exchange Truth Layer**
- CLOB V2 `get_orders / get_trades / get_markets` 用于订单与成交证据；pUSD 是唯一 collateral
- Data API 的账户范围 `positions` 用于当前持仓真相；每页均校验返回的 `proxyWallet == POLY_FUNDER`
- 仓位分页截断、身份缺失或不一致均返回 `inconclusive`，不得推断为空仓

2) **Execution Ledger Layer**
- `client_order_id ↔ order_id`
- `executed_size / fill_price / associated_trades`
- order lifecycle 与证据链

3) **Exposure Ledger Layer**
- position / cash / claimable
- 仅由 fill 驱动更新，不由 submit 驱动
- Bridge deposit metadata 是人工充值前的独立只读检查；strict preflight 则校验 pUSD balance/allowance。资金迁移、wrap 和 allowance 变更均不由 bot 自动执行

### 3.2 启动硬门禁（Hard-Stop）
- unmanaged_holding
- unresolved_order
- exchange_bot_mismatch
- unresolved_claimable

任一失败 => `SAFE_HALT`（附带明确 reason）

### 3.3 结算与 claim 自动化（受控执行）
- 只从唯一 funder/account owner 的 `redeemable` position 检测候选，不扫描全站 resolved market；还必须验证终局 `curPrice=1` 与正的 `currentValue`。零价的已结算输家仓位不会进入 claim 队列
- claim 队列使用 `condition_id + asset_id` 幂等键，检测与真实执行分离
- 实际 redeem 使用官方 `polymarket-client` 的 Relayer API-key 认证（Safe / `POLY_SIGNATURE_TYPE=2`）。该 key 的关联地址必须等于本地 signer，且 signer 通过 `POLY_FUNDER` Safe 执行；提交前 durable intent、提交后记录 transaction ID、重启时先对账；`AUTO_CLAIM_ENABLED=true` 与 `CLAIM_EXECUTION_APPROVED=true` 缺一不可
- Relayer 结果未知时保持 `reconciliation_unknown`，不得重发；不得把“检测到”或“已提交”写成“已领取”

### 3.4 监控面板目标
- `/api/overview /api/orders /api/positions /api/events /api/health /api/claims`
- 前端 10s 自动刷新（有并发保护）
- 统一消费 `run_verdict` + `last_run_summary`

---

## 4. Gap 与迁移优先级

### P0（最高优先级）
- fill-truth convergence：本地事件与交易所事实统一收敛
- 压降 `unconfirmed_recovered_holdings` 误停机概率

### P1
- recovery evidence hardening：recent trades → order/exposure 证据链强化
- 保持 exposure 更新 fill-driven 且可重放

### P2
- dashboard/API 轻量化与低延迟保障
- 降低健康检查误报

### P3
- settlement/claim worker 自动化

---

## 5. 运行结果契约（Operational Contract）

strict-sync 运行结束后必须产出：
- stdout：`FINAL_RESULT {...}`
- 文件：`data/last_run_summary.json`
- 文件：`data/run_verdict.json`

三者用于：
- 人工运营判读
- dashboard/API 展示
- 通知与回归门禁消费

---

## 6. 与其他文档关系

- `PROJECT_CONTEXT.md`：项目总览（目标/参数/模块清单/近期验证）
- `ARCHITECTURE.md`（本文件）：架构事实源（As-Is + To-Be + Gap）
- `CHANGELOG.md`：中大型迭代记录
