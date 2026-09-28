#!/usr/bin/env bash
set -euo pipefail

# Read-only pUSD balance/allowance guard. The V2 CLOB bridge reports collateral
# in micro-units, so the caller supplies a human-facing USD notional.
REQUIRED_ORDER_NOTIONAL="${1:?usage: check_polymarket_funds.sh <required-order-notional-usdc>}"
POLY_PYTHON="${POLY_PYTHON:?POLY_PYTHON must be set}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ ! -x "$POLY_PYTHON" ]]; then
  echo "[funds-gate] blocked: POLY_PYTHON is not executable: $POLY_PYTHON"
  exit 2
fi

balance_json="$(cd "$APP_ROOT" && "$POLY_PYTHON" execution/live_gateway_bridge.py balance '{}')"

env REQUIRED_ORDER_NOTIONAL="$REQUIRED_ORDER_NOTIONAL" BALANCE_JSON="$balance_json" "$POLY_PYTHON" - <<'PY'
import json, os, sys

required = int(float(os.environ.get("REQUIRED_ORDER_NOTIONAL", "0")) * 1_000_000)
result = json.loads(os.environ["BALANCE_JSON"])
if not result.get("ok") or result.get("collateral_asset") != "pUSD":
    print(json.dumps({
        "check": "collateral_balance_allowance",
        "ok": False,
        "required_micro_usdc": required,
        "balance": None,
        "allowance_sufficient": False,
        "reason": result.get("error") or "v2_pusd_balance_unavailable",
    }, ensure_ascii=False))
    sys.exit(2)

balance = int(float(result.get("balance", 0) or 0))
allowances = [int(float(value or 0)) for value in (result.get("allowances") or {}).values()]
allowance_sufficient = any(value >= required for value in allowances)
ok = required > 0 and balance >= required and allowance_sufficient
print(json.dumps({
    "check": "collateral_balance_allowance",
    "ok": ok,
    "required_micro_usdc": required,
    "balance": result.get("balance"),
    "collateral_asset": result.get("collateral_asset"),
    "allowance_sufficient": allowance_sufficient,
    "reason": None if ok else "insufficient_balance_or_allowance",
}, ensure_ascii=False))
sys.exit(0 if ok else 2)
PY
