#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$APP_ROOT/.env.live.local"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi
cd "$APP_ROOT"

# Recoverable starter: safe by default (dry-run true unless overridden)
echo "[recoverable] note: this is a low-level launcher. Preferred human entrypoint is ops/scripts/run_live_canary_strict_sync.sh"
MODE="${MODE:-live}"
LIVE_DRY_RUN="${LIVE_DRY_RUN:-true}"
RESUME_FROM_HALT="${RESUME_FROM_HALT:-true}"
DURATION_SEC="${DURATION_SEC:-0}"
UNRESOLVED_ORDER_LIMIT_MS="${UNRESOLVED_ORDER_LIMIT_MS:-${UNRESOLVED_MS:-60000}}"
NET_FAIL_THRESHOLD="${NET_FAIL_THRESHOLD:-3}"
NET_BACKOFF_BASE_MS="${NET_BACKOFF_BASE_MS:-1000}"
NET_BACKOFF_MAX_MS="${NET_BACKOFF_MAX_MS:-15000}"
COMPACT_EVERY_SEC="${COMPACT_EVERY_SEC:-300}"
KEEP_RECENT_OPEN="${KEEP_RECENT_OPEN:-200}"
MAX_ORDER_NOTIONAL="${MAX_ORDER_NOTIONAL:-20}"
MAX_ORDERS_PER_MINUTE="${MAX_ORDERS_PER_MINUTE:-6}"
DAILY_LOSS_LIMIT="${DAILY_LOSS_LIMIT:-20}"
COOLDOWN_SEC="${COOLDOWN_SEC:-30}"
MIN_ORDER_USD="${MIN_ORDER_USD:-1}"
MIN_ORDER_SHARES="${MIN_ORDER_SHARES:-5}"
MAX_POSITION="${MAX_POSITION:-5}"

if [[ "$LIVE_DRY_RUN" != "true" && "${REGRESSION_ALLOW_LIVE:-false}" != "true" ]]; then
  echo "[recoverable] blocked: LIVE_DRY_RUN=$LIVE_DRY_RUN. Set REGRESSION_ALLOW_LIVE=true only after explicit live approval."
  exit 2
fi

# Runtime param consistency gate.
if awk "BEGIN {exit !($MIN_ORDER_SHARES > $MAX_POSITION)}"; then
  echo "[recoverable] blocked: MIN_ORDER_SHARES($MIN_ORDER_SHARES) > MAX_POSITION($MAX_POSITION)"
  exit 2
fi
if awk "BEGIN {exit !(($MIN_ORDER_USD/0.99) > $MAX_POSITION)}"; then
  echo "[recoverable] blocked: MIN_ORDER_USD($MIN_ORDER_USD) is too high for MAX_POSITION($MAX_POSITION)"
  exit 2
fi

# Proxy/VPN env passthrough (set these in the shell before running)
# Examples:
#   export HTTPS_PROXY=http://127.0.0.1:7890
#   export HTTP_PROXY=http://127.0.0.1:7890
#   export ALL_PROXY=socks5://127.0.0.1:7890
#   export NO_PROXY=localhost,127.0.0.1
HTTPS_PROXY="${HTTPS_PROXY:-${https_proxy:-}}"
HTTP_PROXY="${HTTP_PROXY:-${http_proxy:-}}"
ALL_PROXY="${ALL_PROXY:-${all_proxy:-}}"
NO_PROXY="${NO_PROXY:-${no_proxy:-localhost,127.0.0.1}}"

# Official Safe/proxy account defaults must be set before the non-dry funds
# gate, as well as before the runner receives them below.
POLY_SIGNATURE_TYPE="${POLY_SIGNATURE_TYPE:-2}"
POLY_FUNDER="${POLY_FUNDER:-}"

if [[ "$LIVE_DRY_RUN" != "true" ]]; then
  POLY_PYTHON="${POLY_PYTHON:-$APP_ROOT/.venv-clob/bin/python3}"
  env NODE_USE_ENV_PROXY=1 HTTPS_PROXY="$HTTPS_PROXY" HTTP_PROXY="$HTTP_PROXY" ALL_PROXY="$ALL_PROXY" NO_PROXY="$NO_PROXY" POLY_SIGNATURE_TYPE="$POLY_SIGNATURE_TYPE" POLY_FUNDER="$POLY_FUNDER" POLY_PYTHON="$POLY_PYTHON" \
    bash "$APP_ROOT/ops/scripts/check_polymarket_funds.sh" "$MAX_ORDER_NOTIONAL"
fi

exec env \
  RUN_VIA_SH=1 \
  NODE_USE_ENV_PROXY=1 \
  HTTPS_PROXY="$HTTPS_PROXY" \
  HTTP_PROXY="$HTTP_PROXY" \
  ALL_PROXY="$ALL_PROXY" \
  NO_PROXY="$NO_PROXY" \
  POLY_SIGNATURE_TYPE="$POLY_SIGNATURE_TYPE" \
  POLY_FUNDER="$POLY_FUNDER" \
  node src/runners/polymarket_paper_trading_realtime.mjs \
  --mode "$MODE" \
  --liveDryRun "$LIVE_DRY_RUN" \
  --resumeFromHalt "$RESUME_FROM_HALT" \
  --durationSec "$DURATION_SEC" \
  --unresolvedOrderLimitMs "$UNRESOLVED_ORDER_LIMIT_MS" \
  --netFailThreshold "$NET_FAIL_THRESHOLD" \
  --netBackoffBaseMs "$NET_BACKOFF_BASE_MS" \
  --netBackoffMaxMs "$NET_BACKOFF_MAX_MS" \
  --compactEverySec "$COMPACT_EVERY_SEC" \
  --keepRecentOpen "$KEEP_RECENT_OPEN" \
  --maxOrderNotional "$MAX_ORDER_NOTIONAL" \
  --maxOrdersPerMinute "$MAX_ORDERS_PER_MINUTE" \
  --dailyLossLimit "$DAILY_LOSS_LIMIT" \
  --cooldownSec "$COOLDOWN_SEC" \
  --minOrderUsd "$MIN_ORDER_USD" \
  --minOrderShares "$MIN_ORDER_SHARES" \
  --maxPosition "$MAX_POSITION"
