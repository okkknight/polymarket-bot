import { loadTradeState } from '../core/state/trade_state_store.mjs';
import { fileURLToPath } from 'node:url';

const isDirectExecution = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectExecution && !process.env.RUN_VIA_SH) {
  console.error("ERROR: polymarket_state_reset_for_canary.mjs should not be run directly.");
  console.error("Please use the recommended entrypoint: bash ops/scripts/run_live_canary_strict_sync.sh");
  console.error("Or set RUN_VIA_SH=1 to bypass this check (not recommended).");
  process.exit(1);
}

export function prepareStateForCanary(state) {
  return state;
}

async function main() {
  const state = await loadTradeState();
  const prepared = prepareStateForCanary(state);
  console.log(JSON.stringify({
    ok: true,
    preserved: ['halted', 'halt_reason', 'intents', 'intent_index', 'orders', 'reconcile'],
    intents_count: Object.keys(prepared.intents || {}).length,
  }, null, 2));
}

if (isDirectExecution) {
  main().catch((e) => {
    console.error(e?.message || String(e));
    process.exit(1);
  });
}
