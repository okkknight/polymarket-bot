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
UNRESOLVED_ORDER_LIMIT_MS="${UNRESOLVED_ORDER_LIMIT_MS:-${UNRESOLVED_MS:-60000}}"

# keep same proxy defaults as other launchers
HTTPS_PROXY="${HTTPS_PROXY:-${https_proxy:-}}"
HTTP_PROXY="${HTTP_PROXY:-${http_proxy:-}}"
ALL_PROXY="${ALL_PROXY:-${all_proxy:-}}"
NO_PROXY="${NO_PROXY:-${no_proxy:-localhost,127.0.0.1}}"

STRICT_PREFLIGHT="${STRICT_PREFLIGHT:-true}"
LIVE_DRY_RUN="${LIVE_DRY_RUN:-true}"
RECOVERY_DRY_RUN="${RECOVERY_DRY_RUN:-true}"
SUMMARY_FILE="$APP_ROOT/data/last_run_summary.json"
VERDICT_FILE="$APP_ROOT/data/run_verdict.json"

if [[ "$LIVE_DRY_RUN" != "true" && "${REGRESSION_ALLOW_LIVE:-false}" != "true" ]]; then
  echo "[strict-sync] blocked: LIVE_DRY_RUN=$LIVE_DRY_RUN. Set REGRESSION_ALLOW_LIVE=true only after explicit live approval."
  exit 2
fi
if [[ "$RECOVERY_DRY_RUN" != "true" && "${RECOVERY_ALLOW_LIVE:-false}" != "true" ]]; then
  echo "[strict-sync] blocked: RECOVERY_DRY_RUN=$RECOVERY_DRY_RUN. Set RECOVERY_ALLOW_LIVE=true only after explicit live approval."
  exit 2
fi

emit_final_summary() {
  local exit_code="$1"
  node "$APP_ROOT/src/ops/generate_run_verdict.mjs" \
    --appRoot "$APP_ROOT" \
    --summaryPath "$SUMMARY_FILE" \
    --verdictPath "$VERDICT_FILE" \
    --exitCode "$exit_code"
}

notify_local() {
  local title="$1"
  local body="$2"
  local safe_title="${title//\"/\\\"}"
  local safe_body="${body//\"/\\\"}"
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$safe_body\" with title \"$safe_title\"" >/dev/null 2>&1 || true
  fi
}

notify_telegram() {
  local text="$1"
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; then
    curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=${text}" >/dev/null 2>&1 || true
  fi
}

if [[ "$STRICT_PREFLIGHT" == "true" ]]; then
  echo "[strict-sync] strict preflight start"
  cd "$APP_ROOT"
  HTTPS_PROXY="$HTTPS_PROXY" HTTP_PROXY="$HTTP_PROXY" ALL_PROXY="$ALL_PROXY" NO_PROXY="$NO_PROXY" \
  UNRESOLVED_ORDER_LIMIT_MS="$UNRESOLVED_ORDER_LIMIT_MS" VALIDATION_MODE="${VALIDATION_MODE:-false}" \
  MAX_ORDER_NOTIONAL="${MAX_ORDER_NOTIONAL:-1.2}" MAX_ORDERS_PER_MINUTE="${MAX_ORDERS_PER_MINUTE:-1}" DAILY_LOSS_LIMIT="${DAILY_LOSS_LIMIT:-1.5}" COOLDOWN_SEC="${COOLDOWN_SEC:-120}" \
  BASE_SIZE="${BASE_SIZE:-2.1}" MIN_ORDER_USD="${MIN_ORDER_USD:-1.0}" MIN_ORDER_SHARES="${MIN_ORDER_SHARES:-5}" MAX_POSITION="${MAX_POSITION:-5}" \
  POLY_SIGNATURE_TYPE="${POLY_SIGNATURE_TYPE:-2}" POLY_FUNDER="${POLY_FUNDER:-}" \
  bash "$APP_ROOT/ops/scripts/preflight_strict_live.sh"
fi

echo "[strict-sync] pre-reconcile start (UNRESOLVED_ORDER_LIMIT_MS=$UNRESOLVED_ORDER_LIMIT_MS)"
cd "$APP_ROOT"
env RUN_VIA_SH=1 NODE_USE_ENV_PROXY=1 HTTPS_PROXY="$HTTPS_PROXY" HTTP_PROXY="$HTTP_PROXY" ALL_PROXY="$ALL_PROXY" NO_PROXY="$NO_PROXY" \
  node src/runners/polymarket_recovery_control.mjs --dryRun "$RECOVERY_DRY_RUN" --readOnly "$RECOVERY_DRY_RUN" --unresolvedOrderLimitMs "$UNRESOLVED_ORDER_LIMIT_MS"

echo "[strict-sync] run canary"
set +e
cd "$APP_ROOT"
HTTPS_PROXY="$HTTPS_PROXY" HTTP_PROXY="$HTTP_PROXY" ALL_PROXY="$ALL_PROXY" NO_PROXY="$NO_PROXY" \
  ALLOW_DIRECT_CANARY=true LIVE_DRY_RUN="$LIVE_DRY_RUN" REGRESSION_ALLOW_LIVE="${REGRESSION_ALLOW_LIVE:-false}" \
  bash "$APP_ROOT/ops/scripts/run_live_canary_with_proxy.sh"
RUN_EXIT=$?
set -e

echo "[strict-sync] post-reconcile start"
cd "$APP_ROOT"
env RUN_VIA_SH=1 NODE_USE_ENV_PROXY=1 HTTPS_PROXY="$HTTPS_PROXY" HTTP_PROXY="$HTTP_PROXY" ALL_PROXY="$ALL_PROXY" NO_PROXY="$NO_PROXY" \
  node src/runners/polymarket_recovery_control.mjs --dryRun "$RECOVERY_DRY_RUN" --readOnly "$RECOVERY_DRY_RUN" --unresolvedOrderLimitMs "$UNRESOLVED_ORDER_LIMIT_MS"

if [[ "$RUN_EXIT" -ne 0 ]]; then
  echo "[strict-sync] canary failed with exit=$RUN_EXIT (post-reconcile done)"
  emit_final_summary "$RUN_EXIT" || true
  verdict_line="$(python3 - "$VERDICT_FILE" <<'PY'
import json,sys
path=sys.argv[1]
try:
  d=json.load(open(path,encoding='utf-8'))
  v=d.get('verdict',{})
  print(f"RunVerdict: real_fill={v.get('real_fill')} match={v.get('exposure_match_status')} action={v.get('action')} exit={d.get('exit_code')}")
except Exception:
  print("RunVerdict: unavailable")
PY
)"
  notify_local "Polymarket canary" "failed (exit=$RUN_EXIT) ${verdict_line}"
  notify_telegram "Polymarket canary failed (exit=$RUN_EXIT). ${verdict_line}. See ${SUMMARY_FILE}"
  exit "$RUN_EXIT"
fi

echo "[strict-sync] done"
emit_final_summary 0 || true
verdict_line="$(python3 - "$VERDICT_FILE" <<'PY'
import json,sys
path=sys.argv[1]
try:
  d=json.load(open(path,encoding='utf-8'))
  v=d.get('verdict',{})
  print(f"RunVerdict: real_fill={v.get('real_fill')} match={v.get('exposure_match_status')} action={v.get('action')} exit={d.get('exit_code')}")
except Exception:
  print("RunVerdict: unavailable")
PY
)"
notify_local "Polymarket canary" "completed ${verdict_line}"
notify_telegram "Polymarket canary completed. ${verdict_line}. See ${SUMMARY_FILE}"
