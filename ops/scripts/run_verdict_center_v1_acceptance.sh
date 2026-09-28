#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GENERATOR="$APP_ROOT/src/ops/generate_run_verdict.mjs"
DASHBOARD_API="$APP_ROOT/src/web/dashboard_api.mjs"
PORT="${RUN_VERDICT_ACCEPTANCE_PORT:-4567}"

if ! command -v node >/dev/null 2>&1; then
  echo "[run-verdict-v1-acceptance] node not found"
  exit 2
fi
if [[ ! -f "$GENERATOR" ]]; then
  echo "[run-verdict-v1-acceptance] missing: $GENERATOR"
  exit 2
fi
if [[ ! -f "$DASHBOARD_API" ]]; then
  echo "[run-verdict-v1-acceptance] missing: $DASHBOARD_API"
  exit 2
fi

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/run-verdict-v1.XXXXXX")"
API_PID=""

cleanup() {
  if [[ -n "${API_PID:-}" ]]; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi
  if [[ -d "$TMP_ROOT" ]]; then
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup EXIT

mkdir -p "$TMP_ROOT/case1/data" "$TMP_ROOT/case2/data"

cat > "$TMP_ROOT/case1/data/live_canary_3m_auto_events.jsonl" <<'JSONL'
{"ts":"2026-03-11T00:00:00Z","type":"RUNNER_START","run_id":"run_case1"}
{"ts":"2026-03-11T00:10:00Z","type":"RUNNER_SUMMARY","orders_count":0,"total_trades":0,"exchange_trades_delta":1,"exchange_cash_delta":-2.95,"real_fill":true,"markets_traded":["m1"]}
JSONL
cat > "$TMP_ROOT/case1/data/recovery_events.jsonl" <<'JSONL'
{"ts":"2026-03-11T00:10:10Z","type":"RECOVERY_STARTED","dry_run":false}
{"ts":"2026-03-11T00:10:20Z","type":"EXPOSURE_SYNC_CLASSIFICATION","managed_by_bot":10,"recovered_from_exchange":0,"unmanaged_historical":0}
{"ts":"2026-03-11T00:10:30Z","type":"RECOVERY_RESUMED","reason":"all_orders_final_and_state_consistent"}
JSONL
cat > "$TMP_ROOT/case1/data/trader_state.json" <<'JSON'
{"mode":"live","halted":false}
JSON

DATA_DIR="$TMP_ROOT/case1/data" node "$GENERATOR" \
  --appRoot "$TMP_ROOT/case1" \
  --summaryPath "$TMP_ROOT/case1/data/last_run_summary.json" \
  --verdictPath "$TMP_ROOT/case1/data/run_verdict.json" \
  --exitCode 0 >/dev/null

cat > "$TMP_ROOT/case2/data/live_canary_3m_auto_events.jsonl" <<'JSONL'
{"ts":"2026-03-11T01:00:00Z","type":"RUNNER_START","run_id":"run_case2"}
{"ts":"2026-03-11T01:10:00Z","type":"RUNNER_SUMMARY","orders_count":1,"total_trades":1,"exchange_trades_delta":1,"exchange_cash_delta":-3.9,"real_fill":true,"markets_traded":["m2"]}
JSONL
cat > "$TMP_ROOT/case2/data/recovery_events.jsonl" <<'JSONL'
{"ts":"2026-03-11T01:10:10Z","type":"RECOVERY_STARTED","dry_run":false}
{"ts":"2026-03-11T01:10:20Z","type":"EXPOSURE_SYNC_CLASSIFICATION","managed_by_bot":25,"recovered_from_exchange":0,"unmanaged_historical":1}
{"ts":"2026-03-11T01:10:21Z","type":"EXPOSURE_SYNC_UNCONFIRMED_HOLDINGS","unconfirmed_count":1,"reason":"unconfirmed_recovered_holdings_exist"}
{"ts":"2026-03-11T01:10:22Z","type":"RECOVERY_FAILED","reason":"unconfirmed_recovered_holdings","action":"SAFE_HALT"}
JSONL
cat > "$TMP_ROOT/case2/data/trader_state.json" <<'JSON'
{"mode":"live","halted":true,"halt_reason":"unconfirmed_recovered_holdings"}
JSON

DATA_DIR="$TMP_ROOT/case2/data" node "$GENERATOR" \
  --appRoot "$TMP_ROOT/case2" \
  --summaryPath "$TMP_ROOT/case2/data/last_run_summary.json" \
  --verdictPath "$TMP_ROOT/case2/data/run_verdict.json" \
  --exitCode 2 >/dev/null

node - "$TMP_ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];

function read(relPath) {
  return JSON.parse(fs.readFileSync(path.join(root, relPath), 'utf8'));
}
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const case1Verdict = read('case1/data/run_verdict.json');
const case1Summary = read('case1/data/last_run_summary.json');
assert(case1Verdict.verdict.real_fill === true, 'case1 real_fill should be true');
assert(
  case1Verdict.verdict.consistency_status === 'DELAYED_BACKFILL',
  'case1 consistency should be DELAYED_BACKFILL'
);
assert(case1Verdict.verdict.action === 'WATCH', 'case1 action should be WATCH');
assert(case1Summary.real_fill === true, 'case1 summary.real_fill should be true');

const case2Verdict = read('case2/data/run_verdict.json');
const case2Summary = read('case2/data/last_run_summary.json');
assert(case2Verdict.verdict.action === 'HALT', 'case2 action should be HALT');
assert(
  case2Verdict.verdict.exposure_match_status === 'MISMATCH',
  'case2 exposure_match_status should be MISMATCH'
);
assert(case2Verdict.reconcile.unconfirmed_count === 1, 'case2 unconfirmed_count should be 1');
assert(case2Summary.post_reconcile_ok === false, 'case2 post_reconcile_ok should be false');

console.log('[run-verdict-v1-acceptance] fixture checks passed');
NODE

FALSE_BIN="$(command -v false || true)"
if [[ -z "$FALSE_BIN" ]]; then
  FALSE_BIN="/usr/bin/false"
fi

DASHBOARD_PORT="$PORT" DATA_DIR="$TMP_ROOT/case1/data" POLY_PYTHON="$FALSE_BIN" \
  node "$DASHBOARD_API" >"$TMP_ROOT/dashboard_api.log" 2>&1 &
API_PID="$!"

for _ in $(seq 1 40); do
  if curl -fsS "http://localhost:${PORT}/api/verdict" >"$TMP_ROOT/api_verdict.json" 2>/dev/null; then
    break
  fi
  sleep 0.2
done
if [[ ! -s "$TMP_ROOT/api_verdict.json" ]]; then
  echo "[run-verdict-v1-acceptance] dashboard api did not become ready"
  cat "$TMP_ROOT/dashboard_api.log" || true
  exit 3
fi

curl -fsS "http://localhost:${PORT}/api/overview" >"$TMP_ROOT/api_overview.json"

node - "$TMP_ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];

const verdict = JSON.parse(fs.readFileSync(path.join(root, 'api_verdict.json'), 'utf8'));
const overview = JSON.parse(fs.readFileSync(path.join(root, 'api_overview.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(verdict.verdict && verdict.verdict.action, 'api verdict should include verdict.action');
assert(
  overview.run_verdict_action === verdict.verdict.action,
  'overview.run_verdict_action should match /api/verdict'
);
assert(
  overview.run_verdict_real_fill === verdict.verdict.real_fill,
  'overview.run_verdict_real_fill should match /api/verdict'
);
assert(
  overview.run_verdict_consistency === verdict.verdict.consistency_status,
  'overview.run_verdict_consistency should match /api/verdict'
);

console.log('[run-verdict-v1-acceptance] api checks passed');
NODE

kill "$API_PID" >/dev/null 2>&1 || true
wait "$API_PID" >/dev/null 2>&1 || true
API_PID=""

echo "[run-verdict-v1-acceptance] PASS"
