#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$APP_ROOT/.env.live.local"
POLY_PYTHON="${POLY_PYTHON:-$APP_ROOT/.venv-clob/bin/python3}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi
if [[ ! -x "$POLY_PYTHON" ]]; then
  echo "[claim-preflight] blocked: POLY_PYTHON is not executable: $POLY_PYTHON"
  exit 2
fi

cd "$APP_ROOT"
result="$("$POLY_PYTHON" execution/live_gateway_bridge.py claim_preflight '{}')"
printf '%s\n' "$result"
CLAIM_PREFLIGHT_RESULT="$result" "$POLY_PYTHON" - <<'PY'
import json, os, sys
result = json.loads(os.environ["CLAIM_PREFLIGHT_RESULT"])
sys.exit(0 if result.get("ok") and result.get("ready") else 2)
PY
