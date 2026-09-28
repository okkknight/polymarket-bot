import importlib.util
import pathlib
import unittest


BRIDGE_PATH = pathlib.Path(__file__).resolve().parents[1] / "execution" / "live_gateway_bridge.py"
SPEC = importlib.util.spec_from_file_location("live_gateway_bridge", BRIDGE_PATH)
BRIDGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BRIDGE)


class LiveGatewayBridgeTests(unittest.TestCase):
    def test_live_bridge_uses_clob_v2_client_only(self):
        source = BRIDGE_PATH.read_text()
        self.assertIn("py_clob_client_v2", source)
        self.assertNotIn("from py_clob_client.", source)

    def test_balance_identifies_v2_pusd_collateral(self):
        source = BRIDGE_PATH.read_text()
        self.assertIn('"collateral_asset": "pUSD"', source)
        self.assertIn('"source": "py_clob_client_v2_get_balance_allowance"', source)

    def test_bridge_does_not_use_unbounded_trade_history_helper(self):
        self.assertNotIn("client.get_trades()", BRIDGE_PATH.read_text())

    def test_trades_for_order_is_scoped_to_the_configured_account_owner(self):
        source = BRIDGE_PATH.read_text()
        block = source.split('if action == "trades_for_order":', 1)[1].split('if action == "recent_trades":', 1)[0]
        self.assertIn("account_owner = resolve_account_owner(os.environ, funder)", block)
        self.assertIn("fetch_trade_page(client, cursor, account_owner)", block)

    def test_claim_candidates_are_account_scoped_redeemable_positions(self):
        source = BRIDGE_PATH.read_text()
        self.assertIn("data-api.polymarket.com/positions", source)
        self.assertIn("User-Agent", source)
        self.assertIn("build_claimable_positions_from_account_positions", source)
        self.assertIn("claimable_positions_inconclusive", source)
        self.assertNotIn("client.get_markets", source)

    def test_claim_calldata_uses_correct_standard_and_neg_risk_contracts(self):
        condition_id = "0x" + "12" * 32
        ctf_target, ctf_data = BRIDGE.build_claim_calldata(condition_id, None, 0, False)
        self.assertEqual(ctf_target.lower(), BRIDGE.CTF_ADDRESS.lower())
        self.assertTrue(ctf_data.startswith("0x01b7037c"))

        nr_target, nr_data = BRIDGE.build_claim_calldata(condition_id, 1, 2_500_000, True)
        self.assertEqual(nr_target.lower(), BRIDGE.NEG_RISK_ADAPTER_ADDRESS.lower())
        self.assertTrue(nr_data.startswith("0xdbeccb23"))
        self.assertTrue(nr_data.endswith(f"{2_500_000:064x}"))

        with self.assertRaises(ValueError):
            BRIDGE.build_claim_calldata(condition_id, 2, 1, True)

    def test_claim_execution_requires_two_explicit_gates_and_relayer_api_config(self):
        with self.assertRaisesRegex(ValueError, "auto_claim_disabled"):
            BRIDGE.require_claim_execution_enabled({})
        with self.assertRaisesRegex(ValueError, "claim_execution_not_approved"):
            BRIDGE.require_claim_execution_enabled({"AUTO_CLAIM_ENABLED": "true"})
        with self.assertRaisesRegex(ValueError, "POLYMARKET_RELAYER_API_KEY"):
            BRIDGE.require_claim_execution_enabled({
                "AUTO_CLAIM_ENABLED": "true",
                "CLAIM_EXECUTION_APPROVED": "true",
                "POLY_SIGNATURE_TYPE": "2",
            })

    def test_claim_relayer_preflight_needs_relayer_api_config_but_not_execution_gates(self):
        with self.assertRaisesRegex(ValueError, "claim_requires_gnosis_safe_signature_type"):
            BRIDGE.require_claim_relayer_config({})
        with self.assertRaisesRegex(ValueError, "claim_execution_config_missing"):
            BRIDGE.require_claim_relayer_config({"POLY_SIGNATURE_TYPE": "2"})

    def test_claim_relayer_rejects_key_address_not_owned_by_signer(self):
        with self.assertRaisesRegex(ValueError, "claim_relayer_api_key_signer_mismatch"):
            BRIDGE.require_claim_relayer_config({
                "POLY_SIGNATURE_TYPE": "2",
                "POLYMARKET_RELAYER_URL": "https://relayer.example",
                "POLYMARKET_RELAYER_API_KEY": "test-key",
                "POLYMARKET_RELAYER_API_KEY_ADDRESS": "0x1111000000000000000000000000000000000000",
                "PRIVATE_KEY": "0x" + "01" * 32,
            })

    def test_account_owner_requires_the_configured_funder(self):
        self.assertEqual(
            BRIDGE.resolve_account_owner({"POLY_ACCOUNT_OWNER": "0x1111000000000000000000000000000000000000"}, "0x1111000000000000000000000000000000000000"),
            "0x1111000000000000000000000000000000000000",
        )
        self.assertEqual(
            BRIDGE.resolve_account_owner({}, "0x1111000000000000000000000000000000000000"),
            "0x1111000000000000000000000000000000000000",
        )
        with self.assertRaises(ValueError):
            BRIDGE.resolve_account_owner({}, None)
        with self.assertRaises(ValueError):
            BRIDGE.resolve_account_owner({"POLY_ACCOUNT_OWNER": "0xAbCd000000000000000000000000000000000000"}, "0x1111000000000000000000000000000000000000")

    def test_bounded_trade_paging_reports_truncation(self):
        pages = {
            "MA==": {"data": [{"id": "one"}], "next_cursor": "cursor-2"},
            "cursor-2": {"data": [{"id": "two"}], "next_cursor": "cursor-3"},
        }

        result = BRIDGE.fetch_trades_bounded(lambda cursor: pages[cursor], max_pages=2)

        self.assertEqual([trade["id"] for trade in result["trades"]], ["one", "two"])
        self.assertEqual(result["pages_scanned"], 2)
        self.assertTrue(result["truncated"])
        self.assertEqual(result["next_cursor"], "cursor-3")

    def test_bounded_trade_paging_stops_at_clob_terminal_cursor(self):
        calls = []

        result = BRIDGE.fetch_trades_bounded(
            lambda cursor: calls.append(cursor) or {"data": [{"id": "one"}], "next_cursor": "LTE="},
            max_pages=3,
        )

        self.assertEqual(calls, ["MA=="])
        self.assertFalse(result["truncated"])
        self.assertIsNone(result["next_cursor"])

    def test_positions_require_matching_configured_owner(self):
        owner = "0x1111000000000000000000000000000000000000"
        positions, unverified = BRIDGE.build_positions_from_trades([
            {"trader_side": "TAKER", "owner": owner, "asset_id": "yes-token", "side": "BUY", "size": "3", "outcome": "YES"},
            {"trader_side": "MAKER", "maker_orders": [
                {"owner": owner, "asset_id": "no-token", "side": "BUY", "matched_amount": "2", "outcome": "NO"},
                {"owner": "0x2222000000000000000000000000000000000000", "asset_id": "yes-token", "side": "BUY", "matched_amount": "99", "outcome": "YES"},
            ]},
            {"trader_side": "TAKER", "asset_id": "yes-token", "side": "BUY", "size": "7", "outcome": "YES"},
        ], owner)

        self.assertEqual(positions["yes-token"]["yes"], 3.0)
        self.assertEqual(positions["no-token"]["no"], 2.0)
        self.assertEqual(unverified, 1)

    def test_maker_trade_without_matching_owner_is_inconclusive(self):
        owner = "0x1111000000000000000000000000000000000000"
        for trade in (
            {"trader_side": "MAKER", "maker_orders": []},
            {"trader_side": "MAKER", "maker_orders": [{"owner": "0x2222000000000000000000000000000000000000"}]},
            {"trader_side": "MAKER", "maker_orders": "missing"},
        ):
            _, unverified = BRIDGE.build_positions_from_trades([trade], owner)
            self.assertGreater(unverified, 0)

    def test_account_positions_require_matching_proxy_wallet(self):
        owner = "0x1111000000000000000000000000000000000000"
        positions, unverified = BRIDGE.build_positions_from_account_positions([
            {"proxyWallet": owner, "asset": "yes-token", "size": "3", "avgPrice": "0.42", "outcome": "Up", "outcomeIndex": 0},
            {"proxyWallet": "0x2222000000000000000000000000000000000000", "asset": "no-token", "size": "2", "avgPrice": "0.58", "outcome": "Down", "outcomeIndex": 1},
        ], owner)

        self.assertEqual(positions["yes-token"]["yes"], 3.0)
        self.assertEqual(positions["yes-token"]["avg_price"], 0.42)
        self.assertNotIn("no-token", positions)
        self.assertEqual(unverified, 1)

    def test_account_positions_reject_unknown_outcome_index_and_missing_price(self):
        owner = "0x1111000000000000000000000000000000000000"
        positions, unverified = BRIDGE.build_positions_from_account_positions([
            {"proxyWallet": owner, "asset": "unknown-outcome", "size": "1", "avgPrice": "0.5", "outcome": "MAYBE", "outcomeIndex": 2},
            {"proxyWallet": owner, "asset": "missing-price", "size": "1", "outcome": "YES", "outcomeIndex": 0},
        ], owner)

        self.assertEqual(positions, {})
        self.assertEqual(unverified, 2)

    def test_claim_candidates_require_verified_redeemable_account_positions(self):
        owner = "0x1111000000000000000000000000000000000000"
        condition = "0x" + "12" * 32
        claimable, unverified = BRIDGE.build_claimable_positions_from_account_positions([
            {"proxyWallet": owner, "redeemable": True, "conditionId": condition, "asset": "yes-token", "size": "3", "outcome": "Winner", "outcomeIndex": 0, "curPrice": "1", "currentValue": "3", "negativeRisk": False},
            {"proxyWallet": "0x2222000000000000000000000000000000000000", "redeemable": True, "conditionId": condition, "asset": "foreign-token", "size": "1", "outcomeIndex": 0},
            {"proxyWallet": owner, "redeemable": "true", "conditionId": condition, "asset": "malformed-token", "size": "1", "outcomeIndex": 0},
            {"proxyWallet": owner, "redeemable": True, "conditionId": condition, "asset": "bad-outcome", "size": "1", "outcomeIndex": 2},
            {"proxyWallet": owner, "redeemable": True, "conditionId": "0x" + "zz" * 32, "asset": "bad-condition", "size": "1", "outcomeIndex": 0, "negativeRisk": False},
            {"proxyWallet": owner, "redeemable": True, "conditionId": condition, "asset": "bad-neg-risk", "size": "1", "outcomeIndex": 0, "negativeRisk": "false"},
        ], owner)

        self.assertEqual([entry["asset_id"] for entry in claimable], ["yes-token"])
        self.assertEqual(unverified, 5)

    def test_claim_candidates_require_positive_final_payout_evidence(self):
        owner = "0x1111000000000000000000000000000000000000"
        condition = "0x" + "34" * 32
        claimable, unverified = BRIDGE.build_claimable_positions_from_account_positions([
            {"proxyWallet": owner, "redeemable": True, "conditionId": condition, "asset": "winner", "size": "3", "outcomeIndex": 0, "curPrice": "1", "currentValue": "3", "negativeRisk": False},
            {"proxyWallet": owner, "redeemable": True, "conditionId": condition, "asset": "loser", "size": "4", "outcomeIndex": 1, "curPrice": "0", "currentValue": "0", "negativeRisk": False},
            {"proxyWallet": owner, "redeemable": True, "conditionId": condition, "asset": "zero-price-positive-value", "size": "4", "outcomeIndex": 1, "curPrice": "0", "currentValue": "3", "negativeRisk": False},
            {"proxyWallet": owner, "redeemable": True, "conditionId": condition, "asset": "partial-price-zero-value", "size": "4", "outcomeIndex": 1, "curPrice": "0.5", "currentValue": "0", "negativeRisk": False},
        ], owner)

        self.assertEqual([entry["asset_id"] for entry in claimable], ["winner"])
        self.assertEqual(unverified, 2)


if __name__ == "__main__":
    unittest.main()
