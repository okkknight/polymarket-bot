#!/usr/bin/env python3
import json
import math
import os
import sys

from py_clob_client_v2.client import ClobClient
from py_clob_client_v2.clob_types import (
    ApiCreds,
    AssetType,
    BalanceAllowanceParams,
    OrderArgs,
    OrderPayload,
    OrderType,
    TradeParams,
)


INITIAL_CURSOR = "MA=="
END_CURSORS = {"lte=", "", "none", "null", "0"}
POLYGON_CHAIN_ID = 137
CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
USDC_E_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
NEG_RISK_ADAPTER_ADDRESS = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"


def resolve_account_owner(environ, funder):
    configured_owner = (environ.get("POLY_ACCOUNT_OWNER") or "").strip().lower()
    normalized_funder = (funder or "").strip().lower()
    # This bot is deliberately configured around one proxy/funder account.  An
    # explicit owner is useful for clarity, but must never point at another
    # account than the one used to sign CLOB requests.
    if configured_owner and normalized_funder and configured_owner != normalized_funder:
        raise ValueError("account_owner_funder_mismatch")
    owner = configured_owner or normalized_funder
    if len(owner) != 42 or not owner.startswith("0x"):
        raise ValueError("missing_or_invalid_account_owner")
    try:
        int(owner[2:], 16)
    except ValueError as exc:
        raise ValueError("missing_or_invalid_account_owner") from exc
    return owner


def fetch_trades_bounded(fetch_page, max_pages=3, cursor=None):
    cursor = cursor or INITIAL_CURSOR
    max_pages = max(1, min(int(max_pages or 1), 50))
    trades = []
    pages_scanned = 0
    seen_cursors = set()
    while pages_scanned < max_pages:
        response = fetch_page(cursor)
        if not isinstance(response, dict):
            raise ValueError("trades_page_invalid")
        page_data = response.get("data") or []
        if not isinstance(page_data, list):
            raise ValueError("trades_page_data_invalid")
        trades.extend(page_data)
        pages_scanned += 1
        next_cursor = str(response.get("next_cursor") or "")
        if next_cursor.lower() in END_CURSORS:
            return {
                "trades": trades,
                "pages_scanned": pages_scanned,
                "next_cursor": None,
                "truncated": False,
            }
        if next_cursor in seen_cursors:
            raise ValueError("trades_cursor_repeated")
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    return {
        "trades": trades,
        "pages_scanned": pages_scanned,
        "next_cursor": cursor,
        "truncated": True,
    }


def fetch_trade_page(client, cursor, account_owner):
    # V2 exposes an authenticated, cursor-based trade-history method. Bind
    # every page to the configured proxy/funder so recovery never infers
    # ownership from credentials or scans unbounded history.
    return client.get_trades_paginated(
        TradeParams(maker_address=account_owner), next_cursor=cursor
    )


def build_positions_from_trades(trades, account_owner):
    positions = {}
    unverified = 0

    def apply_fill(asset, side, size, outcome):
        if not asset:
            return
        try:
            qty = float(size or 0)
        except (TypeError, ValueError):
            qty = 0.0
        if qty <= 0:
            return
        outcome_key = "yes" if "YES" in str(outcome or "").upper() else "no"
        positions.setdefault(str(asset), {"yes": 0.0, "no": 0.0})
        positions[str(asset)][outcome_key] += qty if str(side or "").upper() == "BUY" else -qty

    for trade in trades:
        trader_side = str(trade.get("trader_side", "")).upper()
        if trader_side == "TAKER":
            if str(trade.get("owner") or "").strip().lower() != account_owner:
                unverified += 1
                continue
            apply_fill(trade.get("asset_id") or trade.get("token_id"), trade.get("side"), trade.get("size"), trade.get("outcome"))
            continue
        if trader_side == "MAKER":
            maker_orders = trade.get("maker_orders")
            if not isinstance(maker_orders, list) or not maker_orders:
                unverified += 1
                continue
            matched_owner = False
            for maker_order in maker_orders:
                if not isinstance(maker_order, dict):
                    unverified += 1
                    continue
                if str(maker_order.get("owner") or "").strip().lower() != account_owner:
                    continue
                matched_owner = True
                apply_fill(maker_order.get("asset_id") or maker_order.get("token_id"), maker_order.get("side"), maker_order.get("matched_amount") or maker_order.get("size"), maker_order.get("outcome"))
            if not matched_owner:
                unverified += 1
            continue
        unverified += 1
    return positions, unverified


