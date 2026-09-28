# PROJECT_CONTEXT（历史产品背景）

> 当前运行状态、最新任务、VPS 采集与安全边界的唯一入口是仓库根目录 [`PROJECT_CONTEXT.md`](../PROJECT_CONTEXT.md)。本文件保留较长的产品背景与历史记录，不应作为当前实盘或策略资格判断依据。

Polymarket BTC Rolling Market 自动交易系统（现状版）

更新时间：2026-03-11
项目根目录：仓库根目录。

## 文档分工（快速索引）
- 仓库根目录 `PROJECT_CONTEXT.md`：当前项目总览、运行状态与交接入口。
- 本文件：历史产品背景、参数和模块说明。
- `ARCHITECTURE.md`：系统架构单一事实源（As-Is + To-Be + Gap + 运行结果契约）。
- `CHANGELOG.md`：中大型迭代记录。

---

## 1. 项目目标

围绕 `btc-updown-5m` 的 rolling market，构建一套可迭代的交易研发流水线：

1) 信号验证（external lead / impulse）
2) 回放回测（replay）
3) 实时模拟（paper）
4) 执行模拟（shadow）
5) 逐步走向 live（待实现完整执行与风控）

---

## 2. 当前策略参数（分层）

**策略核参数（realtime/shadow）**
```txt
window=3
entry_th=0.0003
gate=0.00015
scale_factor=0.0003
singleTradePerTick=true
noPyramid=true
flip=close_only
feeRate=0.001
slippageBps=1
```

**近期 live canary 常用运行参数（运营基线）**
```txt
durationSec=600/1200
slugPrefix=btc-updown-5m
watchSec=30
tickSec=1
baseSize=2.1
minOrderUsd=1
minOrderShares=5
maxPosition=6
maxOrderNotional=5
maxOrdersPerMinute=6
dailyLossLimit=1.5
cooldownSec=3600
unresolvedOrderLimitMs=60000
validationMode=true
resumeFromHalt=true
```

策略逻辑（简述）：
- 以 BTC 短窗口变动作为触发
- 信号触发后按波动大小做仓位缩放
- 严格限制每 tick 交易次数和反向处理

---

## 3. 当前模块状态（按真实代码）

### 3.1 已实现并在用

- `src/core/rolling_market_selector.mjs`
  - 选择可交易 rolling market，支持 rollover

- `src/runners/polymarket_paper_trading_realtime.mjs`
  - realtime 主循环
  - 支持 `paper` / `shadow` 模式
  - 输出 realtime 日志和事件

- `src/core/polymarket_execution_adapter.mjs`
  - 从 signal 生成 shadow 订单 payload
  - 模拟成交价（midpoint + slippage）
  - 计算 fill slippage 指标

- `src/core/execution/limit_order_executor.mjs`（Phase 1~2.2）
  - 定义 limit order intent
  - pre-trade guard（不确定状态触发安全停止）
  - 幂等提交键（client_order_id）与 dry-run 提交流程
  - 订单对账检查（reconcile）与未终态超时停机
  - 订单状态机（合法迁移校验）与外部状态查询占位

- `src/core/state/trade_state_store.mjs`（Phase 1~2.2）
  - 持久化交易状态文件（`data/trader_state.json`）
  - 记录 intent 执行结果与 `intent_index`，降低重启后重复提交风险
  - 启动即落盘，确保状态面可恢复

- 数据/分析相关
  - `src/tools/polymarket_build_dataset.mjs`
  - `src/tools/polymarket_replay_paper.mjs`
  - `src/tools/polymarket_metrics_report.mjs`
  - `src/tools/polymarket_readonly.mjs`
  - `src/tools/polymarket_market_finder.mjs`
  - `src/tools/polymarket_price_tracker.mjs`
  - `src/tools/polymarket_activity_scan.mjs`

### 3.2 入口收敛说明（避免混淆）

- 历史脚本 `polymarket_paper_trading_live.mjs` 已移除（避免与 realtime 主入口重复）。
- 统一主入口应使用 `src/runners/polymarket_paper_trading_realtime.mjs`（通过 `--mode` 选择 `paper|shadow|live`）。

### 3.3 待补齐（live 前关键项）

- 完整限价单执行链路（下单/签名/提交/回执/重试）
- 稳定网络恢复机制（明确退避、重试、告警策略）
- 状态持久化与重启恢复
- 全局 kill switch / 风险闸门

---

## 4. 运行模式（现状）

