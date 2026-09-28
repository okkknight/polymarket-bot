# CHANGELOG

> 仅记录“中大型项目”的关键迭代。
> 每条建议控制在 3-8 行：改动、原因、影响、验证。

## 2026-03-11

### Phase 6 (root cleanup) move remaining app scripts under `src/`
- 根目录业务脚本迁移完成：`runners/`、`core/`、`tools/`、`ops/`、`web/` 分层落位（仅保留元文件与静态页面在根目录）。
- 关键路径更新：`ops/scripts/*.sh` 改为调用 `src/runners/*`、`src/tools/*`、`src/ops/generate_run_verdict.mjs`、`src/web/dashboard_api.mjs`。
- runner 依赖同步：`src/runners/polymarket_paper_trading_realtime.mjs` 改为引用 `../core/*`，fallback replay 路径改为 `src/runners/polymarket_paper_replay_fast.mjs`。
- preflight 目录语义修正：以项目根为 `APP_ROOT`，本地模块检查路径对齐 `src/core/*`。
- 验证：关键入口 `node --check` 通过；`tests/test_pretrade_guard_runtime_state.mjs`、`tests/test_execution_fix.mjs`、`tests/test_convergence.mjs` 全通过；未执行任何实盘下单命令。

### Phase 5 (final cleanup) remove compatibility shims
- 在完成 import cutover 后，删除旧目录下的兼容壳：`execution/*.mjs`、`state/*.mjs`、`risk/*.mjs`。
- 同步修正剩余引用：`drills/polymarket_live_drill.mjs` 改为 `src/core/*` 导入；`polymarket_live_preflight.mjs` 的模块存在性检查路径改为 `src/core/*`。
- 文档同步：`docs/ARCHITECTURE.md` 与 `docs/PROJECT_CONTEXT.md` 的核心模块路径更新为 `src/core/*`。
- 验证：关键入口 `node --check` 通过，3 组测试全通过（pretrade_guard / execution_fix / convergence）。
- 安全说明：未执行任何实盘下单命令。

### Phase 4 (cleanup) import cutover to `src/core/*`
- 将根目录关键入口文件的 import 从旧路径 `./execution|state|risk/*` 切换为 `./src/core/*`（runner/recovery/preflight/dashboard/state tools）。
- 同步将 `tests/*` 的依赖导入切换为 `../src/core/execution/*`，减少对兼容壳依赖。
- 兼容壳仍保留（旧路径可用），用于平滑过渡与回滚兜底。
- 验证：`node --check`（关键入口）通过，3 组测试全通过（pretrade_guard / execution_fix / convergence）。
- 安全说明：未执行任何实盘下单命令。

### Phase 3 (compatible) repo reshaping: core moved to `src/core`
- 将核心模块迁移到 `src/core/`：`execution/*.mjs`、`state/*.mjs`、`risk/*.mjs`。
- 为降低迁移风险，旧路径保留同名兼容壳（re-export），确保现有 import / ops 脚本无需立即改动。
- 保留 `execution/live_gateway_bridge.py` 原位（仅迁移 `.mjs`），避免影响 Python bridge 调用路径。
- 验证：`node --check`（core + runner）通过，`tests/test_pretrade_guard_runtime_state.mjs`、`tests/test_execution_fix.mjs`、`tests/test_convergence.mjs` 全通过。
- 安全说明：未执行任何实盘下单命令。

### Phase 2 (low-risk) repo reshaping: tools moved to `src/tools`
- 将 6 个数据/分析工具脚本从仓库根目录迁移到 `src/tools/`：readonly/finder/tracker/build/replay/metrics。
- 更新 `package.json` 的 `pm:*` 脚本入口到 `src/tools/...`，保持命令名不变（调用方无需改 `npm run pm:*`）。
- 保持 live runner / execution / recovery 主链路位置不变，避免影响实盘编排脚本。
- 文档同步：`docs/PROJECT_CONTEXT.md` 中对应模块路径改为 `src/tools/...`。
- 验证：`node --check` 全部通过，测试 `tests/test_pretrade_guard_runtime_state.mjs` 通过；未执行任何实盘下单命令。