def build_positions_from_account_positions(rows, account_owner):
    """Convert account-scoped Data API positions without inferring ownership."""
    positions = {}
    unverified = 0
    for row in rows:
        if not isinstance(row, dict):
            unverified += 1
            continue
        if str(row.get("proxyWallet") or "").strip().lower() != account_owner:
            unverified += 1
            continue
        asset = str(row.get("asset") or row.get("asset_id") or "").strip()
        raw_avg_price = row.get("avgPrice", row.get("avg_price"))
        try:
            outcome_index = int(row.get("outcomeIndex"))
        except (TypeError, ValueError):
            outcome_index = -1
        # Outcome labels are market-specific (for example, Up/Down), whereas
        # binary outcome indexes are stable. Reject anything outside the
        # two-token model instead of guessing a ledger sign.
        if raw_avg_price is None or outcome_index not in {0, 1}:
            unverified += 1
            continue
        try:
            size = float(row.get("size") or 0)
            avg_price = float(raw_avg_price)
        except (TypeError, ValueError):
            unverified += 1
            continue
        if not asset or not math.isfinite(size) or not math.isfinite(avg_price) or size < 0 or avg_price < 0:
            unverified += 1
            continue
        outcome_key = "yes" if outcome_index == 0 else "no"
        entry = positions.setdefault(asset, {"yes": 0.0, "no": 0.0, "avg_price": avg_price})
        entry[outcome_key] += size
        entry["avg_price"] = avg_price
    return positions, unverified


def build_claimable_positions_from_account_positions(rows, account_owner):
    """Return only fully verified, account-owned redeemable positions.

    Claim discovery is an asset-moving path.  A malformed or foreign row must
    make the entire response inconclusive rather than be silently omitted and
    interpreted as an empty claim queue.
    """
    claimable = []
    unverified = 0
    for row in rows:
        if not isinstance(row, dict):
            unverified += 1
            continue
        if str(row.get("proxyWallet") or "").strip().lower() != account_owner:
            unverified += 1
            continue
        redeemable = row.get("redeemable")
        if not isinstance(redeemable, bool):
            unverified += 1
            continue
        if not redeemable:
            continue
        condition_id = str(row.get("conditionId") or row.get("condition_id") or "").strip()
        asset_id = str(row.get("asset") or row.get("asset_id") or "").strip()
        try:
            size = float(row.get("size"))
            outcome_index = int(row.get("outcomeIndex"))
            int(condition_id[2:], 16)
            final_price = float(row.get("curPrice"))
            current_value = float(row.get("currentValue"))
        except (TypeError, ValueError):
            unverified += 1
            continue
        negative_risk = row.get("negativeRisk")
        if (
            not condition_id
            or not asset_id
            or len(condition_id) != 66
            or not condition_id.startswith("0x")
            or outcome_index not in {0, 1}
            or not math.isfinite(size)
            or size <= 0
            or not math.isfinite(final_price)
            or final_price < 0
            or final_price > 1
            or not math.isfinite(current_value)
            or current_value < 0
            or not isinstance(negative_risk, bool)
        ):
            unverified += 1
            continue
        # The positions API labels both winning and losing resolved holdings as
        # redeemable. Only a verified winner with positive collateral value can
        # restore usable funds; zero-price holdings must never consume a claim
        # submission or create a durable claim intent.
        if final_price == 0 and current_value == 0:
            continue
        if final_price != 1 or current_value <= 0:
            unverified += 1
            continue
        claimable.append({
            "market_id": condition_id,
            "condition_id": condition_id,
            "asset_id": asset_id,
            "size": size,
            "current_value": current_value,
            "outcome": row.get("outcome"),
            "outcome_index": outcome_index,
            "negative_risk": negative_risk,
            "redeemable": True,
            "question": row.get("title") or row.get("question"),
            "slug": row.get("slug"),
        })
    return claimable, unverified


