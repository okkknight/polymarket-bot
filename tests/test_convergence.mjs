/**
 * Test suite for order lifecycle convergence
 * Tests late fill after cancel scenarios
 */

import { ORDER_STATUS, reconcileOrderStatus, isFinalOrderStatus } from '../src/core/execution/limit_order_executor.mjs';

// Mock event function
const eventLog = [];
const mockEvent = async (type, data) => {
  eventLog.push({ type, data });
  console.log(`[${type}]`, JSON.stringify(data));
};

// Mock live query that simulates exchange behavior
function createMockLiveQuery(responses) {
  let idx = 0;
  return async () => {
    const resp = responses[idx] || responses[responses.length - 1];
    idx++;
    return resp;
  };
}

async function reset() {
  eventLog.length = 0;
}

async function test1_acknowledged_to_partially_filled_canceled() {
  console.log('\n=== TEST 1: acknowledged -> cancel -> partial fill -> remainder canceled ===');
  await reset();
  
  const responses = [
    { status: 'canceled', source: 'mock_exchange' },
    { status: 'partial_filled', executed_size: 1.5, source: 'mock_exchange' },
    { status: 'partial_filled', executed_size: 1.5, source: 'mock_exchange' },
    { status: 'partial_filled', executed_size: 1.5, source: 'mock_exchange' },
    { status: 'partial_filled', executed_size: 1.5, source: 'mock_exchange' },
    { status: 'partial_filled', executed_size: 1.5, source: 'mock_exchange' },
  ];
  
  const record = {
    client_order_id: 'test1',
    order_id: '0xabc',
    status: 'acknowledged',
    size: 2.0,
    ack_ts: new Date().toISOString(),
  };
  
  // First reconcile: goes to canceled
  let result = await reconcileOrderStatus({
    record,
    nowMs: Date.now(),
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: createMockLiveQuery([{ status: 'canceled', source: 'mock' }]),
    onEvent: mockEvent,
    maxLateFillReconciles: 5,
    maxCancelReconciles: 3,
    maxOrderLifecycleMs: 5000,
  });
  
  console.log('After first reconcile (canceled):', result.ok, result.status);
  
  // Second reconcile: late fill
  result = await reconcileOrderStatus({
    record: result.record,
    nowMs: Date.now() + 2000,
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: createMockLiveQuery([{ status: 'partial_filled', executed_size: 1.5, source: 'mock' }]),
    onEvent: mockEvent,
    maxLateFillReconciles: 5,
    maxCancelReconciles: 3,
    maxOrderLifecycleMs: 5000,
  });
  
  console.log('After second reconcile (late fill):', result.ok, result.status, result.converged);
  
  // Check state after late fill after cancel: should finalize as partially_filled_canceled
  const hasFinalizedPfc = eventLog.some(e => e.type === 'ORDER_LIFECYCLE_FINALIZED' && e?.data?.final_status === 'partially_filled_canceled');
  const finalStatus = result.record?.status;
  
  console.log('\n--- RESULT ---');
  console.log('Has ORDER_LIFECYCLE_FINALIZED(partially_filled_canceled):', hasFinalizedPfc);
  console.log('Status:', finalStatus);
  console.log('Is final:', isFinalOrderStatus(finalStatus));
  console.log('Expected: partially_filled_canceled');
  
  const pass = finalStatus === 'partially_filled_canceled' && hasFinalizedPfc;
  console.log('TEST 1:', pass ? 'PASS ✅' : 'FAIL ❌');
  return pass;
}

async function test2_acknowledged_to_filled_after_cancel() {
  console.log('\n=== TEST 2: acknowledged -> cancel -> partial fill -> fully filled ===');
  await reset();
  
  const record = {
    client_order_id: 'test2',
    order_id: '0xdef',
    status: 'acknowledged',
    size: 2.0,
    ack_ts: new Date().toISOString(),
  };
  
  // First: cancel requested
  let result = await reconcileOrderStatus({
    record,
    nowMs: Date.now(),
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: createMockLiveQuery([{ status: 'canceled', source: 'mock' }]),
    onEvent: mockEvent,
  });
  
  // Then: fully filled (race condition - fill happened after cancel)
  result = await reconcileOrderStatus({
    record: result.record,
    nowMs: Date.now() + 2000,
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: createMockLiveQuery([{ status: 'filled', executed_size: 2.0, source: 'mock' }]),
    onEvent: mockEvent,
    maxLateFillReconciles: 5,
    maxCancelReconciles: 3,
    maxOrderLifecycleMs: 5000,
  });
  
  const hasFinalized = eventLog.some(e => e.type === 'ORDER_LIFECYCLE_FINALIZED');
  console.log('\n--- RESULT ---');
  console.log('Final status:', result.record?.status);
  console.log('Has ORDER_LIFECYCLE_FINALIZED:', hasFinalized);
  
  const pass = result.record?.status === 'filled' && hasFinalized;
  console.log('TEST 2:', pass ? 'PASS ✅' : 'FAIL ❌');
  return pass;
}

