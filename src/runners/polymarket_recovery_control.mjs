#!/usr/bin/env node
// Guard: prevent direct execution without going through ops/scripts
if (!process.env.RUN_VIA_SH) {
  console.error("ERROR: polymarket_recovery_control.mjs should not be run directly.");
  console.error("Please use the recommended entrypoint: bash ops/scripts/run_live_canary_strict_sync.sh");
  console.error("Or set RUN_VIA_SH=1 to bypass this check (not recommended).");
  process.exit(1);
}

import { appendFile } from 'node:fs/promises';
import { loadTradeState, saveTradeState } from '../core/state/trade_state_store.mjs';
import { runRecoverySequence } from '../core/execution/recovery_controller.mjs';
import { createLiveExecutionGateway } from '../core/execution/live_execution_gateway.mjs';

const unresolvedOrderLimitMs = Number(process.argv.includes('--unresolvedOrderLimitMs') ? process.argv[process.argv.indexOf('--unresolvedOrderLimitMs') + 1] : 10000);
const dryRun = process.argv.includes('--dryRun') ? String(process.argv[process.argv.indexOf('--dryRun') + 1]).toLowerCase() !== 'false' : true;
const readOnly = process.argv.includes('--readOnly')
  ? String(process.argv[process.argv.indexOf('--readOnly') + 1]).toLowerCase() !== 'false'
  : dryRun;
const outEvents = process.argv.includes('--outEvents') ? process.argv[process.argv.indexOf('--outEvents') + 1] : 'data/recovery_events.jsonl';

if (!dryRun && readOnly) {
  console.error('ERROR: live recovery requires durable state persistence; use --readOnly false.');
  process.exit(2);
}

const ts = () => new Date().toISOString();
const event = async (type, payload = {}) => {
  if (readOnly) return;
  await appendFile(outEvents, JSON.stringify({ ts: ts(), type, ...payload }) + '\n', 'utf8');
};

async function main() {
  const state = await loadTradeState();
  const liveGateway = createLiveExecutionGateway();
  const result = await runRecoverySequence({
    state,
    unresolvedMsLimit: unresolvedOrderLimitMs,
    dryRun,
    liveCancel: liveGateway.cancelOrder,
    liveGateway: liveGateway,  // Pass gateway for exposure sync
    persistState: async (stateToPersist) => {
      if (!readOnly) await saveTradeState(stateToPersist);
    },
    onEvent: event,
  });
  if (!readOnly) await saveTradeState(result.state);

  const summary = {
    ok: result.ok,
    resumed: result.resumed,
    reason: result.reason || null,
    detail: result.detail || null,
    halted: Boolean(result.state?.halted),
    halt_reason: result.state?.halt_reason || null,
    read_only: readOnly,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!result.ok) process.exit(2);
}

main().catch((e) => {
  console.error(e?.message || String(e));
  process.exit(1);
});