def fetch_account_positions_bounded(account_owner, max_pages=3, page_limit=100):
    from urllib.parse import urlencode
    from urllib.request import Request, urlopen

    max_pages = max(1, min(int(max_pages or 1), 20))
    page_limit = max(1, min(int(page_limit or 100), 500))
    offset = 0
    rows = []
    pages_scanned = 0
    for _ in range(max_pages):
        pages_scanned += 1
        query = urlencode({"user": account_owner, "limit": page_limit, "offset": offset})
        request = Request(
            f"https://data-api.polymarket.com/positions?{query}",
            headers={"User-Agent": "polymarket-bot/1.0 account-reconciliation"},
        )
        with urlopen(request, timeout=15) as response:
            page_data = json.loads(response.read().decode("utf-8"))
        if not isinstance(page_data, list):
            raise ValueError("positions_response_invalid")
        rows.extend(page_data)
        if len(page_data) < page_limit:
            return {"positions": rows, "pages_scanned": pages_scanned, "truncated": False}
        offset += len(page_data)
    return {"positions": rows, "pages_scanned": pages_scanned, "truncated": True}


def require_claim_relayer_config(environ):
    if int(environ.get("POLY_SIGNATURE_TYPE", "0") or 0) != 2:
        raise ValueError("claim_requires_gnosis_safe_signature_type")
    required = ("POLYMARKET_RELAYER_URL", "POLYMARKET_RELAYER_API_KEY", "POLYMARKET_RELAYER_API_KEY_ADDRESS", "PRIVATE_KEY")
    missing = [name for name in required if not str(environ.get(name, "")).strip()]
    if missing:
        raise ValueError(f"claim_execution_config_missing:{','.join(missing)}")
    from eth_account import Account
    key_address = str(environ["POLYMARKET_RELAYER_API_KEY_ADDRESS"]).strip().lower()
    try:
        int(key_address[2:], 16)
    except (ValueError, IndexError) as exc:
        raise ValueError("claim_relayer_api_key_address_invalid") from exc
    if len(key_address) != 42 or not key_address.startswith("0x"):
        raise ValueError("claim_relayer_api_key_address_invalid")
    signer_address = Account.from_key(environ["PRIVATE_KEY"]).address.lower()
    if key_address != signer_address:
        raise ValueError("claim_relayer_api_key_signer_mismatch")


def require_claim_execution_enabled(environ):
    if str(environ.get("AUTO_CLAIM_ENABLED", "false")).lower() != "true":
        raise ValueError("auto_claim_disabled")
    if str(environ.get("CLAIM_EXECUTION_APPROVED", "false")).lower() != "true":
        raise ValueError("claim_execution_not_approved")
    require_claim_relayer_config(environ)


def _require_condition_id(condition_id):
    raw = str(condition_id or "").strip()
    if len(raw) != 66 or not raw.startswith("0x"):
        raise ValueError("invalid_claim_condition_id")
    try:
        int(raw[2:], 16)
    except ValueError as exc:
        raise ValueError("invalid_claim_condition_id") from exc
    return raw.lower()


def build_claim_calldata(condition_id, outcome_index, amount_micro, negative_risk):
    """Build the official CTF or NegRisk redeemPositions calldata."""
    from eth_abi import encode
    from eth_utils import keccak

    condition_id = _require_condition_id(condition_id)
    if negative_risk:
        try:
            index = int(outcome_index)
            amount = int(amount_micro)
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid_neg_risk_claim_amount") from exc
        if index not in (0, 1) or amount <= 0:
            raise ValueError("invalid_neg_risk_claim_amount")
        selector = keccak(text="redeemPositions(bytes32,uint256[])")[:4]
        amounts = [amount, 0] if index == 0 else [0, amount]
        encoded = encode(["bytes32", "uint256[]"], [bytes.fromhex(condition_id[2:]), amounts])
        return NEG_RISK_ADAPTER_ADDRESS, "0x" + (selector + encoded).hex()

    selector = keccak(text="redeemPositions(address,bytes32,bytes32,uint256[])")[:4]
    encoded = encode(
        ["address", "bytes32", "bytes32", "uint256[]"],
        [USDC_E_ADDRESS, bytes(32), bytes.fromhex(condition_id[2:]), [1, 2]],
    )
    return CTF_ADDRESS, "0x" + (selector + encoded).hex()