### Architecture docs unified (SYSTEM + PRODUCTION)
- 新增 `docs/ARCHITECTURE.md` 作为统一架构主文档，按 As-Is / To-Be / Gap / Operational Contract 组织。
- 删除 `docs/SYSTEM_ARCHITECTURE.md` 与 `docs/PRODUCTION_ARCHITECTURE.md`，避免双维护导致漂移。
- `docs/PROJECT_CONTEXT.md` 新增“文档分工（快速索引）”说明，明确与架构文档的边界。
- 影响：后续架构更新仅需维护单一文档，结构更清晰、认知负担更低。


### Run Verdict Center V1 (non-invasive)
- 新增 `generate_run_verdict.mjs`：在 run 结束后统一聚合本地事件、交易所事实、post-reconcile 结果。
- `run_live_canary_strict_sync.sh` 改为调用该聚合脚本，产出 `data/run_verdict.json`（覆盖写），并继续写 `data/last_run_summary.json`。
- verdict 规则落地：`real_fill` / `exposure_match_status` / `consistency_status` / `action`，用于运营侧统一判读。
- API 新增 `GET /api/verdict`；`/api/overview` 增加 `run_verdict_action/run_verdict_real_fill/run_verdict_consistency` 轻量字段。
- `dashboard.html` 新增顶部 Run Verdict 卡片，展示 `Real Fill / Exposure Match / Consistency / Suggested Action / ts`。
- 通知模板更新：strict-sync 完成/失败通知附带 `RunVerdict: real_fill=... match=... action=... exit=...`。
- 验证：`bash -n`、`node --check` 全通过；离线 fixture 验收覆盖“交易所有成交但本地无 fill → DELAYED_BACKFILL”和“unconfirmed_recovered_holdings → HALT”。
- 新增离线验收脚本 `ops/scripts/run_verdict_center_v1_acceptance.sh`，可一键回归上述规则并验证 `/api/verdict` 与 `/api/overview` 口径一致。

## 2026-03-10

### Live summary fill truth alignment (local + exchange dual-source)
- `polymarket_paper_trading_realtime.mjs` 最终结论新增交易所口径：`exchange_trades_before/after/delta` 与 `real_fill`。
- `orders_count/total_trades` 改为“本地计数 + 交易所增量提示”融合，避免出现“有实盘成交但 summary=0”的误判。
- 新增 `FINAL_RESULT` 事件，统一输出实盘是否真实成交（`ORDER_FILLED` 或 `exchange_trades_delta>0`）。
- 新增余额异常兜底：当 `exchange_cash_delta` 下降且本地无 fill，触发 `BACKFILL_REQUIRED`，并自动 `BACKFILL_APPLIED` 回补 exposure ledger。
- 验证：`node --check` 通过；`test_execution_fix` 5/5；`test_convergence` 7/7；live dry-run smoke 正常输出新字段。

### Dashboard false-positive connectivity alert hardening
- `dashboard.html` 增加请求超时与刷新并发保护（`refreshInFlight`），避免 5 秒轮询重叠导致接口拥堵。
- 将自动刷新周期由 5s 调整为 10s，降低对 `dashboard_api` 的压力。
- 告警条件改为“仅当 health 明确返回 `exchange_connectivity !== ok` 时触发”，避免 `health` 请求失败时误报 `EXCHANGE_CONNECTIVITY_ERROR`。
- `dashboard_api.mjs` 将 `/api/health` 轻量化（移除重型 `get_positions/get_claimable_markets` 调用），显著降低健康接口延迟与误报概率。

### Position Reconciliation 分页
- `dashboard_api.mjs` 为 `GET /api/positions` 增加可选分页参数：`page`、`pageSize`。
- 带参数时返回 `{ items, page, page_size, total, total_pages }`；不带参数保持兼容，仍返回数组。
- `dashboard.html` 的 Position Reconciliation 面板增加 `Prev/Next` 翻页控件（默认每页 20 条）。

