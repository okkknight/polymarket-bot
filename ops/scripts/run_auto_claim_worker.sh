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
  echo "[claim-worker] blocked: POLY_PYTHON is not executable: $POLY_PYTHON"
  exit 2
fi

# A real claim worker must pass the no-submit preflight first. The environment
# defaults still keep it detection-only until both execution switches are set.
if ! bash "$APP_ROOT/ops/scripts/preflight_claim_relayer.sh"; then
  echo "[claim-worker] blocked: claim relayer preflight failed"
  exit 2
fi

echo "[claim-worker] starting: auto_claim=${AUTO_CLAIM_ENABLED:-false} approved=${CLAIM_EXECUTION_APPROVED:-false} interval_ms=${CLAIM_CHECK_INTERVAL_MS:-60000}"
cd "$APP_ROOT"
exec env POLY_PYTHON="$POLY_PYTHON" node src/ops/auto_claim_worker.mjs "$@"
