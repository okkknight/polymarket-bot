#!/usr/bin/env node
/**
 * Polymarket Auto-Claim Worker
 * 
 * Periodically checks for claimable markets and auto-claims resolved positions.
 * 
 * Run: node auto_claim_worker.mjs
 * Or: pm2 start auto_claim_worker.mjs --name poly-claim
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || './data';
const POLY_PYTHON = process.env.POLY_PYTHON || '.venv-clob/bin/python3';
const CHECK_INTERVAL_MS = Math.max(30_000, Number(process.env.CLAIM_CHECK_INTERVAL_MS || 60_000));
const CLAIM_MAX_SUBMITS_PER_RUN = Math.max(1, Math.min(10, Number(process.env.CLAIM_MAX_SUBMITS_PER_RUN || 1)));
const RUN_ONCE = process.argv.includes('--once');
const RECONCILE_ONLY = process.argv.includes('--reconcile-only');
// Detection is safe to schedule. Actual redemption remains separately gated
// until a reviewed relayer transaction implementation is configured.
const AUTO_CLAIM_ENABLED = String(process.env.AUTO_CLAIM_ENABLED || 'false').toLowerCase() === 'true';

function claimExecutionReadiness(environ = process.env) {
  const required = [
    'POLYMARKET_RELAYER_URL',
    'POLYMARKET_RELAYER_API_KEY',
    'POLYMARKET_RELAYER_API_KEY_ADDRESS',
  ];
  const missing = required.filter((name) => !String(environ[name] || '').trim());
  return {
    ok: AUTO_CLAIM_ENABLED && String(environ.CLAIM_EXECUTION_APPROVED || 'false').toLowerCase() === 'true' && missing.length === 0,
    missing,
    approval_present: String(environ.CLAIM_EXECUTION_APPROVED || 'false').toLowerCase() === 'true',
  };
}

// Helper to call bridge
function bridgeCall(action, payload = {}) {
  return new Promise((resolve, reject) => {
    const python = spawn(POLY_PYTHON, [
      'execution/live_gateway_bridge.py',
      action,
      JSON.stringify(payload)
    ], {
      cwd: process.cwd(),
      env: { ...process.env }
    });
    
    let stdout = '';
    let stderr = '';
    
    python.stdout.on('data', (data) => { stdout += data; });
    python.stderr.on('data', (data) => { stderr += data; });
    
    python.on('close', (code) => {
      if (code !== 0 && stderr) {
        resolve({ ok: false, error: stderr });
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        resolve({ ok: false, error: `parse_error: ${stdout}` });
      }
    });
  });
}

// Read state
function readState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'trader_state.json'), 'utf-8'));
  } catch (e) {
    return { version: '2.0', claims: { pending: [], completed: [], failed: [] } };
  }
}

// Write state
function writeState(state) {
  state.updated_at = new Date().toISOString();
  fs.writeFileSync(path.join(DATA_DIR, 'trader_state.json'), JSON.stringify(state, null, 2));
}

// Log event
function logEvent(type, data) {
  const event = { type, ts: new Date().toISOString(), ...data };
  const eventLine = JSON.stringify(event) + '\n';
  fs.appendFileSync(path.join(DATA_DIR, 'events.jsonl'), eventLine);
  console.log(`[${type}]`, data);
}

function ensureClaims(state) {
  state.claims = state.claims || {};
  state.claims.pending = state.claims.pending || [];
  state.claims.completed = state.claims.completed || [];
  state.claims.failed = state.claims.failed || [];
  return state.claims;
}

function claimKeyFor(market) {
  return `${market.condition_id || market.market_id}:${market.asset_id || ''}`;
}

function isDefinitiveSubmitRejection(error) {
  return /(?:status_code=|\bhttp\s*)40[13]\b|invalid (?:authorization|api key)|forbidden/i.test(String(error || ''));
}

function builderCredentialFingerprint(environ = process.env) {
  const key = String(environ.POLYMARKET_RELAYER_API_KEY || '').trim();
  return key ? createHash('sha256').update(key).digest('hex').slice(0, 16) : null;
}

async function reconcilePendingClaims(state, claimReadiness) {
  const claims = ensureClaims(state);
  const currentCredentialFingerprint = builderCredentialFingerprint();

  for (let index = claims.pending.length - 1; index >= 0; index -= 1) {
    const claim = claims.pending[index];
    if (claim.status === 'submit_outcome_unknown' && isDefinitiveSubmitRejection(claim.last_error)) {
      claim.status = 'submit_rejected';
      claim.rejected_at = new Date().toISOString();
      claim.builder_credential_fingerprint = claim.builder_credential_fingerprint || currentCredentialFingerprint;
      writeState(state);
      logEvent('CLAIM_SUBMIT_REJECTED', { claim_key: claim.claim_key, error: claim.last_error });
      continue;
    }
    if (claim.status === 'submit_rejected' && !claim.builder_credential_fingerprint) {
      claim.builder_credential_fingerprint = currentCredentialFingerprint;
      writeState(state);
      continue;
    }
    if (claim.status === 'submit_rejected' && claimReadiness.ok && currentCredentialFingerprint && claim.builder_credential_fingerprint !== currentCredentialFingerprint) {
      claims.pending.splice(index, 1);
      claims.failed.push({ ...claim, status: 'rejected_credential_rotated', superseded_at: new Date().toISOString() });
      writeState(state);
      logEvent('CLAIM_REJECTED_CREDENTIAL_ROTATED', { claim_key: claim.claim_key });
      continue;
    }
    if (!claimReadiness.ok) continue;
    if (!claim.transaction_id || !['submitted', 'reconciliation_unknown'].includes(claim.status)) continue;
    const statusResult = await bridgeCall('claim_status', { transaction_id: claim.transaction_id });
    claim.last_reconcile_at = new Date().toISOString();
    if (!statusResult.ok) {
      claim.status = 'reconciliation_unknown';
      claim.last_error = statusResult.error || 'claim_status_unknown';
      writeState(state);
      logEvent('CLAIM_RECONCILIATION_UNKNOWN', { claim_key: claim.claim_key, transaction_id: claim.transaction_id, error: claim.last_error });
      continue;
    }
    claim.relayer_state = statusResult.state || null;
    claim.transaction_hash = statusResult.transaction_hash || claim.transaction_hash || null;
    if (['STATE_MINED', 'STATE_CONFIRMED'].includes(statusResult.state)) {
      claims.pending.splice(index, 1);
      claims.completed.push({ ...claim, status: 'confirmed', completed_at: new Date().toISOString() });
      writeState(state);
      logEvent('CLAIM_CONFIRMED', { claim_key: claim.claim_key, transaction_id: claim.transaction_id, state: statusResult.state });
    } else if (['STATE_FAILED', 'STATE_INVALID'].includes(statusResult.state)) {
      claims.pending.splice(index, 1);
      claims.failed.push({ ...claim, status: 'failed', failed_at: new Date().toISOString(), last_error: statusResult.error || statusResult.state });
      writeState(state);
      logEvent('CLAIM_FAILED', { claim_key: claim.claim_key, transaction_id: claim.transaction_id, state: statusResult.state, error: statusResult.error || null });
    } else {
      claim.status = 'submitted';
      writeState(state);
    }
  }
}

async function submitClaim(state, market, claimReadiness) {
  const claims = ensureClaims(state);
  const marketId = market.market_id;
  const claimKey = claimKeyFor(market);
  const claim = {
    market_id: marketId,
    condition_id: market.condition_id || marketId,
    asset_id: market.asset_id,
    claim_key: claimKey,
    size: market.size,
    outcome: market.outcome,
    outcome_index: market.outcome_index,
    negative_risk: Boolean(market.negative_risk),
    builder_credential_fingerprint: builderCredentialFingerprint(),
    detected_at: new Date().toISOString(),
  };

  if (!claimReadiness.ok) {
    claim.status = 'execution_blocked';
    claim.reason = !AUTO_CLAIM_ENABLED ? 'auto_claim_disabled' : 'claim_execution_not_ready';
    claim.missing_claim_config = claimReadiness.missing;
    claims.pending.push(claim);
    writeState(state);
    logEvent('CLAIM_EXECUTION_BLOCKED', { claim_key: claimKey, reason: claim.reason, missing_claim_config: claim.missing_claim_config });
    return { kind: 'blocked' };
  }

  // This durable write is intentionally before the external submit. An
  // exception after the request is ambiguous and must never be re-submitted.
  claim.status = 'submit_intent_recorded';
  claim.submit_attempted_at = new Date().toISOString();
  claims.pending.push(claim);
  writeState(state);
  logEvent('CLAIM_INTENT_RECORDED', { claim_key: claimKey, condition_id: claim.condition_id, asset_id: claim.asset_id });

  const submitResult = await bridgeCall('claim_submit', claim);
  if (!submitResult.ok || !submitResult.transaction_id) {
    claim.last_error = submitResult.error || 'claim_submit_missing_transaction_id';
    claim.status = isDefinitiveSubmitRejection(claim.last_error) ? 'submit_rejected' : 'submit_outcome_unknown';
    if (claim.status === 'submit_rejected') claim.rejected_at = new Date().toISOString();
    writeState(state);
    logEvent(claim.status === 'submit_rejected' ? 'CLAIM_SUBMIT_REJECTED' : 'CLAIM_SUBMIT_OUTCOME_UNKNOWN', { claim_key: claimKey, error: claim.last_error });
    return { kind: claim.status === 'submit_rejected' ? 'rejected' : 'unknown' };
  }
  claim.status = 'submitted';
  claim.transaction_id = submitResult.transaction_id;
  claim.transaction_hash = submitResult.transaction_hash || null;
  claim.relayer_state = submitResult.state || 'STATE_NEW';
  writeState(state);
  logEvent('CLAIM_SUBMITTED', { claim_key: claimKey, transaction_id: claim.transaction_id, transaction_hash: claim.transaction_hash });
  return { kind: 'submitted' };
}

// Check account-scoped redeemable holdings, reconcile existing submitted
// intents, then create at most one durable intent per undisputed position.
async function checkAndClaim() {
  console.log('\n=== Auto-Claim Check ===');
  const state = readState();
  const claimReadiness = claimExecutionReadiness();
  const claims = ensureClaims(state);

  try {
    await reconcilePendingClaims(state, claimReadiness);
    if (RECONCILE_ONLY) return;
    const result = await bridgeCall('get_claimable_markets', {});
    if (!result.ok) {
      console.error('Failed to get claimable markets:', result.error);
      return;
    }

    const markets = result.claimable_markets || [];
    console.log(`Found ${markets.length} claimable market(s)`);
    let submitCount = 0;
    for (const market of markets) {
      const claimKey = claimKeyFor(market);
      if (claims.completed.some((claim) => claim.claim_key === claimKey)) continue;
      const existing = claims.pending.find((claim) => claim.claim_key === claimKey);
      if (existing) {
        // A prior blocked detection never sent a request, so it is safe to
        // replace it with a durable submit intent once all explicit gates are
        // subsequently enabled. All other pending states remain non-retriable.
        if (claimReadiness.ok && existing.status === 'execution_blocked') {
          claims.pending.splice(claims.pending.indexOf(existing), 1);
          writeState(state);
        } else {
          continue;
        }
      }
      if (claimReadiness.ok && submitCount >= CLAIM_MAX_SUBMITS_PER_RUN) {
        logEvent('CLAIM_SUBMIT_BATCH_LIMIT_REACHED', { limit: CLAIM_MAX_SUBMITS_PER_RUN });
        break;
      }
      const outcome = await submitClaim(state, market, claimReadiness);
      if (['submitted', 'unknown', 'rejected'].includes(outcome?.kind)) submitCount += 1;
      if (outcome?.kind === 'unknown' || outcome?.kind === 'rejected') {
        logEvent('CLAIM_SUBMISSION_STOPPED', { reason: `submit_outcome_${outcome.kind}` });
        break;
      }
    }
  } catch (e) {
    console.error('Error in claim check:', e.message);
  }
}

// Main loop
async function main() {
  console.log('🤖 Auto-Claim Worker Starting...');
  console.log(`Check interval: ${CHECK_INTERVAL_MS}ms`);
  console.log(`Data dir: ${DATA_DIR}`);
  
  // Initial check
  await checkAndClaim();
  if (RUN_ONCE) return;
  
  // Periodic check
  setInterval(checkAndClaim, CHECK_INTERVAL_MS);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(console.error);
}

export { claimExecutionReadiness, claimKeyFor, isDefinitiveSubmitRejection, builderCredentialFingerprint };