async function test3_partial_filled_open() {
  console.log('\n=== TEST 3: partial fill with open remaining ===');
  await reset();
  
  const record = {
    client_order_id: 'test3',
    order_id: '0xghi',
    status: 'acknowledged',
    size: 2.0,
    ack_ts: new Date().toISOString(),
  };
  
  // First: cancel requested
  let result = await reconcileOrderStatus({
    record,
    nowMs: Date.now(),
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: createMockLiveQuery([{ status: 'canceled', source: 'mock' }]),
    onEvent: mockEvent,
  });
  
  // Then: partial fill but still open (exchange hasn't confirmed cancel)
  result = await reconcileOrderStatus({
    record: result.record,
    nowMs: Date.now() + 2000,
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: createMockLiveQuery([{ status: 'partial_filled', executed_size: 1.0, source: 'mock' }]),
    onEvent: mockEvent,
    maxLateFillReconciles: 5,
    maxCancelReconciles: 3,
    maxOrderLifecycleMs: 5000,
  });
  
  console.log('\n--- RESULT ---');
  console.log('Status:', result.record?.status);

  // Late partial fill after cancel should finalize to partially_filled_canceled
  const pass = result.record?.status === 'partially_filled_canceled' && result.final === true;
  console.log('TEST 3:', pass ? 'PASS ✅' : 'FAIL ❌');
  return pass;
}

async function test4_exceeds_threshold() {
  console.log('\n=== TEST 4: reconcile attempts exceed threshold ===');
  await reset();
  
  const record = {
    client_order_id: 'test4',
    order_id: '0xjkl',
    status: 'acknowledged',
    size: 2.0,
    ack_ts: new Date().toISOString(),
  };
  
  // First: cancel requested
  let result = await reconcileOrderStatus({
    record,
    nowMs: Date.now(),
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: createMockLiveQuery([{ status: 'canceled', source: 'mock' }]),
    onEvent: mockEvent,
  });
  
  // Multiple late fills - should become partial_filled_open but NOT finalized
  for (let i = 0; i < 6; i++) {
    result = await reconcileOrderStatus({
      record: result.record,
      nowMs: Date.now() + 2000 + i * 1000,
      unresolvedMsLimit: 1000,
      dryRun: false,
      liveQuery: createMockLiveQuery([{ status: 'partial_filled', executed_size: 1.0, source: 'mock' }]),
      onEvent: mockEvent,
      maxLateFillReconciles: 5,
      maxCancelReconciles: 3,
      maxOrderLifecycleMs: 5000,
    });
    
    if (result.record?.status === 'partial_filled_open') {
      console.log(`Reached partial_filled_open after ${i + 1} late fill reconciles`);
      break;
    }
  }
  
  const hasFinalizedPartialOpen = eventLog.some(e => e.type === 'ORDER_LIFECYCLE_FINALIZED' && e?.data?.final_status === 'partial_filled_open');
  const hasStuck = eventLog.some(e => e.type === 'ORDER_LIFECYCLE_STUCK');
  console.log('\n--- RESULT ---');
  console.log('Final status:', result.record?.status);
  console.log('Has ORDER_LIFECYCLE_FINALIZED(partial_filled_open):', hasFinalizedPartialOpen);
  console.log('Has ORDER_LIFECYCLE_STUCK:', hasStuck);
  console.log('Converged:', result.converged);
  
  const pass = result.record?.status === 'partial_filled_open' && !hasFinalizedPartialOpen && hasStuck && result.converged === false;
  console.log('TEST 4:', pass ? 'PASS ✅' : 'FAIL ❌');
  return pass;
}

