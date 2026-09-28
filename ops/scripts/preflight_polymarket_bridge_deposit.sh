#!/usr/bin/env bash
set -euo pipefail

# Read-only preflight for the Bridge deposit route tied to the bot Safe. It
# obtains an address and asset metadata only; it never submits a token action.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$APP_ROOT/.env.live.local"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${POLY_FUNDER:-}" ]]; then
  echo '{"check":"bridge_deposit_preflight","ok":false,"reason":"missing_poly_funder"}'
  exit 2
fi

if ! deposit_json="$(curl --fail-with-body --silent --show-error --connect-timeout 5 --max-time 20 \
  -H 'content-type: application/json' \
  --data "{\"address\":\"$POLY_FUNDER\"}" \
  https://bridge.polymarket.com/deposit)"; then
  echo '{"check":"bridge_deposit_preflight","ok":false,"reason":"bridge_deposit_address_unavailable"}'
  exit 2
fi

if ! assets_json="$(curl --fail-with-body --silent --show-error --connect-timeout 5 --max-time 20 \
  https://bridge.polymarket.com/supported-assets)"; then
  echo '{"check":"bridge_deposit_preflight","ok":false,"reason":"bridge_supported_assets_unavailable"}'
  exit 2
fi

DEPOSIT_JSON="$deposit_json" ASSETS_JSON="$assets_json" POLY_FUNDER="$POLY_FUNDER" python3 - <<'PY'
import json
import os
import sys

try:
    deposit = json.loads(os.environ["DEPOSIT_JSON"])
    supported = json.loads(os.environ["ASSETS_JSON"])
except json.JSONDecodeError:
    print(json.dumps({"check": "bridge_deposit_preflight", "ok": False, "reason": "bridge_response_invalid"}))
    sys.exit(2)

addresses = deposit.get("addresses") or deposit.get("depositAddresses") or deposit
evm = None
if isinstance(addresses, dict):
    evm = addresses.get("evm") or addresses.get("EVM")
if isinstance(evm, dict):
    evm = evm.get("address")
if not isinstance(evm, str) or not evm.startswith("0x") or len(evm) != 42:
    print(json.dumps({"check": "bridge_deposit_preflight", "ok": False, "reason": "bridge_evm_address_missing"}))
    sys.exit(2)

assets = supported.get("supportedAssets") or supported.get("assets") or []
polygon_usdc = []
for item in assets:
    if not isinstance(item, dict):
        continue
    token = item.get("token") or {}
    chain = str(item.get("chainName") or item.get("chain") or "").lower()
    if chain == "polygon" and str(token.get("symbol") or "").upper() == "USDC":
        polygon_usdc.append({
            "token_address": token.get("address"),
            "min_checkout_usd": item.get("minCheckoutUsd"),
        })
if not polygon_usdc:
    print(json.dumps({"check": "bridge_deposit_preflight", "ok": False, "reason": "polygon_usdc_unsupported"}))
    sys.exit(2)

print(json.dumps({
    "check": "bridge_deposit_preflight",
    "ok": True,
    "target_wallet": os.environ["POLY_FUNDER"].lower(),
    "evm_deposit_address": evm.lower(),
    "polygon_usdc_options": polygon_usdc,
    "collateral_asset": "pUSD",
}, separators=(",", ":")))
PY
