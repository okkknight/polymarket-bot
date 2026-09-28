#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$APP_ROOT"

HTTPS_PROXY="${HTTPS_PROXY:-${https_proxy:-}}"
HTTP_PROXY="${HTTP_PROXY:-${http_proxy:-}}"
ALL_PROXY="${ALL_PROXY:-${all_proxy:-}}"
NO_PROXY="${NO_PROXY:-${no_proxy:-localhost,127.0.0.1}}"

exec env RUN_VIA_SH=1 NODE_USE_ENV_PROXY=1 HTTPS_PROXY="$HTTPS_PROXY" HTTP_PROXY="$HTTP_PROXY" ALL_PROXY="$ALL_PROXY" NO_PROXY="$NO_PROXY" \
  node src/tools/polymarket_strategy_screen_collector.mjs "$@"
