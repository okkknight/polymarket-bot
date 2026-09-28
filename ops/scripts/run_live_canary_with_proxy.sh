#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
POLY_PYTHON="${POLY_PYTHON:-$APP_ROOT/.venv-clob/bin/python3}"
ENV_FILE="$APP_ROOT/.env.live.local"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi
cd "$APP_ROOT"

if [[ ! -x "$POLY_PYTHON" ]]; then
  echo "[canary] blocked: POLY_PYTHON is not executable: $POLY_PYTHON"
  exit 2
fi

# Required secrets should already be exported in current shell:
# PRIVATE_KEY, POLY_CLOB_API_KEY, POLY_CLOB_API_SECRET, POLY_CLOB_API_PASSPHRASE

# Optional proxy env:
HTTPS_PROXY="${HTTPS_PROXY:-${https_proxy:-}}"
HTTP_PROXY="${HTTP_PROXY:-${http_proxy:-}}"
ALL_PROXY="${ALL_PROXY:-${all_proxy:-}}"
NO_PROXY="${NO_PROXY:-${no_proxy:-localhost,127.0.0.1}}"

BASE_SIZE="${BASE_SIZE:-2.1}"
MIN_ORDER_USD="${MIN_ORDER_USD:-1.0}"
MAX_ORDER_NOTIONAL="${MAX_ORDER_NOTIONAL:-1.2}"
MAX_ORDERS_PER_MINUTE="${MAX_ORDERS_PER_MINUTE:-1}"
DAILY_LOSS_LIMIT="${DAILY_LOSS_LIMIT:-1.5}"
COOLDOWN_SEC="${COOLDOWN_SEC:-120}"
DURATION_SEC="${DURATION_SEC:-180}"
MAX_POSITION="${MAX_POSITION:-5}"
MIN_ORDER_SHARES="${MIN_ORDER_SHARES:-5}"
UNRESOLVED_ORDER_LIMIT_MS="${UNRESOLVED_ORDER_LIMIT_MS:-${UNRESOLVED_MS:-60000}}"
POLY_SIGNATURE_TYPE="${POLY_SIGNATURE_TYPE:-2}"
POLY_FUNDER="${POLY_FUNDER:-}"
VALIDATION_MODE="${VALIDATION_MODE:-false}"
LIVE_DRY_RUN="${LIVE_DRY_RUN:-true}"

echo "[canary] proxy: HTTPS_PROXY=${HTTPS_PROXY:+set} HTTP_PROXY=${HTTP_PROXY:+set} ALL_PROXY=${ALL_PROXY:+set}"
echo "[canary] risk: BASE_SIZE=$BASE_SIZE MIN_ORDER_USD=$MIN_ORDER_USD MIN_ORDER_SHARES=$MIN_ORDER_SHARES MAX_ORDER_NOTIONAL=$MAX_ORDER_NOTIONAL MAX_ORDERS_PER_MINUTE=$MAX_ORDERS_PER_MINUTE DAILY_LOSS_LIMIT=$DAILY_LOSS_LIMIT COOLDOWN_SEC=$COOLDOWN_SEC DURATION_SEC=$DURATION_SEC MAX_POSITION=$MAX_POSITION UNRESOLVED_ORDER_LIMIT_MS=$UNRESOLVED_ORDER_LIMIT_MS"
echo "[canary] auth: POLY_SIGNATURE_TYPE=$POLY_SIGNATURE_TYPE POLY_FUNDER=$POLY_FUNDER"
echo "[canary] validation: VALIDATION_MODE=$VALIDATION_MODE"
echo "[canary] execution: LIVE_DRY_RUN=$LIVE_DRY_RUN"
echo "[canary] note: preferred entrypoint is ops/scripts/run_live_canary_strict_sync.sh (this script is kept as a compatibility shortcut)."
if [[ "${ALLOW_DIRECT_CANARY:-false}" != "true" ]]; then
  echo "[canary] blocked: direct canary entry disabled by default. Use ops/scripts/run_live_canary_strict_sync.sh or set ALLOW_DIRECT_CANARY=true."
  exit 2
fi
if [[ "$LIVE_DRY_RUN" != "true" && "${REGRESSION_ALLOW_LIVE:-false}" != "true" ]]; then
  echo "[canary] blocked: LIVE_DRY_RUN=$LIVE_DRY_RUN. Set REGRESSION_ALLOW_LIVE=true only after explicit live approval."
  exit 2
