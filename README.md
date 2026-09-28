# Polymarket Bot

这是一个 Polymarket 自动交易与研究项目，包含行情筛选、纸面运行、实盘执行、恢复对账和风险门禁。代码采用 [MIT 许可证](LICENSE)。

本公开仓库从经过清理的源码快照建立，未包含原私有仓库的 Git 历史、真实钱包地址、密钥或运行数据。实盘账户地址必须由操作者在被 Git 忽略的 `.env.live.local` 中自行设置；示例配置见 [`.env.live.template`](.env.live.template)。不要将账户文件、密钥或交易记录提交到 Git。

## AI Workflow Quick Entry

- Rules & role boundaries: `AGENTS.md`
- Workflow loop (Human/Codex/OpenClaw): `AI_ENGINEERING_WORKFLOW.md`
- Task spec template: `tasks/AAEC-E_TASK_TEMPLATE.md`
- Long-lived project docs: `docs/PROJECT_CONTEXT.md`, `docs/ARCHITECTURE.md`, `docs/CHANGELOG.md`, `docs/ENGINEERING_LOG.md`

## Development Notes

### Recommended Entrypoints (current)

- Live canary (recommended): `bash ops/scripts/run_live_canary_strict_sync.sh`
- Strict preflight only: `bash ops/scripts/preflight_strict_live.sh`
- Bridge deposit route check only: `bash ops/scripts/preflight_polymarket_bridge_deposit.sh`
- Shadow run: `bash ops/scripts/run_shadow_with_proxy.sh`
- Regression gate wrapper: `bash ops/scripts/run_canary_regression_gate.sh`

> Note: legacy `polymarket_paper_trading_live.mjs` was removed to reduce duplicate entry confusion.
>
> Guardrail: core runner/recovery/reset `.mjs` now require `RUN_VIA_SH=1` and are intended to be called from `ops/scripts/*.sh` by default.

### CLOB V2 / pUSD runtime

Live execution uses `py-clob-client-v2` and treats `pUSD` as the only CLOB collateral asset. Install the pinned runtime into the dedicated environment:

```bash
uv pip install --python .venv-clob/bin/python3 -r requirements.live.txt
```

Keep `PRIVATE_KEY`, the three `POLY_CLOB_API_*` values, `POLY_SIGNATURE_TYPE=2`, and `POLY_FUNDER` only in the ignored `.env.live.local`. Use the separate Bridge preflight before manual funding; the strict preflight verifies pUSD balance and allowance. Neither tool transfers, wraps, or approves assets.

### Running in Live Mode

```bash
# Auto-loads .env.live.local at startup
node src/runners/polymarket_paper_trading_realtime.mjs --mode live --liveDryRun false ...
```

### Proxy Configuration

Node.js native `fetch` does NOT respect HTTP_PROXY environment variables.

The project uses native https module with CONNECT tunnel:
- Set `HTTPS_PROXY=http://127.0.0.1:7890` before running
- Proxy is automatically used if env var is set

### Common Issues

| Error | Cause | Fix |
|-------|-------|-----|
| `missing_private_key` | .env not loaded | Ensure `.env.live.local` exists at project root and launcher is started via `ops/scripts/*.sh` |
| `SELECTOR_FETCH_SLUG_ERROR` | Proxy not working | Check HTTPS_PROXY env var |

### Automated end-of-run summary (no-LLM polling)

`run_live_canary_strict_sync.sh` now emits and stores a machine-readable final result without changing trading logic:

- stdout line: `FINAL_RESULT {...}`
- file: `data/last_run_summary.json`
- file: `data/run_verdict.json` (Run Verdict Center V1)

Run Verdict V1 fields are grouped by:

- `local` (run 内事件口径)
- `exchange` (交易所事实口径)
- `reconcile` (post-reconcile 结果)
- `verdict` (`real_fill`, `exposure_match_status`, `consistency_status`, `action`)

Dashboard/API:

- `GET /api/verdict` returns `run_verdict.json`
- `GET /api/overview` includes:
  - `run_verdict_action`
  - `run_verdict_real_fill`
  - `run_verdict_consistency`

Optional notifications:

- macOS local notification via `osascript`
- Telegram push when env vars are set:
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_CHAT_ID`

### Regression gate usage

Run a baseline canary + automatic pass/fail check:

```bash
bash ops/scripts/run_canary_regression_gate.sh
```

Gate switches:

- `REQUIRE_POST_RECONCILE_OK=true|false` (default `true`)
- `REQUIRE_REAL_FILL=true|false` (default `false`)
- `LIVE_DRY_RUN` default is now `true` (safe default)
- To allow real orders in regression gate, **must** set `REGRESSION_ALLOW_LIVE=true` explicitly

### Run Verdict V1 offline acceptance (no live orders)

```bash
bash ops/scripts/run_verdict_center_v1_acceptance.sh
```

What it validates:

- Exchange fill + local no fill -> `real_fill=true`, `consistency=DELAYED_BACKFILL`
- `unconfirmed_recovered_holdings` -> `action=HALT`
- `/api/verdict` and `/api/overview` verdict fields stay consistent
