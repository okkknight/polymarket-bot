# Polymarket Bot Entrypoints (Single-page Guide)

> Goal: reduce operator confusion. Prefer one default path for live canary.

## Recommended default

- **Use this for normal live canary runs:**
  - `bash ops/scripts/run_live_canary_strict_sync.sh`

This orchestrates:
1. strict preflight
2. pre-reconcile
3. canary run
4. post-reconcile

---

## Entrypoint map

### 1) `run_live_canary_strict_sync.sh` (PRIMARY)

- Purpose: full guarded live canary flow.
- Use when: you want safest standard runbook.
- Includes: preflight + reconcile before/after run.

### 2) `preflight_strict_live.sh` (CHECK-ONLY)

- Purpose: environment/risk/market/Bridge deposit route/pUSD funds checks + dry-run validation.
- Use when: you want to verify readiness without starting live canary.
- Does **not** execute full live canary flow.

### 3) `run_live_canary_with_proxy.sh` (COMPAT SHORTCUT)

- Purpose: direct canary launch path with proxy/risk gates.
- Use when: compatibility/manual quick execution is needed.
- Note: prefer strict_sync as primary entry.

### Bridge deposit preflight (CHECK-ONLY)

- Command: `bash ops/scripts/preflight_polymarket_bridge_deposit.sh`
- Purpose: obtain the Bridge deposit metadata for `POLY_FUNDER` and verify Polygon USDC support before an operator funds the account.
- Does **not** transfer, wrap, approve, deposit, or withdraw any asset.

### 4) `start_polymarket_live_recoverable.sh` (LOW-LEVEL LAUNCHER)

- Purpose: low-level runner starter (live/dry-run parameters).
- Use when: scripting/advanced integration calls a base launcher.
- Note: not recommended as human default entry.

### 5) `run_shadow_with_proxy.sh` (SHADOW ONLY)

- Purpose: shadow mode run (non-live order path).
- Use when: strategy observation/backtesting-like runtime without live canary flow.
- Independent from strict_sync live path.

### 6) `preflight_claim_relayer.sh` (CLAIM CHECK-ONLY)

- Purpose: verify the configured Relayer API key, signer/key-address match, and Safe/funder identity without submitting a claim transaction.
- Use when: after creating a Relayer API key for the current signer but before enabling automatic claim.
- Does **not** redeem, transfer funds, or change allowance.

### 7) `run_auto_claim_worker.sh` (LONG-RUNNING CLAIM WORKER)

- Purpose: start the account-scoped claim detector/worker after the read-only claim preflight passes. It submits only verified winners (`curPrice=1`, positive `currentValue`), never zero-value resolved holdings.
- Default: detection only (`AUTO_CLAIM_ENABLED=false`); it cannot submit a redeem without both execution switches.
- Run once: append `--once`. Long-running mode checks every 60 seconds by default (`CLAIM_CHECK_INTERVAL_MS` can increase this interval).

### 8) `adopt_exchange_holdings.sh` (EXPLICIT LOCAL RECOVERY)

- Purpose: after an operator has independently confirmed account-scoped exchange holdings, write them into the local exposure ledger and clear the corresponding unconfirmed-holdings recovery boundary.
- Default: blocked. It requires both `ADOPT_EXCHANGE_HOLDINGS_APPROVED=true` and `ADOPT_EXCHANGE_HOLDINGS_CONFIRM=ADOPT_CURRENT_EXCHANGE_HOLDINGS`.
- Does **not** submit, cancel, transfer, withdraw, deposit, or change allowance.

---

## Quick decision table

- “I want the standard safe live canary run” → `run_live_canary_strict_sync.sh`
- “I only want readiness checks” → `preflight_strict_live.sh`
- “I need to confirm where to fund the bot Safe” → `preflight_polymarket_bridge_deposit.sh`
- “I need shadow run” → `run_shadow_with_proxy.sh`
- “I configured a Relayer API key and want to validate claim readiness” → `preflight_claim_relayer.sh`
- “I need the claim detector/worker running” → `run_auto_claim_worker.sh`
- “I verified exchange holdings and need to recover the local ledger” → `adopt_exchange_holdings.sh` (only with the two explicit confirmations)
- “I’m wiring automation and need a base launcher” → `start_polymarket_live_recoverable.sh`

---

## Environment loading

All key polymarket ops scripts now auto-load:
- `.env.live.local`（位于仓库根目录，如存在）

So credentials/proxy-related values can be managed there (or overridden by explicit exported env vars).

## Direct mjs execution policy

- Default policy: run via `ops/scripts/*.sh` only.
- Core runtime scripts (`polymarket_paper_trading_realtime.mjs`, `polymarket_recovery_control.mjs`, `polymarket_state_reset_for_canary.mjs`) enforce a guard and require:
  - `RUN_VIA_SH=1`
- This reduces accidental direct execution and keeps execution paths consistent.
