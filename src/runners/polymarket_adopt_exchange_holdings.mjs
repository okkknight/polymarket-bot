#!/usr/bin/env node
// Explicit local-operator recovery action. This is deliberately separate from
// all read-only preflight and live-run entrypoints.
if (!process.env.RUN_VIA_SH) {
  console.error('ERROR: use ops/scripts/adopt_exchange_holdings.sh');
  process.exit(2);
}

const approved = String(process.env.ADOPT_EXCHANGE_HOLDINGS_APPROVED || '').toLowerCase() === 'true';
const confirmation = String(process.env.ADOPT_EXCHANGE_HOLDINGS_CONFIRM || '');
if (!approved || confirmation !== 'ADOPT_CURRENT_EXCHANGE_HOLDINGS') {
  console.error('ERROR: adoption requires ADOPT_EXCHANGE_HOLDINGS_APPROVED=true and ADOPT_EXCHANGE_HOLDINGS_CONFIRM=ADOPT_CURRENT_EXCHANGE_HOLDINGS');
  process.exit(2);
}

import { appendFile } from 'node:fs/promises';
import { loadTradeState, saveTradeState } from '../core/state/trade_state_store.mjs';
import { adoptExchangeHoldings } from '../core/execution/recovery_controller.mjs';
import { createLiveExecutionGateway } from '../core/execution/live_execution_gateway.mjs';

const outEvents = process.env.ADOPTION_EVENTS_PATH || 'data/recovery_events.jsonl';
const event = async (type, payload = {}) => {
  await appendFile(outEvents, JSON.stringify({ ts: new Date().toISOString(), type, ...payload }) + '\n', 'utf8');
};

async function main() {
  const state = await loadTradeState();
  const result = await adoptExchangeHoldings({
    state,
    liveGateway: createLiveExecutionGateway(),
    onEvent: event,
  });
  if (!result?.ok) {
    console.error(JSON.stringify({ ok: false, reason: result?.reason || 'adoption_failed' }));
    process.exit(2);
  }
  await saveTradeState(result.state);
  console.log(JSON.stringify({
    ok: true,
    adopted_count: result.adopted_count || 0,
    account_owner: result.account_owner || null,
  }));
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
