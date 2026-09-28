# Project Context

更新时间：2026-08-25（以仓库与 VPS 只读检查为准）

## 项目是什么 / 不是什么

- 这是一个面向 Polymarket BTC 5 分钟 Up/Down 市场的研究、模拟与受严格门禁保护的交易系统。
- 它不是自动盈利承诺，也不是可在缺少证据时自动开启实盘的机器人。

## 当前状态

最新任务：**策略研究数据质量修复与 7 天只读采集** — **已执行待验收**。

- `task/live-safety-completion` 已推送；最新提交为 `30feb36`。
- 腾讯云 VPS 上的 `polymarket-strategy-screen-7d-r2.service` 正在运行，`Restart=no`；run ID 为 `20260825T023600Z-seven-day-restart`。
- 该任务只读取公开 Gamma/CLOB/OKX/Polymarket RTDS 数据；不读取账户凭据、不创建订单、不更新账本。
- 旧 run 因 RTDS 断线后使用陈旧报价而被停止并删除；新实现会重连 RTDS，并在 Chainlink 报价超过 10 秒未更新时把快照判为无效。
- 7 天运行只能得到 `DATA_INSUFFICIENT` 或 `SCREEN_FAIL`，绝不可作为 `ELIGIBLE_FOR_REVIEW` 或实盘授权。完整资格仍需要 14 天、训练/样本外分割及人工复核。

## 架构与状态流

```text
公开市场数据 -> 策略筛查采集 -> 不可变 raw run / 报告
                                      |
                                      v
                             证据门禁（默认阻断）
                                      |
配置/资金/身份 preflight -> recovery/reconciliation -> 显式批准的 live runner
```

- 研究采集：`src/tools/polymarket_strategy_screen_collector.mjs`；仅公共网络数据。
- 交易执行：`src/runners/polymarket_paper_trading_realtime.mjs` + `src/core/execution/*`；live 非 dry-run 仍需现有显式人工门禁。
- 账本真相：`data/trader_state.json` 与交易所账户范围 positions/recovery 对账；不完整来源必须 halt，不能按空仓推断。
- 资金与 claim：pUSD balance/allowance 只读检查；充值、授权、转账不由 bot 自动执行。claim 另有持久化 intent 与显式双开关。

## 快速导航

- [AGENTS.md](AGENTS.md)：仓库安全边界与角色规则。
- [任务说明](tasks/TASK_20260824_live_safety_completion.md)：实盘安全、资金与 claim 的批准边界。
- [策略研究协议](docs/strategy_research/BTC_5M_LEAD_LAG_PROTOCOL.md)：候选策略、数据真值与放行标准。
- [策略筛查器](src/tools/polymarket_strategy_screen_collector.mjs)：VPS 当前运行的公共数据采集器。
- [RTDS/外部数据适配器](src/core/research/external_btc_market_data.mjs)：Chainlink 订阅、自动重连。
- [策略证据核心](src/core/research/strategy_evidence.mjs) 与 [存储](src/core/research/strategy_screen_storage.mjs)：TWAP、费用与新鲜度门禁。
- [运行入口](ops/scripts/run_live_canary_strict_sync.sh) 与 [严格 preflight](ops/scripts/preflight_strict_live.sh)：live 前流程。
- [旧产品背景](docs/PROJECT_CONTEXT.md) 与 [架构详述](docs/ARCHITECTURE.md)：历史设计资料；当前运行状态以本文件为准。

## 已验证

最近一次本地验证：

```bash
node --test tests/test_claim_worker_lifecycle.mjs tests/test_claim_worker_safety.mjs tests/test_live_config_guard.mjs tests/test_operational_paths.mjs tests/test_recovery_safety.mjs tests/test_strategy_evidence.mjs
.venv-clob/bin/python3 tests/test_live_gateway_bridge.py
node --check src/core/research/strategy_screen_storage.mjs src/core/research/external_btc_market_data.mjs src/tools/polymarket_strategy_screen_collector.mjs
bash -n ops/scripts/run_strategy_screen.sh
git diff --check
```

结果：17 个 Node 测试、18 个 Python 测试通过。`package.json` 没有 `npm test`、`npm run lint` 或 `npm run build` 脚本。

## 运行与安全规则

- 只通过 `ops/scripts/*.sh` 进入运行器；不得输出或提交 `.env.live.local`、私钥、CLOB/Relayer 凭据。
- 默认 dry-run/read-only；任何真实下单、取消、claim、资金操作、风险阈值或策略语义改动都需要人类单独批准。
- 一次筛查 run 不可覆盖或延长；要续采使用新的 run ID。跨 run 合并为资格证据前，必须验证哈希、连续性与无重叠。
- VPS 通过本机 SSH 别名 `tencent-vps`（`ubuntu` 用户）访问；不要把主机地址或证书材料写入仓库。

## 未决事项、风险与后续建议

1. **历史数据加速**：先用历史 Polymarket 价格与 OKX 数据淘汰没有领先性/成本后优势的候选；历史价格无法完整重建当时订单簿深度，不能替代当前只读采集的最终可成交性检查。
2. **VPS 验收**：运行结束后先验证 RTDS 重连记录、最大报价滞后、有效比例、连续缺口和 raw 哈希，再生成报告；不要因进程持续运行就认定数据合格。
3. **策略资格**：当前 live runner 的旧短线动量逻辑不是已验证策略。策略证据报告缺失、过期或非合格时必须阻断 live intent。
4. **跨功能影响**：策略证据门禁会影响 live runner 的启动；recovery/claim/资金边界会影响所有 live preflight 与运维流程。改动这些模块时必须回归对应安全测试。
