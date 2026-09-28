# CLOB V2 and pUSD Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the live bridge from legacy CLOB V1/USDC.e assumptions to CLOB V2/pUSD, while preserving dry-run defaults and preventing live order submission until explicit approval.

**Architecture:** Keep Node callers and the durable recovery ledger stable. Replace the Python bridge's V1 client adapter with a V2 adapter behind the same JSON actions (`submit`, `query`, `cancel`, `open_orders`, `balance`, `health`), then make pUSD the only collateral truth used by the funds gate. Validate every external response shape before using it in recovery or risk checks.

**Tech Stack:** Node.js ESM, Python 3.11, `py-clob-client-v2`, `polymarket-client`, Polygon Data API, Polymarket Bridge API.

**Spec:** `tasks/TASK_20260824_live_safety_completion.md`; official CLOB V2 migration guide.

## Global Constraints

- Do not change strategy logic, market selection, order sizing, or risk thresholds.
- Do not submit a live order, cancel a live order, transfer funds, wrap collateral, or change allowance during implementation.
- Remove legacy `py-clob-client` from the live runtime; do not keep a V1 fallback capable of production submission.
- Use pUSD for collateral checks. A missing/unknown V2 balance or allowance must block the run.
- Keep existing `trader_state.json` schema compatible; migration state may be logged only in existing event/state extension fields.
- Every behavior change starts with a failing focused test.

---

### Task 1: Lock the V2 runtime contract

**Files:**
- Modify: `requirements.live.txt`
- Modify: `execution/live_gateway_bridge.py`
- Modify: `tests/test_live_gateway_bridge.py`

**Interfaces:**
- Produces: `create_clob_v2_client(environ) -> ClobClientV2` and a bridge source string `py_clob_client_v2_*`.
- Consumes: existing CLOB L2 credentials, `PRIVATE_KEY`, `POLY_SIGNATURE_TYPE`, and `POLY_FUNDER`.

- [ ] **Step 1: Write failing dependency/adapter tests**

```python
def test_live_bridge_uses_v2_client_only():
    source = BRIDGE_PATH.read_text()
    self.assertIn("py_clob_client_v2", source)
    self.assertNotIn("from py_clob_client.", source)
```

- [ ] **Step 2: Run the test and verify it fails because the bridge imports V1.**

Run: `.venv-clob/bin/python3 tests/test_live_gateway_bridge.py`

- [ ] **Step 3: Install and pin the official V2 package, then replace imports/client construction.**

```python
from py_clob_client_v2.client import ClobClient
from py_clob_client_v2.clob_types import ApiCreds

client = ClobClient({
    "host": host,
    "chain": 137,
    "key": private_key,
    "creds": ApiCreds(...),
    "signature_type": signature_type,
    "funder_address": funder,
})
```

Use the exact installed V2 Python API after inspecting its package source; do not guess constructor or method names.

- [ ] **Step 4: Verify the focused tests pass and V1 package is absent from the live requirements.**

Run: `.venv-clob/bin/python3 tests/test_live_gateway_bridge.py && uv pip check --python .venv-clob/bin/python3`

### Task 2: Migrate read-only exchange actions and pUSD funds truth

**Files:**
- Modify: `execution/live_gateway_bridge.py`
- Modify: `ops/scripts/check_polymarket_funds.sh`
- Modify: `tests/test_live_gateway_bridge.py`
- Modify: `tests/test_operational_paths.mjs`

**Interfaces:**
- Produces: `balance` result `{ok, balance, allowances, collateral_asset:"pUSD", account_owner, source}`.
- Consumes: V2 client from Task 1.

- [ ] **Step 1: Write failing tests for pUSD-only balance metadata and V2 read-only source labels.**

```python
def test_balance_reports_pusd_collateral_contract():
    source = BRIDGE_PATH.read_text()
    self.assertIn('"collateral_asset": "pUSD"', source)
    self.assertNotIn("USDC_E_ADDRESS", source)
```

- [ ] **Step 2: Run the test and verify the legacy collateral assumptions fail it.**

Run: `.venv-clob/bin/python3 tests/test_live_gateway_bridge.py`

- [ ] **Step 3: Adapt `health`, `balance`, `query`, `open_orders`, `recent_trades`, and `cancel` to V2 methods.**

Each action must preserve the existing JSON field names where Node recovery consumes them. On a missing V2 method, malformed response, or unsupported balance shape, return `{ok:false}` rather than substituting a V1 call or a zero balance.

- [ ] **Step 4: Make `check_polymarket_funds.sh` call bridge `balance` rather than importing an SDK directly.**

```bash
balance_json="$($POLY_PYTHON "$APP_ROOT/execution/live_gateway_bridge.py" balance '{}')"
```

Reject `collateral_asset != "pUSD"`, a missing allowance, or insufficient micro-USDC-equivalent balance.

- [ ] **Step 5: Run read-only regression tests.**

Run: `node --test tests/test_operational_paths.mjs tests/test_live_config_guard.mjs && .venv-clob/bin/python3 tests/test_live_gateway_bridge.py`

### Task 3: Migrate V2 order lifecycle without live submission

**Files:**
- Modify: `execution/live_gateway_bridge.py`
- Modify: `src/core/execution/live_execution_gateway.mjs`
- Modify: `tests/test_execution_fix.mjs`
- Modify: `tests/test_convergence.mjs`

**Interfaces:**
- Produces: unchanged gateway result fields `order_id`, `status`, `executed_size`, `original_size`, `fill_price`, and `source`.
- Consumes: V2 order creation/post/query/cancel responses.