def create_relayer_client(environ, funder, require_execution=True):
    from polymarket import ApiKeyCreds, RelayerApiKey, SecureClient

    if require_execution:
        require_claim_execution_enabled(environ)
    else:
        require_claim_relayer_config(environ)
    client = SecureClient.create(
        private_key=environ["PRIVATE_KEY"],
        wallet=str(funder),
        credentials=ApiKeyCreds(
            apiKey=environ["POLY_CLOB_API_KEY"],
            secret=environ["POLY_CLOB_API_SECRET"],
            passphrase=environ["POLY_CLOB_API_PASSPHRASE"],
        ),
        api_key=RelayerApiKey(
            key=environ["POLYMARKET_RELAYER_API_KEY"],
            address=environ["POLYMARKET_RELAYER_API_KEY_ADDRESS"],
        ),
    )
    if str(client.wallet).lower() != str(funder or "").lower():
        client.close()
        raise ValueError("claim_safe_funder_mismatch")
    return client


def relayer_api_headers(environ):
    require_claim_relayer_config(environ)
    return {
        "RELAYER_API_KEY": environ["POLYMARKET_RELAYER_API_KEY"],
        "RELAYER_API_KEY_ADDRESS": environ["POLYMARKET_RELAYER_API_KEY_ADDRESS"],
    }


def verify_relayer_api_auth(environ):
    from urllib.parse import urlencode
    from urllib.request import Request, urlopen

    base = str(environ["POLYMARKET_RELAYER_URL"]).rstrip("/")
    signer = str(environ["POLYMARKET_RELAYER_API_KEY_ADDRESS"])
    query = urlencode({"address": signer, "type": "SAFE"})
    request = Request(
        f"{base}/v1/account/transactions/params?{query}",
        headers={**relayer_api_headers(environ), "User-Agent": "polymarket-bot/1.0 claim-preflight"},
    )
    with urlopen(request, timeout=15) as response:
        result = json.loads(response.read().decode("utf-8"))
    if not isinstance(result, dict):
        raise ValueError("claim_relayer_auth_response_invalid")
    return result


def out(obj):
    print(json.dumps(obj, ensure_ascii=False))


def fail(msg, code=2):
    out({"ok": False, "error": msg})
    sys.exit(code)


