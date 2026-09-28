#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import { loadTradeState, saveTradeState } from '../src/core/state/trade_state_store.mjs';
import { runRecoverySequence } from '../src/core/execution/recovery_controller.mjs';

const outEvents = process.argv.includes('--outEvents') ? process.argv[process.argv.indexOf('--outEvents') + 1] : 'data/live_drill_events.jsonl';
const unresolvedOrderLimitMs = Number(process.argv.includes('--unresolvedOrderLimitMs') ? process.argv[process.argv.indexOf('--unresolvedOrderLimitMs') + 1] : 10000);

const ts = () => new Date().toISOString();
const event = async (type, payload = {}) => appendFile(outEvents, JSON.stringify({ ts: ts(), type, ...payload }) + '\n', 'utf8');

async function main() {
  const state = await loadTradeState();

  // Drill step 1: force halt
  state.halted = true;
  state.halt_reason = 'drill_forced_halt';
  await saveTradeState(state);
  await event('DRILL_FORCED_HALT', { reason: state.halt_reason });

  // Drill step 2: run recovery
  const recovery = await runRecoverySequence({
    state,
    unresolvedMsLimit: unresolvedOrderLimitMs,
    dryRun: true,
    onEvent: event,
  });
  await saveTradeState(recovery.state);

  // Drill step 3: summarize
  const summary = {
    ok: recovery.ok,
    resumed: recovery.resumed,
    halted_after: recovery.state.halted,
    halt_reason_after: recovery.state.halt_reason,
  };
  await event('DRILL_SUMMARY', summary);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e?.message || String(e));
  process.exit(1);
});
