#!/usr/bin/env bash
set -euo pipefail

# Regression gate wrapper for strict live canary.
# Keeps trading logic unchanged; only orchestrates run + result checks.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SUMMARY_FILE="$APP_ROOT/data/last_run_summary.json"

# Default baseline params (can override via env)
# Safety default: regression gate runs in dry-run unless explicitly allowed.
: "${ALLOW_DIRECT_CANARY:=true}"
: "${MODE:=live}"
: "${LIVE_DRY_RUN:=true}"
: "${DURATION_SEC:=600}"
: "${SLUG_PREFIX:=btc-updown-5m}"
: "${WATCH_SEC:=30}"
: "${TICK_SEC:=1}"
: "${WINDOW:=3}"
: "${ENTRY_TH:=0.0003}"
: "${GATE:=0.00015}"
: "${BASE_SIZE:=2.1}"
: "${MIN_ORDER_USD:=1}"
: "${MIN_ORDER_SHARES:=5}"
: "${MAX_POSITION:=6}"
: "${SCALE_FACTOR:=0.0003}"
: "${MAX_ORDER_NOTIONAL:=5}"
: "${MAX_ORDERS_PER_MINUTE:=6}"
: "${DAILY_LOSS_LIMIT:=1.5}"
: "${COOLDOWN_SEC:=3600}"
: "${FEE_RATE:=0.001}"
: "${SLIPPAGE_BPS:=1}"
: "${UNRESOLVED_ORDER_LIMIT_MS:=60000}"
: "${VALIDATION_MODE:=true}"
: "${RESUME_FROM_HALT:=true}"

# Gate switches
: "${REQUIRE_POST_RECONCILE_OK:=true}"
: "${REQUIRE_REAL_FILL:=false}"

if [[ "${LIVE_DRY_RUN}" != "true" && "${REGRESSION_ALLOW_LIVE:-false}" != "true" ]]; then
  echo "[regression-gate] BLOCKED: LIVE_DRY_RUN=${LIVE_DRY_RUN}."
  echo "[regression-gate] To run real orders, set REGRESSION_ALLOW_LIVE=true explicitly."
  exit 10
fi

echo "[regression-gate] start strict canary (LIVE_DRY_RUN=${LIVE_DRY_RUN})"
ALLOW_DIRECT_CANARY="$ALLOW_DIRECT_CANARY" \
MODE="$MODE" LIVE_DRY_RUN="$LIVE_DRY_RUN" DURATION_SEC="$DURATION_SEC" \
SLUG_PREFIX="$SLUG_PREFIX" WATCH_SEC="$WATCH_SEC" TICK_SEC="$TICK_SEC" WINDOW="$WINDOW" \
ENTRY_TH="$ENTRY_TH" GATE="$GATE" BASE_SIZE="$BASE_SIZE" MIN_ORDER_USD="$MIN_ORDER_USD" \
MIN_ORDER_SHARES="$MIN_ORDER_SHARES" MAX_POSITION="$MAX_POSITION" SCALE_FACTOR="$SCALE_FACTOR" \
MAX_ORDER_NOTIONAL="$MAX_ORDER_NOTIONAL" MAX_ORDERS_PER_MINUTE="$MAX_ORDERS_PER_MINUTE" \
DAILY_LOSS_LIMIT="$DAILY_LOSS_LIMIT" COOLDOWN_SEC="$COOLDOWN_SEC" FEE_RATE="$FEE_RATE" \
SLIPPAGE_BPS="$SLIPPAGE_BPS" UNRESOLVED_ORDER_LIMIT_MS="$UNRESOLVED_ORDER_LIMIT_MS" \
VALIDATION_MODE="$VALIDATION_MODE" RESUME_FROM_HALT="$RESUME_FROM_HALT" \
bash "$APP_ROOT/ops/scripts/run_live_canary_strict_sync.sh"

if [[ ! -f "$SUMMARY_FILE" ]]; then
  echo "[regression-gate] FAIL: summary file missing: $SUMMARY_FILE"
  exit 2
fi

if [[ "${LIVE_DRY_RUN}" == "true" && "${REQUIRE_REAL_FILL}" == "true" ]]; then
  echo "[regression-gate] WARN: LIVE_DRY_RUN=true, forcing REQUIRE_REAL_FILL=false"
  REQUIRE_REAL_FILL=false
fi

python3 - "$SUMMARY_FILE" "$REQUIRE_POST_RECONCILE_OK" "$REQUIRE_REAL_FILL" <<'PY'
import json,sys
summary_path,req_post,req_fill=sys.argv[1],sys.argv[2].lower()=='true',sys.argv[3].lower()=='true'
with open(summary_path,encoding='utf-8') as f:
    s=json.load(f)

errors=[]
if req_post and not bool(s.get('post_reconcile_ok')):
    errors.append(f"post_reconcile_ok=false reason={s.get('post_reconcile_fail_reason')}")
if req_fill and not bool(s.get('real_fill')):
    errors.append("real_fill=false")

print("[regression-gate] SUMMARY", json.dumps(s, ensure_ascii=False))
if errors:
    print("[regression-gate] FAIL", "; ".join(errors))
    sys.exit(3)
print("[regression-gate] PASS")
PY