def main():
    if len(sys.argv) < 3:
        fail("usage: live_gateway_bridge.py <submit|query> <json>")

    action = sys.argv[1]
    try:
        payload = json.loads(sys.argv[2])
    except Exception as e:
        fail(f"payload_json_invalid:{e}")

    host = os.environ.get("POLY_CLOB_BASE_URL", "https://clob.polymarket.com")
    private_key = os.environ.get("PRIVATE_KEY", "")
    api_key = os.environ.get("POLY_CLOB_API_KEY", "")
    api_secret = os.environ.get("POLY_CLOB_API_SECRET", "")
    api_passphrase = os.environ.get("POLY_CLOB_API_PASSPHRASE", "")

    if not private_key:
        fail("missing_private_key")
    if not (api_key and api_secret and api_passphrase):
        fail("missing_api_credentials")

    signature_type = int(os.environ.get("POLY_SIGNATURE_TYPE", "0") or 0)
    funder = os.environ.get("POLY_FUNDER", "") or None

    client = ClobClient(
        host,
        key=private_key,
        chain_id=137,
        signature_type=signature_type,
        funder=funder,
    )
    client.set_api_creds(ApiCreds(api_key=api_key, api_secret=api_secret, api_passphrase=api_passphrase))

    try:
        if action == "submit":
            intent = payload
            limit_price = float(intent["limit_price"])
            # Exchange constraint: price must be in [0.01, 0.99]
            limit_price = max(0.01, min(0.99, limit_price))

            order = client.create_order(
                OrderArgs(
                    token_id=str(intent["token_id"]),
                    price=limit_price,
                    size=float(intent["size"]),
                    side=str(intent.get("side", "BUY")).upper(),
                    expiration=int(intent["expiration"]),
                )
            )
            posted = client.post_order(order, OrderType.GTD, False)
            order_id = posted.get("orderID") or posted.get("order_id") or posted.get("id")
            status = (posted.get("status") or posted.get("orderStatus") or "acknowledged").lower()
            fill_price = posted.get("price")
            fill_size = posted.get("sizeMatched") or posted.get("size_matched") or posted.get("matched_amount")
            original_size = posted.get("original_size") or posted.get("size")
            out({
                "ok": True,
                "status": status,
                "raw_status": posted.get("status") or posted.get("orderStatus"),
                "order_id": order_id,
                "fill_price": fill_price,
                "fill_size": fill_size,
                "executed_size": fill_size,
                "original_size": original_size,
                "source": "py_clob_client_v2_submit",
                "raw": posted,
            })
            return

        if action == "query":
            order_id = payload.get("order_id")
            if not order_id:
                fail("missing_order_id")
            q = client.get_order(order_id)
            status = (q.get("status") or q.get("orderStatus") or "").lower() or None
            
            # Extract execution fields
            original_size = q.get("original_size")
            size_matched = q.get("size_matched")
            price = q.get("price")
            side = q.get("side", "").upper()
            outcome = q.get("outcome")
            associated_trades = q.get("associate_trades", [])
            
            out({
                "ok": True,
                "status": status,
                "source": "py_clob_client_v2_query",
                "raw_status": q.get("status") or q.get("orderStatus"),
                # Execution fields
                "original_size": original_size,
                "executed_size": size_matched,  # size_matched = actual filled amount
                "fill_price": price,
                "side": side,
                "outcome": outcome,
                "associated_trades": associated_trades,
                "raw": q,
            })
            return
        
        if action == "trades_for_order":
            # Get trades for a specific order
            order_id = payload.get("order_id")
            if not order_id:
                fail("missing_order_id")
            account_owner = resolve_account_owner(os.environ, funder)
            trades_result = fetch_trades_bounded(
                lambda cursor: fetch_trade_page(client, cursor, account_owner),
                max_pages=payload.get("max_pages", 3),
            )
            trades = trades_result["trades"]
            # Filter trades for this order
            order_trades = [t for t in trades if t.get("taker_order_id") == order_id or t.get("orderID") == order_id]
            out({
                "ok": True,
                "trades": order_trades,
                "source": "py_clob_client_v2_get_trades",
                "pages_scanned": trades_result["pages_scanned"],
                "truncated": trades_result["truncated"],
            })
            return
        
        if action == "recent_trades":
            # Get recent trades
            limit = int(payload.get("limit", 50) or 50)
            account_owner = resolve_account_owner(os.environ, funder)
            trades_result = fetch_trades_bounded(
                lambda cursor: fetch_trade_page(client, cursor, account_owner),
                max_pages=payload.get("max_pages", 3),
            )
            trades = trades_result["trades"][:limit]
            out({
                "ok": True,
                "trades": trades,
                "source": "py_clob_client_v2_get_trades",
                "pages_scanned": trades_result["pages_scanned"],
                "truncated": trades_result["truncated"],
            })
            return

        if action == "cancel":
            order_id = payload.get("order_id")
            if not order_id:
                fail("missing_order_id")
            c = client.cancel_order(OrderPayload(orderID=order_id))
            out({
                "ok": True,
                "status": "canceled",
                "source": "py_clob_client_v2_cancel",
                "raw": c,
            })
            return

        if action == "open_orders":
            try:
                orders = client.get_open_orders()
            except Exception as e:
                out({
                    "ok": False,
                    "error": f"get_orders_error:{str(e)}",
                    "orders": [],
                    "source": "py_clob_client_v2_get_open_orders",
                })
                return
            out({
                "ok": True,
                "orders": orders if isinstance(orders, list) else [],
                "source": "py_clob_client_v2_get_open_orders",
            })
            return

        # --- Claim / Resolution Actions ---
        
        if action in ("get_positions", "positions"):
            # Current holdings come from the account-scoped positions endpoint.
            # It reports the proxy wallet on every row, allowing us to verify
            # ownership instead of inferring it from the API credential or a
            # mixed counterparty trade-history response.
            import time
            t0 = time.time()
            account_owner = resolve_account_owner(os.environ, funder)
            positions_result = fetch_account_positions_bounded(
                account_owner,
                max_pages=payload.get("max_pages", os.environ.get("EXPOSURE_SYNC_MAX_POSITION_PAGES", "3")),
                page_limit=payload.get("limit", 100),
            )
            t1 = time.time()
            positions, unverified_positions = build_positions_from_account_positions(
                positions_result["positions"], account_owner
            )
            if positions_result["truncated"] or unverified_positions:
                out({
                    "ok": False,
                    "error": "positions_inconclusive",
                    "positions": positions,
                    "account_owner": account_owner,
                    "pages_scanned": positions_result["pages_scanned"],
                    "truncated": positions_result["truncated"],
                    "unverified_positions": unverified_positions,
                    "source": "polymarket_data_api_account_positions",
                })
                return

            out({
                "ok": True,
                "positions": positions,
                "account_owner": account_owner,
                "pages_scanned": positions_result["pages_scanned"],
                "truncated": False,
                "unverified_positions": 0,
                "source": "polymarket_data_api_account_positions",
                "timing_ms": {
                    "get_positions": int((t1 - t0) * 1000),
                    "total": int((time.time() - t0) * 1000),
                },
                "counts": {
                    "positions_assets": len(positions),
                    "positions": len(positions_result["positions"]),
                },
            })
            return

        if action == "get_markets_status":
            # Get status of specific markets (resolution state)
            market_ids = payload.get("market_ids", [])
            results = []
            
            for market_id in market_ids:
                try:
                    market = client.get_market(market_id)
                    results.append({
                        "market_id": market_id,
                        "closed": market.get("closed", False),
                        "end_date": market.get("endDate"),
                        "end_date_iso": market.get("endDate"),
                        "resolved": market.get("resolved", False),
                        "winner": market.get("winner"),
                        "question": market.get("question"),
                    })
                except Exception as e:
                    results.append({
                        "market_id": market_id,
                        "error": str(e),
                    })
            
            out({
                "ok": True,
                "markets": results,
                "source": "py_clob_client_v2_get_market",
            })
            return

        if action == "get_claimable_markets":
            # Claim candidates must be derived from this account's redeemable
            # positions, never from the global resolved-markets catalogue.
            # A full final page is inconclusive, rather than silently treating
            # an incomplete result as a complete claim set.
            account_owner = resolve_account_owner(os.environ, funder)
            max_pages = max(1, min(int(payload.get("max_pages", 3) or 3), 20))
            page_limit = max(1, min(int(payload.get("limit", 100) or 100), 500))
            try:
                positions_result = fetch_account_positions_bounded(
                    account_owner,
                    max_pages=max_pages,
                    page_limit=page_limit,
                )
            except Exception as e:
                out({
                    "ok": False,
                    "error": f"get_claimable_positions_error: {str(e)}",
                })
                return

            claimable, unverified_positions = build_claimable_positions_from_account_positions(
                positions_result["positions"], account_owner
            )
            if positions_result["truncated"] or unverified_positions:
                out({
                    "ok": False,
                    "error": "claimable_positions_inconclusive",
                    "account_owner": account_owner,
                    "pages_scanned": positions_result["pages_scanned"],
                    "truncated": positions_result["truncated"],
                    "unverified_positions": unverified_positions,
                })
                return

            out({
                "ok": True,
                "claimable_markets": claimable,
                "account_owner": account_owner,
                "pages_scanned": positions_result["pages_scanned"],
                "truncated": False,
                "unverified_positions": 0,
                "source": "polymarket_data_api_account_positions",
            })
            return

        if action == "claim_submit":
            try:
                account_owner = resolve_account_owner(os.environ, funder)
                if account_owner != str(funder or "").lower():
                    raise ValueError("claim_account_owner_funder_mismatch")
                relayer = create_relayer_client(os.environ, funder)
                try:
                    response = relayer.redeem_positions(
                        condition_id=_require_condition_id(payload.get("condition_id") or payload.get("market_id")),
                        metadata="polymarket-bot redeem positions",
                    )
                finally:
                    relayer.close()
                out({
                    "ok": True,
                    "transaction_id": response.transaction_id,
                    "transaction_hash": response.transaction_hash,
                    "state": "STATE_NEW",
                    "account_owner": account_owner,
                    "condition_id": payload.get("condition_id") or payload.get("market_id"),
                    "source": "polymarket_client_relayer_api_key",
                })
            except Exception as e:
                out({"ok": False, "error": f"claim_submit_error:{str(e)}", "source": "polymarket_client_relayer_api_key"})
            return

        if action == "claim_preflight":
            try:
                account_owner = resolve_account_owner(os.environ, funder)
                verify_relayer_api_auth(os.environ)
                out({
                    "ok": True,
                    "ready": True,
                    "account_owner": account_owner,
                    "relayer_api_key_address": os.environ["POLYMARKET_RELAYER_API_KEY_ADDRESS"],
                    "signature_type": int(os.environ.get("POLY_SIGNATURE_TYPE", "0") or 0),
                    "source": "polymarket_client_relayer_api_key",
                })
            except Exception as e:
                out({"ok": False, "ready": False, "error": f"claim_preflight_error:{str(e)}", "source": "polymarket_client_relayer_api_key"})
            return

        if action == "claim_status":
            try:
                transaction_id = str(payload.get("transaction_id") or "").strip()
                if not transaction_id:
                    raise ValueError("missing_claim_transaction_id")
                from urllib.request import Request, urlopen
                base = str(os.environ["POLYMARKET_RELAYER_URL"]).rstrip("/")
                request = Request(
                    f"{base}/v1/account/transactions/{transaction_id}",
                    headers={**relayer_api_headers(os.environ), "User-Agent": "polymarket-bot/1.0 claim-reconciliation"},
                )
                with urlopen(request, timeout=15) as response:
                    transaction = json.loads(response.read().decode("utf-8"))
                if not isinstance(transaction, dict):
                    raise ValueError("claim_transaction_not_found")
                out({
                    "ok": True,
                    "transaction_id": transaction_id,
                    "state": transaction.get("state"),
                    "transaction_hash": transaction.get("transaction_hash") or transaction.get("transactionHash"),
                    "error": transaction.get("error_msg") or transaction.get("errorMsg"),
                    "source": "polymarket_client_relayer_api_key",
                })
            except Exception as e:
                out({"ok": False, "error": f"claim_status_error:{str(e)}", "source": "polymarket_client_relayer_api_key"})
            return

        # --- Health & Balance Actions ---

        if action == "health":
            # Simple health check - can we reach the API?
            try:
                # Try to get server time as health check
                client.get_server_time()
                out({
                    "ok": True,
                    "status": "ok",
                    "source": "py_clob_client_v2_health",
                })
            except Exception as e:
                out({
                    "ok": False,
                    "status": "error",
                    "error": str(e),
                    "source": "py_clob_client_v2_health",
                })
            return

        if action == "balance":
            # Get collateral balance
            try:
                bal = client.get_balance_allowance(BalanceAllowanceParams(asset_type=AssetType.COLLATERAL, signature_type=signature_type))
                out({
                    "ok": True,
                    "balance": bal.get("balance", "0"),
                    "allowances": bal.get("allowances") or {},
                    "collateral_asset": "pUSD",
                    "account_owner": resolve_account_owner(os.environ, funder),
                    "source": "py_clob_client_v2_get_balance_allowance",
                })
            except Exception as e:
                out({
                    "ok": False,
                    "error": str(e),
                    "source": "py_clob_client_v2_get_balance_allowance",
                })
            return

        fail(f"unknown_action:{action}")
    except Exception as e:
        fail(f"bridge_exception:{e}", code=3)


if __name__ == "__main__":
    main()