- [ ] **Step 1: Write failing fixtures for V2 order response normalization.**

```javascript
assert.equal(normalizeOrderStatus('LIVE', 5, 0), 'acknowledged');
assert.equal(normalizeOrderStatus('MATCHED', 5, 5), 'filled');
```

Add a bridge fixture that asserts V2 orders do not set V1-only signed fields (`nonce`, `feeRateBps`, `taker`).

- [ ] **Step 2: Run the fixture and verify it fails against the V1 adapter.**

Run: `node --test tests/test_execution_fix.mjs tests/test_convergence.mjs`

- [ ] **Step 3: Implement V2 order creation using market metadata.**

Before creating an order, obtain V2 market info and validate tick size, minimum order size, and fee metadata. Preserve existing risk validation before this bridge call. Never use V1 signing fields or contract addresses.

- [ ] **Step 4: Verify all lifecycle tests pass without a live order.**

Run: `node --test tests/test_execution_fix.mjs tests/test_convergence.mjs tests/test_recovery_safety.mjs`

### Task 4: Make pUSD funding and bridge-address readiness explicit

**Files:**
- Modify: `execution/live_gateway_bridge.py`
- Create: `ops/scripts/preflight_polymarket_bridge_deposit.sh`
- Modify: `ops/runbooks/ENTRYPOINTS.md`
- Modify: `.env.live.template`
- Modify: `tests/test_operational_paths.mjs`

**Interfaces:**
- Produces: read-only `bridge_deposit_preflight` result containing only `target_wallet`, `evm_deposit_address`, supported Polygon USDC asset metadata, and current minimum amount.
- Consumes: `POLY_FUNDER` only; it must not use API secrets or send funds.

- [ ] **Step 1: Write a failing fixture for target-wallet binding and no transfer action.**

```javascript
assert.match(bridgeDepositSource, /bridge\.polymarket\.com\/deposit/);
assert.match(bridgeDepositSource, /POLY_FUNDER/);
assert.doesNotMatch(bridgeDepositSource, /wrap\(|transfer\(|approve\(/);
```

- [ ] **Step 2: Run the test and verify the new preflight does not yet exist.**

Run: `node --test tests/test_operational_paths.mjs`

- [ ] **Step 3: Implement a read-only bridge-address preflight.**

Call the official Bridge deposit-address and supported-assets endpoints for `POLY_FUNDER`; return failure on timeout, unsupported Polygon USDC, missing EVM address, or an amount below the returned minimum. Do not print secrets.

- [ ] **Step 4: Document the only approved funding instruction.**

State that an operator sends supported Polygon USDC to the generated EVM bridge address for `POLY_FUNDER`; the bridge converts it to pUSD. Do not recommend direct token transfer to the Safe before V2 balance/approval verification.

- [ ] **Step 5: Verify scripts are syntax-safe and default non-mutating.**

Run: `node --test tests/test_operational_paths.mjs && bash -n ops/scripts/*.sh`

### Task 5: V2 read-only acceptance and controlled-live handoff

**Files:**
- Modify: `ops/scripts/preflight_strict_live.sh`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/PROJECT_CONTEXT.md`
- Modify: `ops/runbooks/ENTRYPOINTS.md`

**Interfaces:**
- Produces: a strict preflight report that distinguishes `v2_runtime_ready`, `pUSD_balance_ready`, `pUSD_allowance_ready`, `exposure_reconciled`, and `live_canary_authorization_required`.

- [ ] **Step 1: Write a failing operational-path assertion for V2/pUSD preflight fields.**

```javascript
assert.match(strictPreflightSource, /collateral_asset.*pUSD/);
assert.match(strictPreflightSource, /preflight_polymarket_bridge_deposit/);
```

- [ ] **Step 2: Run the test and verify the old preflight lacks this V2 contract.**

Run: `node --test tests/test_operational_paths.mjs`

- [ ] **Step 3: Add the V2/pUSD checks to strict preflight.**

Keep all recovery steps `--dryRun true --readOnly true`. A V2 configuration error, empty pUSD balance, missing allowance, inconclusive positions, or unresolved exposure must exit 2 before any canary command.

- [ ] **Step 4: Execute final offline and read-only validation.**

Run:

```bash
node --test tests/test_operational_paths.mjs tests/test_recovery_safety.mjs tests/test_live_config_guard.mjs tests/test_claim_worker_safety.mjs tests/test_claim_worker_lifecycle.mjs tests/test_execution_fix.mjs tests/test_convergence.mjs tests/test_pretrade_guard_runtime_state.mjs
.venv-clob/bin/python3 tests/test_live_gateway_bridge.py
.venv-clob/bin/python3 -m py_compile execution/live_gateway_bridge.py
node --check src/core/execution/recovery_controller.mjs
node --check src/web/dashboard_api.mjs
bash -n ops/scripts/*.sh
uv pip check --python .venv-clob/bin/python3
git diff --check
```

- [ ] **Step 5: Conduct read-only production checks and stop before any live order.**

Run the V2 bridge-address preflight, V2 balance/allowance check, and strict preflight. Record exact blockers. A real order remains a separate human authorization after these checks and independent review.

## Self-Review

- V2 SDK replacement, V2 order signing, pUSD collateral, funding-address binding, and strict-preflight evidence each have a task.
- No task authorizes transfer, wrapping, allowance mutation, cancellation, or live order submission.
- Interfaces retain the Node recovery ledger contract to avoid a schema migration.
- Every production behavior change starts with a test that must fail before implementation.