### Run-result push + regression gate (no-LLM polling)
- `ops/scripts/run_live_canary_strict_sync.sh` 新增统一收尾结论：stdout 打印 `FINAL_RESULT {...}`，并落盘 `data/last_run_summary.json`。
- 新增可选通知：macOS 本机通知（`osascript`）与 Telegram 推送（需 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`）。
- 新增 `ops/scripts/run_canary_regression_gate.sh`：基于固定参数执行 strict-sync 并按门禁判定 PASS/FAIL。
- 门禁开关：`REQUIRE_POST_RECONCILE_OK`（默认 true）、`REQUIRE_REAL_FILL`（默认 false）。
- 安全升级：`run_canary_regression_gate.sh` 默认 `LIVE_DRY_RUN=true`，若要触发真实下单必须显式设置 `REGRESSION_ALLOW_LIVE=true`。
- 影响：运营可直接消费机器可读结论，减少“等 LLM 主动汇报”的滞后与限流风险，同时避免误触发实盘交易。

## 2026-03-06

### Docs baseline refresh (reality-aligned)
- 更新 `PROJECT_CONTEXT.md` 与 `SYSTEM_ARCHITECTURE.md` 为“代码现状版”。
- 将内容分层为：已实现 / 进行中 / 待实现，避免把规划项写成已完成。
- 路径统一为 canonical：`apps/polymarket-bot/...`。
- 明确当前阶段：paper/shadow 可稳定迭代，live 前仍需补齐执行与风控闭环。
- 验证：文档内容与当前脚本、输出文件、近期运行结果一致。

### Limit execution Phase 1 scaffold
- 新增 `execution/limit_order_executor.mjs`：OrderIntent、pre-trade guard、幂等 client_order_id、dry-run 提交/回执/成交事件。
- 新增 `state/trade_state_store.mjs`：`trader_state.json` 的加载/保存与 intent 去重键。
- `polymarket_paper_trading_realtime.mjs` 新增 `mode=live` 的 Phase 1 接入（默认 `--liveDryRun=true`）。
- 新增事件：`ORDER_SUBMIT_REQUESTED / ORDER_ACKNOWLEDGED / ORDER_FILLED / ORDER_DUPLICATE_IGNORED / SAFE_HALT_TRIGGERED`。
- 验证：语法检查通过；`--mode live --liveDryRun true` smoke run 正常结束。

### Limit execution Phase 1.5 (reconcile + timeout halt)
- 新增 `reconcileOrderStatus`：订单状态对账检查与 final/non-final 判定。
- runner 在 live 模式下每 tick 对未终态订单做对账检查。
- 新增阈值：`--unresolvedOrderLimitMs`（默认 10000ms），超时触发 `SAFE_HALT_TRIGGERED`。
- 新增事件：`ORDER_RECONCILE_CHECK / ORDER_RECONCILE_TIMEOUT`。
- 验证：语法检查通过；`--mode live --liveDryRun true` smoke run 正常结束。

### Limit execution Phase 2.1 (restart idempotency baseline)
- 状态存储增强：`trade_state_store` 新增默认结构归一化（`intent_index`、`updated_at`）。
- runner 启动时强制落盘 `data/trader_state.json`，确保重启后 dedupe 数据面存在。
- 提交去重从 `intents` 扩展到 `intent_index`，降低重启后重复提交风险。
- `RUNNER_START` 事件新增已恢复 intent/index 计数，提升可观测性。
- 验证：语法检查通过；live dry-run smoke 正常；`trader_state.json` 自动生成。

### Limit execution Phase 2.2 (order state machine + query placeholder)
- `limit_order_executor` 新增订单状态机：`new -> acknowledged -> partial_filled -> final` 及合法迁移校验。
- 新增 `queryOrderStatusFromSource` 占位：dry-run 本地查询 + live API 查询占位事件。
- `reconcileOrderStatus` 接入查询结果与状态迁移；非法迁移会触发异常并可进入安全停机路径。
- live runner 在 reconcile 后回写最新订单状态到 `intents`/`intent_index`。
- 新增事件：`ORDER_STATUS_QUERY_SOURCE / ORDER_STATUS_TRANSITIONED / ORDER_STATUS_TRANSITION_REJECTED`。
- 验证：语法检查通过；live dry-run smoke 正常结束。

### Limit execution Phase 2.3 (halt → reconcile → resume control plane)
- 新增 `execution/recovery_controller.mjs`：标准恢复序列（对账、判定、恢复/阻断）。
- 新增 `polymarket_recovery_control.mjs`：手动恢复入口（`--dryRun` / `--unresolvedOrderLimitMs`）。
- live runner 新增 `--resumeFromHalt`：
  - halted 且未指定 resume 时阻断启动；
  - 指定后先执行恢复序列，成功才进入交易循环。
- 新增事件：`RECOVERY_STARTED / RECOVERY_FAILED / RECOVERY_BLOCKED / RECOVERY_RESUMED / RUNNER_BLOCKED_BY_HALT / RUNNER_RESUME_REJECTED`。
- 验证：语法检查通过；恢复脚本 dry-run 返回 resumed=true；live dry-run smoke 正常结束。

### Limit execution Phase 2.4 (state compaction & archive)
- 新增 `state/state_compaction.mjs`：将 final 状态订单归档到 `data/trader_state_archive.jsonl`，主状态仅保留 open 订单。
- 新增 `polymarket_state_compact.mjs`：手动状态压缩入口（`--keepRecentOpen` / `--archivePath`）。
- live runner 新增周期压缩参数：`--compactEverySec`（默认 300s）、`--keepRecentOpen`（默认 200）。
- 新增事件：`STATE_COMPACTED`。
- 验证：语法检查通过；手动 compact 正常返回；live dry-run smoke 正常结束。

### Network + Power recovery baseline
- 新增 `execution/network_recovery.mjs`：网络失败分类、指数退避、失败阈值安全停机判定。
- live runner 接入网络恢复参数：
  - `--netFailThreshold`（默认 3）
  - `--netBackoffBaseMs`（默认 1000）
  - `--netBackoffMaxMs`（默认 15000）
- 连续失败达到阈值触发 `SAFE_HALT_TRIGGERED(reason=network_instability)`。
- 新增启动脚本：`ops/scripts/start_polymarket_live_recoverable.sh`（断电后可作为统一恢复启动入口）。
- 新增 runbook：`ops/runbooks/POLYMARKET_LAUNCHAGENT_RECOVERY.md`（LaunchAgent 自动拉起指南）。
- 验证：语法检查通过；live dry-run smoke 正常结束。

### Phase 3.0 (live execution adapter wiring + request contract)
- 新增 `execution/live_execution_gateway.mjs`：真实执行网关适配层（submit/query，支持 API key、路径可配置）。
- 新增 `execution/live_config_guard.mjs`：live 配置校验、请求契约校验、错误分类映射。
- `submitLimitIntent` 增加 live 提交通道：`dryRun=false` 时调用 live gateway。
- `reconcileOrderStatus` 增加 live 查询通道：外部状态可驱动内部状态机迁移。
- live runner 已接入 gateway submit/query（保持 `--liveDryRun=true` 为默认安全模式）。
- 验证：语法检查通过；live dry-run smoke 正常结束。

### Phase 3.1 (live risk guardrails baseline)
- 新增 `risk/live_guardrails.mjs`：
  - 单笔名义金额限制（`maxOrderNotional`）
  - 每分钟下单频率限制（`maxOrdersPerMinute`）
  - 日内损失限制（`dailyLossLimit`）
- 新增提交失败冷却（`cooldownSec`）与 `ORDER_SUBMIT_FAILED` 事件。
- 违规时触发 `SAFE_HALT_TRIGGERED`，避免继续交易。

### Phase 3.2 (failure drill baseline)
- 新增演练脚本：`drills/polymarket_live_drill.mjs`
  - 强制 halt -> 执行 recovery -> 输出 drill summary。
- runbook 启动脚本补齐风控参数：`ops/scripts/start_polymarket_live_recoverable.sh`。
- 验证：drill smoke 返回 resumed=true；runner dry-run smoke 正常结束。

### Phase 3.3 (live preflight gate)
- 新增 `polymarket_live_preflight.mjs`：实盘前一键体检（配置 + 本地关键模块 + 就绪结论）。
- 新增 `.env.live.template`：实盘环境变量模板。
- 产出报告：`data/live_preflight_report.json`。
- 当前结论：`live_preflight_blocked`（缺少 `POLY_CLOB_API_KEY`）。

### Phase 3.0-c (auth chain correction)
- 新增 `execution/live_gateway_bridge.py`，通过 `py-clob-client` 执行真实 submit/query（替换简化 Bearer 方案）。
- `live_execution_gateway.mjs` 改为调用 python bridge，接入官方认证链路。
- `live_config_guard` 与 preflight 扩展为强校验：
  - `PRIVATE_KEY`
  - `POLY_CLOB_API_KEY`
  - `POLY_CLOB_API_SECRET`
  - `POLY_CLOB_API_PASSPHRASE`
- 结果：401 问题已从“伪认证链路”定位为“运行时未注入 PRIVATE_KEY”。

### Market fetch resilience patch
- `fetchMarketsBySlug` 增加双路径：
  - 主路径：`/markets?slug=`
  - 备用路径：`/markets?limit=200&active=true` 后本地筛 slug
- 新增 no-market 保护：`maxNoMarketCycles`（默认 12），超限直接退出并给明确原因。
- 新增 last-known-good market 短时复用机制，减少短时源抖动导致的空跑。
- 新增事件：`WATCHER_REUSE_LAST_MARKET` / `RUNNER_EXIT_NO_MARKET`。

## 2026-03-07

### Trading safety hardening (config consistency gates)
- 新增 `risk/runtime_config_guard.mjs`，统一校验 runtime 参数合法性与一致性。
- `polymarket_paper_trading_realtime.mjs` 接入启动期硬门禁：校验失败写入 `CONFIG_VALIDATION_FAILED` 并直接退出（code 2）。
- `ops/scripts/run_live_canary_with_proxy.sh`、`ops/scripts/preflight_strict_live.sh`、`ops/scripts/start_polymarket_live_recoverable.sh` 增加参数冲突阻断。
- recoverable 启动脚本补齐 `--minOrderUsd --minOrderShares --maxPosition` 透传，避免默认值漂移。
- 验证：`node --check` 与 `bash -n` 均通过；runtime guard good/bad smoke case 符合预期（bad case 被正确阻断）。


### Trading safety hardening (config hard-gate + launcher consistency)
- 新增 `risk/runtime_config_guard.mjs`，统一校验 runner 关键参数合法性与可满足性。
- `polymarket_paper_trading_realtime.mjs` 启动前接入强校验：硬冲突直接 `CONFIG_VALIDATION_FAILED` 并阻断运行（退出码 2）。
- `run_live_canary_with_proxy.sh`、`preflight_strict_live.sh`、`start_polymarket_live_recoverable.sh` 新增参数一致性 gate，避免“可预见 no-trade 配置”进入执行阶段。
- `start_polymarket_live_recoverable.sh` 现在显式透传 `--minOrderUsd --minOrderShares --maxPosition`，避免入口脚本与 runner 配置漂移。
- 验证：`node --check` / `bash -n` 全通过；validator 示例检查确认冲突配置会被阻断。

### Recovery hardening for stale non-final orders
- `execution/recovery_controller.mjs` 增加超时未终态订单的防御性强制取消流程（live 模式下先 cancel 再判定失败）。
- 新增恢复事件：`RECOVERY_ORDER_FORCE_CANCELED` / `RECOVERY_CANCEL_FAILED`。
- `polymarket_recovery_control.mjs` 与 runner 的 resume 恢复入口同步接入 `liveGateway.cancelOrder`。
- 影响：降低历史尾单导致的永久 halt 概率；当凭证完整时可自动清理卡住订单。
- 验证：语法检查通过；在无凭证环境下可观测到明确阻断原因（missing_api_key/secret/passphrase/private_key）。

### Python runtime pinning for live scripts
- `preflight_strict_live.sh` 与 `run_live_canary_with_proxy.sh` 新增 `POLY_PYTHON`（默认指向 `.venv-clob/bin/python3`）。
- `execution/live_execution_gateway.mjs` 的 bridge 调用改为优先使用 `POLY_PYTHON`，默认同样指向 `.venv-clob/bin/python3`。
- 影响：避免系统 `python3` 缺少 `py_clob_client` 导致 preflight/canary 偶发失败。
- 验证：`bash -n` 与 `node --check` 全通过；strict preflight 在同配置下可稳定通过。

### Quant prompt update: proactive execution for profit goal
- 更新 `OPENCLAW_QUANT_ENGINEERING_AGENT_SYSTEM_PROMPT.md`：目标改为“在资本保护约束下最大化长期风险调整后收益”。
- 新增 `Proactive Execution Policy`，要求主动推进 backlog，不被动等待任务拆解。
- 变更实施规则改为按风险分级：低/中风险可先做后报；高风险/真金白银行为变更先 checkpoint。
- 影响：强化项目推动力，同时保留实盘安全门禁。

### Live canary guardrail patch (proxy + funds gate + min order)
- `ops/scripts/run_live_canary_with_proxy.sh` 改为参数化风控：支持 `BASE_SIZE`、`MIN_ORDER_USD`、`MAX_ORDER_NOTIONAL`、`DAILY_LOSS_LIMIT` 等环境变量。
- 启动前新增硬门禁：通过 `py-clob-client` 查询 collateral `balance/allowance`，任一为 0 则直接阻断开跑。
- `polymarket_paper_trading_realtime.mjs` 新增 CLI 参数：`--baseSize`、`--minOrderUsd`，并在下单前按价格抬高 qty 以满足最小下单金额约束。
- 影响：减少“明知余额/授权不满足仍开跑”与“因最小下单额被拒”两类无效失败。

### Official proxy/funder mode wiring (Polymarket wallet)
- `execution/live_gateway_bridge.py` 接入官方 `signature_type + funder` 初始化（读取 `POLY_SIGNATURE_TYPE`、`POLY_FUNDER`）。
- `ops/scripts/run_live_canary_with_proxy.sh` 与 `ops/scripts/start_polymarket_live_recoverable.sh` 同步透传上述环境变量。
- canary 门禁检查改为同一认证模式下查询 `get_balance_allowance`，避免“查余额地址与实盘地址不一致”。

### Live status normalization fix (CLOB `live` → internal state)
- 发现 `ORDER_STATUS_TRANSITION_REJECTED`：CLOB 返回 `status=live`，内部状态机不接受 `new -> live`。
- `execution/live_execution_gateway.mjs` 新增状态归一化：`live/open -> acknowledged`，`matched/partial* -> partial_filled`，`cancelled -> canceled`。
- 影响：避免下单已成功却被本地状态机误判为失败并触发 `SAFE_HALT_TRIGGERED`。

### Strict sync mode + risk skip refinement
- 新增 `ops/scripts/run_live_canary_strict_sync.sh`：统一执行 `pre-reconcile -> canary -> post-reconcile`，将交易所状态与本地状态在每轮前后强制对齐。
- `polymarket_paper_trading_realtime.mjs`：`risk_max_order_notional_exceeded` 改为 `RISK_SIGNAL_SKIPPED`（跳过信号，不整轮停机）。
- 状态机修正：`execution/limit_order_executor.mjs` 允许 `new -> partial_filled/filled`，兼容实盘“提交即部分成交”。
- runner 参数增强：新增 `--maxPosition` CLI；`run_live_canary_with_proxy.sh` 支持 `MAX_POSITION` 并透传。
- 对账超时阈值默认上调：`UNRESOLVED_ORDER_LIMIT_MS` / `UNRESOLVED_MS` 由 `10000` 提升至 `60000`，降低 LIVE 挂单误判超时停机。
- 价格边界保护：当盘口极端价触发 `limit_price < 0.01` 或 `> 0.99` 时，runner 与 bridge 双层 clamp 到 `[0.01,0.99]`，并记录 `ORDER_PRICE_CLAMPED` 事件，避免被交易所价格下限拒单。
- 尾仓保护增强：当 `inconsistent_order_state` 超时出现时，runner 先尝试调用 live cancel（`ORDER_CANCEL_REQUESTED/FAILED`），成功则标记 `ORDER_FORCE_CANCELED_AFTER_TIMEOUT` 并继续循环，尽量避免直接停机留下尾仓。
- 约束一致性修正：`minOrderUsd` 约束不再突破 `maxPosition`；新增 `minOrderShares`（默认 5）并支持 CLI/脚本透传。
- 冲突处置策略：当 `minOrderShares/minOrderUsd` 与 `maxPosition` 冲突时，触发 `RISK_SIGNAL_SKIPPED`，不再生成超大 size（如 28.57）导致尾单风险上升。
- 新增 `ops/scripts/preflight_strict_live.sh`：先做资金/授权 gate、市场可达性 gate、liveDryRun 安全回归（阻断 `SAFE_HALT_TRIGGERED/ORDER_RECONCILE_TIMEOUT`），不通过则禁止进入实盘。
- `run_live_canary_strict_sync.sh` 默认接入 strict preflight（`STRICT_PREFLIGHT=true`），实现“先模拟验逻辑，再真金白银执行”。
