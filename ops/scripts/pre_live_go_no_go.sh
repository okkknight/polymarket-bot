#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3456/api/health}"

failures=()

note_fail() {
  failures+=("$1")
  echo "[NO-GO] $1"
}

resolve_events_file() {
  local pointer="$APP_ROOT/data/current_events_path.txt"
  local fallback="$APP_ROOT/data/events.jsonl"
  local path="$fallback"
  if [[ -f "$pointer" ]]; then
    local raw
    raw="$(tr -d '\r' < "$pointer" | head -n 1 | xargs)"
    if [[ -n "$raw" ]]; then
      if [[ "$raw" = /* ]]; then
        path="$raw"
      else
        path="$APP_ROOT/$raw"
      fi
    fi
  fi
  echo "$path"
}

events_file="$(resolve_events_file)"
start_lines=0
if [[ -f "$events_file" ]]; then
  start_lines="$(wc -l < "$events_file" | tr -d ' ')"
fi

echo "[go-no-go] Using events file: $events_file"

cd "$APP_ROOT"

echo "[go-no-go] 1) strict preflight"
if ! bash "$APP_ROOT/ops/scripts/preflight_strict_live.sh"; then
  note_fail "preflight_strict_live.sh failed"
fi

echo "[go-no-go] 2) regression tests"
cd "$APP_ROOT"
if ! node --test tests/test_convergence.mjs; then
  note_fail "tests/test_convergence.mjs failed"
fi
if ! node --test tests/test_execution_fix.mjs; then
  note_fail "tests/test_execution_fix.mjs failed"
fi

echo "[go-no-go] 3) syntax checks"
if ! node --check src/runners/polymarket_paper_trading_realtime.mjs; then
  note_fail "node --check src/runners/polymarket_paper_trading_realtime.mjs failed"
fi
if ! node --check src/core/execution/recovery_controller.mjs; then
  note_fail "node --check src/core/execution/recovery_controller.mjs failed"
fi
if ! python3 -m py_compile execution/live_gateway_bridge.py; then
  note_fail "python3 -m py_compile execution/live_gateway_bridge.py failed"
fi

echo "[go-no-go] 4) recovery surface"
recovery_json="$(RUN_VIA_SH=1 node src/runners/polymarket_recovery_control.mjs --dryRun true --readOnly true 2>/dev/null || true)"
if [[ -z "$recovery_json" ]]; then
  note_fail "recovery command produced no JSON output"
else
  ok_val="$(python3 - <<'PY' "$recovery_json"
import json,sys
try:
  j=json.loads(sys.argv[1])
  print('true' if j.get('ok') is True else 'false')
except Exception:
  print('false')
PY
)"
  halted_val="$(python3 - <<'PY' "$recovery_json"
import json,sys
try:
  j=json.loads(sys.argv[1])
  print('true' if j.get('halted') is True else 'false')
except Exception:
  print('true')
PY
)"
  if [[ "$ok_val" != "true" || "$halted_val" != "false" ]]; then
    note_fail "recovery dry-run check failed (expect ok:true halted:false)"
  fi
fi

echo "[go-no-go] 5) trader_state gate"
state_json="$APP_ROOT/data/trader_state.json"
if [[ ! -f "$state_json" ]]; then
  note_fail "trader_state.json missing"
else
  if ! python3 - <<'PY' "$state_json"
import json,sys
j=json.load(open(sys.argv[1]))
ok=(j.get('halted') is False and (j.get('halt_reason') in (None,'', 'null')))
raise SystemExit(0 if ok else 1)
PY
  then
    note_fail "trader_state gate failed (halted must be false and halt_reason null)"
  fi
fi

echo "[go-no-go] 6) /api/health gate"
health_json="$(curl -fsS "$HEALTH_URL" 2>/dev/null || true)"
if [[ -z "$health_json" ]]; then
  note_fail "cannot fetch $HEALTH_URL"
else
  if ! python3 - <<'PY' "$health_json"
import json,sys
j=json.loads(sys.argv[1])
exp_unconfirmed=j.get('exposure_unconfirmed_count', j.get('exposure_unmanaged_count'))
ok=(
  j.get('exchange_connectivity')=='ok' and
  int(j.get('mismatch_count',999))==0 and
  int(j.get('unresolved_orders',999))==0 and
  int(exp_unconfirmed if exp_unconfirmed is not None else 999)==0
)
raise SystemExit(0 if ok else 1)
PY
  then
    note_fail "/api/health gate failed (connectivity/mismatch/unresolved/exposure)"
  fi
fi

echo "[go-no-go] 7) new critical events gate"
end_lines=0
if [[ -f "$events_file" ]]; then
  end_lines="$(wc -l < "$events_file" | tr -d ' ')"
fi
if [[ "$end_lines" -gt "$start_lines" && -f "$events_file" ]]; then
  new_events="$(tail -n $((end_lines-start_lines)) "$events_file" 2>/dev/null || true)"
  if echo "$new_events" | grep -E '"type":"(SAFE_HALT_TRIGGERED|ORDER_RECONCILE_TIMEOUT|ORDER_LIFECYCLE_STUCK)"' >/dev/null; then
    note_fail "new critical events detected in stream"
  fi
fi

if [[ ${#failures[@]} -eq 0 ]]; then
  echo "GO"
  exit 0
fi

echo "NO-GO"
printf ' - %s\n' "${failures[@]}"
exit 2