async function test5_executed_size_preserved() {
  console.log('\n=== TEST 5: executed_size preserved through transitions ===');
  await reset();
  
  const record = {
    client_order_id: 'test5',
    order_id: '0xmno',
    status: 'acknowledged',
    size: 2.0,
    executed_size: 0,
    ack_ts: new Date().toISOString(),
  };
  
  // First: partial fill
  let result = await reconcileOrderStatus({
    record,
    nowMs: Date.now(),
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: createMockLiveQuery([{ status: 'partial_filled', executed_size: 1.5, source: 'mock' }]),
    onEvent: mockEvent,
  });
  
  console.log('After partial fill - executed_size:', result.record?.executed_size);
  
  // Then: cancel
  result = await reconcileOrderStatus({
    record: result.record,
    nowMs: Date.now() + 2000,
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: createMockLiveQuery([{ status: 'canceled', executed_size: 1.5, source: 'mock' }]),
    onEvent: mockEvent,
  });
  
  console.log('After cancel - executed_size:', result.record?.executed_size);
  
  // Late fill
  result = await reconcileOrderStatus({
    record: result.record,
    nowMs: Date.now() + 4000,
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: createMockLiveQuery([{ status: 'partial_filled', executed_size: 1.5, source: 'mock' }]),
    onEvent: mockEvent,
    maxLateFillReconciles: 5,
    maxCancelReconciles: 3,
    maxOrderLifecycleMs: 5000,
  });
  
  console.log('After late fill - executed_size:', result.record?.executed_size);
  
  const pass = result.record?.executed_size === 1.5;
  console.log('TEST 5:', pass ? 'PASS ✅' : 'FAIL ❌');
  return pass;
}

async function test6_partial_open_to_filled() {
  console.log('\n=== TEST 6: partial_filled_open -> filled ===');
  await reset();

  const record = {
    client_order_id: 'test6',
    order_id: '0xpqr',
    status: 'partial_filled_open',
    size: 2.0,
    executed_size: 1.0,
    original_size: 2.0,
    ack_ts: new Date().toISOString(),
  };

  const result = await reconcileOrderStatus({
    record,
    nowMs: Date.now(),
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: createMockLiveQuery([{ status: 'filled', executed_size: 2.0, source: 'mock' }]),
    onEvent: mockEvent,
  });

  const pass = result.record?.status === 'filled' && result.final === true;
  console.log('TEST 6:', pass ? 'PASS ✅' : 'FAIL ❌');
  return pass;
}

async function test7_partial_open_to_partially_filled_canceled() {
  console.log('\n=== TEST 7: partial_filled_open -> partially_filled_canceled ===');
  await reset();

  const record = {
    client_order_id: 'test7',
    order_id: '0xstu',
    status: 'partial_filled_open',
    size: 2.0,
    executed_size: 1.0,
    original_size: 2.0,
    ack_ts: new Date().toISOString(),
  };

  const result = await reconcileOrderStatus({
    record,
    nowMs: Date.now(),
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: createMockLiveQuery([{ status: 'partially_filled_canceled', executed_size: 1.0, source: 'mock' }]),
    onEvent: mockEvent,
  });

  const pass = result.record?.status === 'partially_filled_canceled' && result.final === true;
  console.log('TEST 7:', pass ? 'PASS ✅' : 'FAIL ❌');
  return pass;
}

async function runAllTests() {
  console.log('========================================');
  console.log('ORDER LIFECYCLE CONVERGENCE TESTS');
  console.log('========================================');
  
  const results = [];
  
  results.push(await test1_acknowledged_to_partially_filled_canceled());
  results.push(await test2_acknowledged_to_filled_after_cancel());
  results.push(await test3_partial_filled_open());
  results.push(await test4_exceeds_threshold());
  results.push(await test5_executed_size_preserved());
  results.push(await test6_partial_open_to_filled());
  results.push(await test7_partial_open_to_partially_filled_canceled());
  
  console.log('\n========================================');
  console.log('SUMMARY');
  console.log('========================================');
  console.log('Passed:', results.filter(r => r).length, '/', results.length);
  
  if (results.every(r => r)) {
    console.log('\n✅ ALL TESTS PASSED - SAFE_FOR_NEXT_CANARY');
    process.exit(0);
  } else {
    console.log('\n❌ SOME TESTS FAILED - NOT_SAFE_YET');
    process.exit(1);
  }
}

runAllTests().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});
