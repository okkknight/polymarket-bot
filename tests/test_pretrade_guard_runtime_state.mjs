#!/usr/bin/env node
import assert from 'node:assert/strict';
import { preTradeGuard } from '../src/core/execution/limit_order_executor.mjs';

function main() {
  const blockedReconciling = preTradeGuard({
    halted: false,
    runtimeState: 'RECONCILING',
    marketKnown: true,
    positionKnown: true,
    balanceKnown: true,
  });
  assert.equal(blockedReconciling.ok, false);
  assert.equal(blockedReconciling.reason, 'reconciling');

  const allowedRunning = preTradeGuard({
    halted: false,
    runtimeState: 'RUNNING',
    marketKnown: true,
    positionKnown: true,
    balanceKnown: true,
  });
  assert.equal(allowedRunning.ok, true);

  console.log('PASS test_pretrade_guard_runtime_state');
}

main();
