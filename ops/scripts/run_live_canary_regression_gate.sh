#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SUMMARY_FILE="$APP_ROOT/data/last_run_summary.json"

# Default: same validated canary params
export ALLOW_DIRECT_CANARY="${ALLOW_DIRECT_CANARY:-true}"
export MODE="${MODE:-live}"
export LIVE_DRY_RUN="${LIVE_DRY_RUN:-true}"
export DURATION_SEC="${DURATION_SEC:-600}"
export SLUG_PREFIX="${SLUG_PREFIX:-btc-updown-5m}"
export WATCH_SEC="${WATCH_SEC:-30}"
export TICK_SEC="${TICK_SEC:-1}"
export WINDOW="${WINDOW:-3}"
export ENTRY_TH="${ENTRY_TH:-0.0003}"
export GATE="${GATE:-0.00015}"
export BASE_SIZE="${BASE_SIZE:-2.1}"
export MIN_ORDER_USD="${MIN_ORDER_USD:-1}"
export MIN_ORDER_SHARES="${MIN_ORDER_SHARES:-5}"
export MAX_POSITION="${MAX_POSITION:-6}"
export SCALE_FACTOR="${SCALE_FACTOR:-0.0003}"
export MAX_ORDER_NOTIONAL="${MAX_ORDER_NOTIONAL:-5}"
export MAX_ORDERS_PER_MINUTE="${MAX_ORDERS_PER_MINUTE:-6}"
export DAILY_LOSS_LIMIT="${DAILY_LOSS_LIMIT:-1.5}"
export COOLDOWN_SEC="${COOLDOWN_SEC:-3600}"
export FEE_RATE="${FEE_RATE:-0.001}"
export SLIPPAGE_BPS="${SLIPPAGE_BPS:-1}"
export UNRESOLVED_ORDER_LIMIT_MS="${UNRESOLVED_ORDER_LIMIT_MS:-60000}"
export VALIDATION_MODE="${VALIDATION_MODE:-true}"
export RESUME_FROM_HALT="${RESUME_FROM_HALT:-true}"

# Gate controls
REQUIRE_REAL_FILL="${REQUIRE_REAL_FILL:-false}"
REQUIRE_POST_RECONCILE_OK="${REQUIRE_POST_RECONCILE_OK:-true}"

if [[ "$LIVE_DRY_RUN" != "true" && "${REGRESSION_ALLOW_LIVE:-false}" != "true" ]]; then
  echo "[regression-gate] BLOCKED: LIVE_DRY_RUN=$LIVE_DRY_RUN. Set REGRESSION_ALLOW_LIVE=true only after explicit live approval."
  exit 2
fi

bash "$APP_ROOT/ops/scripts/run_live_canary_strict_sync.sh"

if [[ ! -f "$SUMMARY_FILE" ]]; then
  echo "REGRESSION_RESULT {\"ok\":false,\"reason\":\"missing_summary_file\",\"summary_file\":\"$SUMMARY_FILE\"}"
  exit 2
fi

python3 - "$SUMMARY_FILE" "$REQUIRE_REAL_FILL" "$REQUIRE_POST_RECONCILE_OK" <<'PY'
import json,sys
summary_path,require_fill,require_reconcile=sys.argv[1],sys.argv[2].lower()=='true',sys.argv[3].lower()=='true'
with open(summary_path,encoding='utf-8') as f:
  s=json.load(f)
ok=True
reasons=[]
if s.get('exit_code',1)!=0:
  ok=False; reasons.append('run_exit_nonzero')
if require_fill and not s.get('real_fill',False):
  ok=False; reasons.append('real_fill_missing')
if require_reconcile and not s.get('post_reconcile_ok',False):
  ok=False; reasons.append(f"post_reconcile_failed:{s.get('post_reconcile_fail_reason')}")
result={
  'ok':ok,
  'reasons':reasons,
  'summary':s,
}
print('REGRESSION_RESULT',json.dumps(result,ensure_ascii=False))
if not ok:
  sys.exit(3)
PY
