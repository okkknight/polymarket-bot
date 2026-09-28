import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { prepareStateForCanary } from '../src/runners/polymarket_state_reset_for_canary.mjs';
import { adoptExchangeHoldings, runRecoverySequence } from '../src/core/execution/recovery_controller.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const recoverySource = await readFile(resolve(repoRoot, 'src/core/execution/recovery_controller.mjs'), 'utf8');
assert.match(recoverySource, /EXPOSURE_AUTO_ADOPT \|\| 'false'/);

function activeIntent(clientOrderId = 'bot-order-1') {
  return {
    client_order_id: clientOrderId,
    order_id: 'exchange-order-1',
    status: 'acknowledged',
    size: 5,
    ack_ts: new Date(Date.now() - 61_000).toISOString(),
    market_id: 'market-1',
    token_id: 'token-1',
  };
}

function botOwnedState() {
  const intent = activeIntent();
  return {
    halted: true,
    halt_reason: 'unresolved_order',
    intents: { [intent.client_order_id]: intent },
    intent_index: { [intent.client_order_id]: 'acknowledged' },
    orders: {
      [intent.client_order_id]: {
        client_order_id: intent.client_order_id,
        order_id: intent.order_id,
        source: 'live_submit',
        asset_id: intent.token_id,
        executed_size: 0,
      },
    },
    exposure_ledger: { holdings: {}, avg_prices: {}, source_by_asset: {}, lifecycle_by_asset: {} },
  };
}

{
  const state = botOwnedState();
  const before = structuredClone(state);
  const prepared = prepareStateForCanary(state);
  assert.deepEqual(prepared.intents, before.intents);
  assert.deepEqual(prepared.intent_index, before.intent_index);
  assert.equal(prepared.halted, true);
  assert.equal(prepared.halt_reason, 'unresolved_order');
}

{
  const state = botOwnedState();
  let cancelCalls = 0;
  const events = [];
  const persistedCancelStatuses = [];
  const result = await runRecoverySequence({
    state,
    dryRun: false,
    unresolvedMsLimit: 1,
    liveGateway: {
      getPositions: async () => ({ positions: [], source: 'test' }),
      queryOrderStatus: async () => ({ status: 'acknowledged', source: 'test' }),
    },
    liveCancel: async (record) => {
      cancelCalls += 1;
      assert.equal(record.order_id, 'exchange-order-1');
      return { status: 'canceled', source: 'test' };
    },
    persistState: async (nextState) => {
      persistedCancelStatuses.push(nextState.intents['bot-order-1']?.cancel_attempt?.status || null);
    },
    onEvent: async (type, payload) => events.push({ type, payload }),
  });

  assert.equal(cancelCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.state.intents['bot-order-1'].status, 'canceled');
  assert.equal(result.state.intents['bot-order-1'].cancel_attempt.status, 'confirmed');
  assert.deepEqual(persistedCancelStatuses, ['attempted', 'confirmed']);
  assert.ok(events.some((event) => event.type === 'RECOVERY_CANCEL_ATTEMPTED'));
  assert.ok(events.some((event) => event.type === 'RECOVERY_CANCEL_CONFIRMED'));
}

{
  const state = botOwnedState();
  delete state.orders['bot-order-1'];
  let cancelCalls = 0;
  const result = await runRecoverySequence({
    state,
    dryRun: false,
    unresolvedMsLimit: 1,
    liveGateway: {
      getPositions: async () => ({ positions: [], source: 'test' }),
      queryOrderStatus: async () => ({ status: 'acknowledged', source: 'test' }),
    },
    liveCancel: async () => {
      cancelCalls += 1;
      return { status: 'canceled', source: 'test' };
    },
  });

  assert.equal(cancelCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.state.halted, true);
}

{
  const state = botOwnedState();
  let cancelCalls = 0;
  const liveGateway = {
    getPositions: async () => ({ positions: [], source: 'test' }),
    queryOrderStatus: async () => ({ status: 'acknowledged', source: 'test' }),
  };
  const liveCancel = async () => {
    cancelCalls += 1;
    throw new Error('timeout');
  };

  const first = await runRecoverySequence({
    state,
    dryRun: false,
    unresolvedMsLimit: 1,
    liveGateway,
    liveCancel,
  });
  assert.equal(first.ok, false);
  assert.equal(cancelCalls, 1);
  assert.equal(first.state.intents['bot-order-1'].cancel_attempt.status, 'unknown');

  const restarted = await runRecoverySequence({
    state: first.state,
    dryRun: false,
    unresolvedMsLimit: 1,
    liveGateway,
    liveCancel,
  });
  assert.equal(restarted.ok, false);
  assert.equal(cancelCalls, 1);
  assert.equal(restarted.state.halted, true);
}

{
  const state = botOwnedState();
  state.exposure_ledger.holdings = { 'known-token': 4 };
  const result = await adoptExchangeHoldings({
    state,
    liveGateway: { getPositions: async () => ({ positions: [], reason: 'positions_inconclusive', source: 'test' }) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'exposure_positions_inconclusive');
  assert.deepEqual(state.exposure_ledger.holdings, { 'known-token': 4 });
}

{
  const state = botOwnedState();
  const result = await adoptExchangeHoldings({
    state,
    liveGateway: {
      getPositions: async () => ({
        positions: [{ asset_id: 'recovered-token', yes: 3, no: 0, avg_price: 0.42 }],
        account_owner: '0x1111000000000000000000000000000000000000',
      }),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.state, state);
  assert.equal(result.account_owner, '0x1111000000000000000000000000000000000000');
  assert.equal(result.state.exposure_ledger.holdings['recovered-token'], 3);
}

console.log('PASS test_recovery_safety');
