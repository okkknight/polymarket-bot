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

HTTPS_PROXY="${HTTPS_PROXY:-${https_proxy:-}}"
HTTP_PROXY="${HTTP_PROXY:-${http_proxy:-}}"
ALL_PROXY="${ALL_PROXY:-${all_proxy:-}}"
NO_PROXY="${NO_PROXY:-${no_proxy:-localhost,127.0.0.1}}"

DURATION_SEC="${DURATION_SEC:-3600}"
BASE_SIZE="${BASE_SIZE:-1}"
MIN_ORDER_USD="${MIN_ORDER_USD:-1}"
MIN_ORDER_SHARES="${MIN_ORDER_SHARES:-5}"
MAX_POSITION="${MAX_POSITION:-5}"
OUT_PREFIX="${OUT_PREFIX:-shadow_baseline_1h_$(date +%Y%m%d_%H%M%S)}"

OUT_LOG="data/${OUT_PREFIX}_log.csv"
OUT_EVENTS="data/${OUT_PREFIX}_events.jsonl"
OUT_ORDERS="data/${OUT_PREFIX}_orders.csv"

echo "[shadow] proxy on: HTTPS_PROXY=${HTTPS_PROXY:+set} HTTP_PROXY=${HTTP_PROXY:+set} ALL_PROXY=${ALL_PROXY:+set}"
echo "[shadow] params: DURATION_SEC=$DURATION_SEC BASE_SIZE=$BASE_SIZE MIN_ORDER_USD=$MIN_ORDER_USD MIN_ORDER_SHARES=$MIN_ORDER_SHARES MAX_POSITION=$MAX_POSITION"
echo "[shadow] outputs: $OUT_LOG | $OUT_EVENTS | $OUT_ORDERS"
echo "[shadow] note: shadow is independent of strict_sync live canary flow."

# Gate: market source must be reachable before running long shadow.
GATE_OK=0
for i in 1 2 3; do
  echo "[shadow] market source gate attempt $i/3"
  if env RUN_VIA_SH=1 NODE_USE_ENV_PROXY=1 HTTPS_PROXY="$HTTPS_PROXY" HTTP_PROXY="$HTTP_PROXY" ALL_PROXY="$ALL_PROXY" NO_PROXY="$NO_PROXY" \
    node src/tools/polymarket_preflight_market_source.mjs --slugPrefix btc-updown-5m --timeoutMs 10000; then
    GATE_OK=1
    break
  fi
  sleep 2
done

if [[ "$GATE_OK" -ne 1 ]]; then
  echo "[shadow] blocked: market source unreachable after retries"
  exit 2
fi

env RUN_VIA_SH=1 NODE_USE_ENV_PROXY=1 HTTPS_PROXY="$HTTPS_PROXY" HTTP_PROXY="$HTTP_PROXY" ALL_PROXY="$ALL_PROXY" NO_PROXY="$NO_PROXY" \
  node src/runners/polymarket_paper_trading_realtime.mjs \
    --mode shadow --durationSec "$DURATION_SEC" \
    --baseSize "$BASE_SIZE" --minOrderUsd "$MIN_ORDER_USD" --minOrderShares "$MIN_ORDER_SHARES" --maxPosition "$MAX_POSITION" \
    --outLog "$OUT_LOG" --outEvents "$OUT_EVENTS" --outOrders "$OUT_ORDERS"
