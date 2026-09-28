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

HTTPS_PROXY="${HTTPS_PROXY:-${https_proxy:-}}"
HTTP_PROXY="${HTTP_PROXY:-${http_proxy:-}}"
ALL_PROXY="${ALL_PROXY:-${all_proxy:-}}"
NO_PROXY="${NO_PROXY:-${no_proxy:-localhost,127.0.0.1}}"

POLY_SIGNATURE_TYPE="${POLY_SIGNATURE_TYPE:-2}"
POLY_FUNDER="${POLY_FUNDER:-}"

MAX_ORDER_NOTIONAL="${MAX_ORDER_NOTIONAL:-1.2}"
MAX_ORDERS_PER_MINUTE="${MAX_ORDERS_PER_MINUTE:-1}"
DAILY_LOSS_LIMIT="${DAILY_LOSS_LIMIT:-1.2}"
COOLDOWN_SEC="${COOLDOWN_SEC:-180}"
BASE_SIZE="${BASE_SIZE:-5}"
MIN_ORDER_USD="${MIN_ORDER_USD:-1.0}"
MIN_ORDER_SHARES="${MIN_ORDER_SHARES:-5}"
MAX_POSITION="${MAX_POSITION:-5}"
UNRESOLVED_ORDER_LIMIT_MS="${UNRESOLVED_ORDER_LIMIT_MS:-${UNRESOLVED_MS:-60000}}"
DRYRUN_DURATION_SEC="${DRYRUN_DURATION_SEC:-120}"

OUT_EVENTS="$APP_ROOT/data/live_preflight_dryrun_events.jsonl"
OUT_LOG="$APP_ROOT/data/live_preflight_dryrun_log.csv"

echo "[preflight-strict] start"
echo "[preflight-strict] note: for full run flow, use ops/scripts/run_live_canary_strict_sync.sh"

# 0-) Runtime param consistency gate.
if awk "BEGIN {exit !($MIN_ORDER_SHARES > $MAX_POSITION)}"; then
  echo "[preflight-strict] blocked: MIN_ORDER_SHARES($MIN_ORDER_SHARES) > MAX_POSITION($MAX_POSITION)"
  exit 2
fi
if awk "BEGIN {exit !(($MIN_ORDER_USD/0.99) > $MAX_POSITION)}"; then
  echo "[preflight-strict] blocked: MIN_ORDER_USD($MIN_ORDER_USD) is too high for MAX_POSITION($MAX_POSITION)"
  exit 2
fi

cd "$APP_ROOT"

if [[ ! -x "$POLY_PYTHON" ]]; then
  echo "[preflight-strict] blocked: POLY_PYTHON is not executable: $POLY_PYTHON"
  exit 2
fi

# 0) Read-only pre-reconcile first. Strict preflight must never mutate exchange state.
env RUN_VIA_SH=1 NODE_USE_ENV_PROXY=1 HTTPS_PROXY="$HTTPS_PROXY" HTTP_PROXY="$HTTP_PROXY" ALL_PROXY="$ALL_PROXY" NO_PROXY="$NO_PROXY" POLY_SIGNATURE_TYPE="$POLY_SIGNATURE_TYPE" POLY_FUNDER="$POLY_FUNDER" \
  node src/runners/polymarket_recovery_control.mjs --dryRun true --readOnly true --unresolvedOrderLimitMs "$UNRESOLVED_ORDER_LIMIT_MS"

# 1) pUSD funds/allowance gate under same auth mode. Bridge deposit metadata
# is a separate manual-funding check, so a temporary Bridge outage cannot
# block an already-funded Safe from completing its trading safety preflight.
env NODE_USE_ENV_PROXY=1 HTTPS_PROXY="$HTTPS_PROXY" HTTP_PROXY="$HTTP_PROXY" ALL_PROXY="$ALL_PROXY" NO_PROXY="$NO_PROXY" POLY_SIGNATURE_TYPE="$POLY_SIGNATURE_TYPE" POLY_FUNDER="$POLY_FUNDER" POLY_PYTHON="$POLY_PYTHON" \
  bash "$APP_ROOT/ops/scripts/check_polymarket_funds.sh" "$MAX_ORDER_NOTIONAL"

# 2) Market source gate.
env NODE_USE_ENV_PROXY=1 HTTPS_PROXY="$HTTPS_PROXY" HTTP_PROXY="$HTTP_PROXY" ALL_PROXY="$ALL_PROXY" NO_PROXY="$NO_PROXY" \
  node src/tools/polymarket_preflight_market_source.mjs --slugPrefix btc-updown-5m --timeoutMs 10000

# 3) Dry-run live flow test (must not place real orders).
env RUN_VIA_SH=1 NODE_USE_ENV_PROXY=1 HTTPS_PROXY="$HTTPS_PROXY" HTTP_PROXY="$HTTP_PROXY" ALL_PROXY="$ALL_PROXY" NO_PROXY="$NO_PROXY" POLY_SIGNATURE_TYPE="$POLY_SIGNATURE_TYPE" POLY_FUNDER="$POLY_FUNDER" \
  node src/runners/polymarket_paper_trading_realtime.mjs \
    --mode live --liveDryRun true --resumeFromHalt true --durationSec "$DRYRUN_DURATION_SEC" \
    --maxOrderNotional "$MAX_ORDER_NOTIONAL" --maxOrdersPerMinute "$MAX_ORDERS_PER_MINUTE" --dailyLossLimit "$DAILY_LOSS_LIMIT" --cooldownSec "$COOLDOWN_SEC" \
    --unresolvedOrderLimitMs "$UNRESOLVED_ORDER_LIMIT_MS" --maxNoMarketCycles 6 \
    --compactEverySec 120 --keepRecentOpen 100 \
    --baseSize "$BASE_SIZE" --minOrderUsd "$MIN_ORDER_USD" --minOrderShares "$MIN_ORDER_SHARES" --maxPosition "$MAX_POSITION" \
    --outLog "$OUT_LOG" --outEvents "$OUT_EVENTS"

# 4) Validate dry-run events for safety regressions.
OUT_EVENTS_PATH="$OUT_EVENTS" "$POLY_PYTHON" - <<'PY'
import json,sys,os
p=os.environ.get('OUT_EVENTS_PATH','')
if not os.path.exists(p):
  print('[preflight-strict] fail: missing dryrun events file')
  sys.exit(2)

bad_types={'ORDER_SUBMIT_FAILED','ORDER_RECONCILE_TIMEOUT','SAFE_HALT_TRIGGERED','ORDER_CANCEL_FAILED'}
bad=[]
with open(p,'r',encoding='utf-8') as f:
  for line in f:
    line=line.strip()
    if not line:
      continue
    try:
      j=json.loads(line)
    except Exception:
      continue
    t=j.get('type')
    if t in bad_types:
      bad.append(j)

if bad:
  print('[preflight-strict] fail: dryrun has blocking events')
  for x in bad[-5:]:
    print(json.dumps({'type':x.get('type'),'reason':x.get('reason'),'err':x.get('err'),'market_id':x.get('market_id')}, ensure_ascii=False))
  sys.exit(2)

print('[preflight-strict] pass: dryrun checks clean')
PY

echo "[preflight-strict] passed"
