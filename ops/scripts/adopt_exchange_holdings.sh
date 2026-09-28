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

if [[ "${ADOPT_EXCHANGE_HOLDINGS_APPROVED:-false}" != "true" || "${ADOPT_EXCHANGE_HOLDINGS_CONFIRM:-}" != "ADOPT_CURRENT_EXCHANGE_HOLDINGS" ]]; then
  echo "[adopt-holdings] blocked: set ADOPT_EXCHANGE_HOLDINGS_APPROVED=true and ADOPT_EXCHANGE_HOLDINGS_CONFIRM=ADOPT_CURRENT_EXCHANGE_HOLDINGS"
  exit 2
fi

cd "$APP_ROOT"
exec env RUN_VIA_SH=1 node src/runners/polymarket_adopt_exchange_holdings.mjs