fi

# Hard gate: parameter consistency (prevent no-trade / unsafe runtime config).
if awk "BEGIN {exit !($MIN_ORDER_SHARES > $MAX_POSITION)}"; then
  echo "[canary] blocked: MIN_ORDER_SHARES($MIN_ORDER_SHARES) > MAX_POSITION($MAX_POSITION)"
  exit 2
fi
if awk "BEGIN {exit !(($MIN_ORDER_USD/0.99) > $MAX_POSITION)}"; then
  echo "[canary] blocked: MIN_ORDER_USD($MIN_ORDER_USD) is too high for MAX_POSITION($MAX_POSITION)"
  exit 2
fi

# Hard gate: require enough collateral balance and allowance for one permitted
# order. Values returned by the CLOB balance endpoint are USDC micro-units.
# Retry a few times because proxy/network can flap.
GATE_OK=0
for i in 1 2 3; do
  echo "[canary] funds gate attempt $i/3"
  if env NODE_USE_ENV_PROXY=1 HTTPS_PROXY="$HTTPS_PROXY" HTTP_PROXY="$HTTP_PROXY" ALL_PROXY="$ALL_PROXY" NO_PROXY="$NO_PROXY" POLY_SIGNATURE_TYPE="$POLY_SIGNATURE_TYPE" POLY_FUNDER="$POLY_FUNDER" POLY_PYTHON="$POLY_PYTHON" \
    bash "$APP_ROOT/ops/scripts/check_polymarket_funds.sh" "$MAX_ORDER_NOTIONAL"; then
    GATE_OK=1
    break
  fi
  sleep 2
done

if [[ "$GATE_OK" -ne 1 ]]; then
  echo "[canary] blocked: funds gate failed after retries (network/proxy or insufficient balance/allowance for MAX_ORDER_NOTIONAL=$MAX_ORDER_NOTIONAL)."
  exit 2
fi

env RUN_VIA_SH=1 NODE_USE_ENV_PROXY=1 HTTPS_PROXY="$HTTPS_PROXY" HTTP_PROXY="$HTTP_PROXY" ALL_PROXY="$ALL_PROXY" NO_PROXY="$NO_PROXY" \
  node src/runners/polymarket_state_reset_for_canary.mjs

env RUN_VIA_SH=1 NODE_USE_ENV_PROXY=1 HTTPS_PROXY="$HTTPS_PROXY" HTTP_PROXY="$HTTP_PROXY" ALL_PROXY="$ALL_PROXY" NO_PROXY="$NO_PROXY" \
  node src/tools/polymarket_preflight_market_source.mjs --slugPrefix btc-updown-5m --timeoutMs 10000

env RUN_VIA_SH=1 NODE_USE_ENV_PROXY=1 HTTPS_PROXY="$HTTPS_PROXY" HTTP_PROXY="$HTTP_PROXY" ALL_PROXY="$ALL_PROXY" NO_PROXY="$NO_PROXY" POLY_SIGNATURE_TYPE="$POLY_SIGNATURE_TYPE" POLY_FUNDER="$POLY_FUNDER" \
  node src/runners/polymarket_paper_trading_realtime.mjs \
    --mode live --liveDryRun "$LIVE_DRY_RUN" --resumeFromHalt true --validationMode "$VALIDATION_MODE" --durationSec "$DURATION_SEC" \
    --maxOrderNotional "$MAX_ORDER_NOTIONAL" --maxOrdersPerMinute "$MAX_ORDERS_PER_MINUTE" --dailyLossLimit "$DAILY_LOSS_LIMIT" --cooldownSec "$COOLDOWN_SEC" \
    --netFailThreshold 3 --unresolvedOrderLimitMs "$UNRESOLVED_ORDER_LIMIT_MS" --maxNoMarketCycles 6 \
    --compactEverySec 120 --keepRecentOpen 100 --baseSize "$BASE_SIZE" --minOrderUsd "$MIN_ORDER_USD" --minOrderShares "$MIN_ORDER_SHARES" --maxPosition "$MAX_POSITION" \
    --outLog data/live_canary_3m_auto_log.csv --outEvents data/live_canary_3m_auto_events.jsonl