- `replay`：历史数据回放验证
- `paper`：实时模拟（不接真实执行）
- `shadow`：构建订单并模拟成交，不发送真实订单
- `live`：已接入真实执行网关 + 恢复增强骨架（幂等/对账/状态机/恢复控制面/状态压缩归档/网络退避与安全停机）；是否 dry-run 由启动参数控制（运营脚本可显式 `LIVE_DRY_RUN=false`）。
- 新增 preflight gate：`src/runners/polymarket_live_preflight.mjs`，用于实盘前就绪检查。
- 认证与订单链路使用 `py-clob-client-v2` bridge；支持官方 Safe/proxy funder 模式（`POLY_SIGNATURE_TYPE=2` + `POLY_FUNDER`），不保留 V1 下单回退。
- 新增 strict-sync 运行流程：`ops/scripts/run_live_canary_strict_sync.sh`（跑前对账 -> canary -> 跑后对账）。
- strict-sync 新增“结论固化”能力：结束时输出 `FINAL_RESULT` 并写入 `data/last_run_summary.json`（无 LLM 轮询）。
- 新增 Run Verdict Center V1：结束时写入 `data/run_verdict.json`，统一本地事件口径、交易所事实口径、post-reconcile 口径。
- strict-sync 支持可选通知：macOS 本机通知、Telegram 推送（需配置 `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`）。
- 新增回归门禁包装器：`ops/scripts/run_canary_regression_gate.sh`（可按 `REQUIRE_POST_RECONCILE_OK` / `REQUIRE_REAL_FILL` 做 PASS/FAIL）。
  - 安全默认：`LIVE_DRY_RUN=true`。
  - 若要允许真实下单，必须显式设置 `REGRESSION_ALLOW_LIVE=true`。
- 风控行为更新：notional 超限默认跳过信号（`RISK_SIGNAL_SKIPPED`），避免整轮直接停机。
- 下单约束更新：新增 `minOrderShares`（默认 5）与 `minOrderUsd`/`maxPosition` 约束一致性检查。
- 运行时配置硬门禁：启动即执行 `src/core/risk/runtime_config_guard.mjs`，若出现不可满足约束（如 `minOrderShares > maxPosition`）直接 `CONFIG_VALIDATION_FAILED` 并阻断运行。
- 超时收尾更新：主循环与提交后两条 reconcile 分支都支持超时后自动 cancel（失败再停机），减少尾仓残留。
- 账户事实源：仓位与余额均以 `POLY_FUNDER`（可选的 `POLY_ACCOUNT_OWNER` 必须完全相同）为唯一账户；当前仓位从账户范围 Data API `positions` 分页读取，并逐条验证 `proxyWallet`，CLOB 交易历史仅作为订单/成交审计证据。分页截断、身份不明或来源不完整一律 `SAFE_HALT`，不会按零仓位继续。
- 结算与 claim：claim worker 只读查询该账户的 `redeemable` 持仓，不再扫描全站已结算市场；候选还必须有终局 `curPrice=1` 和正的 `currentValue`，所以零价输家不会生成 claim intent。redeem 使用官方 `polymarket-client` 的 Relayer API-key 模式，key 的关联地址必须等于本地 signer，Safe/funder 仍是唯一资金归属账户。每次先持久化 intent，再提交、记录 Relayer transaction ID，并在重启时仅对原 transaction 对账。`AUTO_CLAIM_ENABLED` 与 `CLAIM_EXECUTION_APPROVED` 默认均为 `false`，缺少有效 Relayer API key 时也会失败关闭。
- 资金操作边界：CLOB V2 collateral 为 `pUSD`。当前实现只读查询 pUSD balance/allowance；Bridge deposit metadata 是单独的人工充值前检查。实际运行前要求 balance/allowance 都至少覆盖一笔 `MAX_ORDER_NOTIONAL`（以 CLOB micro-unit 口径比较），不足即阻断；不自动 transfer、deposit、wrap、withdraw 或修改 allowance。

---

## 5. 关键输出文件（现状常用）

位于：`data/`

常见产物：
- `paper_trading_realtime_log*.csv`
- `paper_trading_realtime_events*.jsonl`
- `shadow_trading_orders*.csv`
- `last_run_summary.json`（strict-sync 机器可读收尾结论）
- `run_verdict.json`（strict-sync 统一结论口径，供 dashboard/API/通知消费）
- 各类 `markets_*.json` / 数据集与报告文件

---

## 6. 已完成验证（近期）

### Realtime Paper Trading（历史基线）
- final_equity: `1017.896976`
- total_trades: `888`
- win_rate: `0.2421`
- max_drawdown: `0.006274`

### Shadow Trading（历史基线）
- orders_count: `430`
- avg_fill_slippage: `1 bps`
- final_equity: `1034.830445`
- total_trades: `860`
- win_rate: `0.2465`
- max_drawdown: `0.002594`

### Live canary（2026-03-10 近期实测）
- 查询稳定性：`exchange_positions_query_failed` 已显著缓解（positions query 典型 2~8s）。
- 真实成交：已多次观测到 `ORDER_FILLED` 与交易所 `CONFIRMED trades`。
- 结论固化：strict-sync 结束可产出 `FINAL_RESULT` + `data/last_run_summary.json`。
- 仍需持续关注：个别轮次可能出现 `unconfirmed_recovered_holdings`（需靠回补证据链持续收敛）。

---

## 7. 当前结论

- paper/shadow 链路稳定，可持续用于策略迭代。
- live canary 已可反复执行并拿到可用收尾结论（含机器可读 `FINAL_RESULT`）。
- 当前主风险已从“查询超时”转向“成交事实与本地账本收敛时序差”（需继续压降 `unconfirmed_recovered_holdings` 触发概率）。
- 代码、运行脚本与 dashboard 均以仓库根目录为应用根。
