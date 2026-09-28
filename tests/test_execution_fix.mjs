/**
 * Test suite for execution accounting fix
 * Tests MATCHED status parsing, executed_size tracking, and fill-based position
 * 
 * Key: The mock must properly simulate state transitions (acknowledged -> matched)
 */

import { ORDER_STATUS, reconcileOrderStatus, isFinalOrderStatus } from '../src/core/execution/limit_order_executor.mjs';

const eventLog = [];

async function mockEvent(type, data) {
  eventLog.push({ type, data });
  console.log(`  [EVENT] ${type}`);
}

function createStateMachineMock(states) {
  // states is array like: [{status: 'acknowledged'}, {status: 'MATCHED', executed_size: '5', original_size: '5', fill_price: 0.75}]
  let idx = 0;
  return async () => {
    const state = states[idx] || states[states.length - 1];
    // Only advance if not at end
    if (idx < states.length - 1) {
      idx++;
    }
    console.log(`  [MOCK] query #${idx} -> status=${state.status}, executed=${state.executed_size}, original=${state.original_size}`);
    return state;
  };
}

function reset() {
  eventLog.length = 0;
}

// ============ TEST 1: MATCHED fully filled ============
async function test1_MATCHED_fully_filled() {
  console.log('\n========================================');
  console.log('TEST 1: MATCHED fully filled');
  console.log('========================================');
  reset();
  
  // State machine: acknowledged -> MATCHED (full fill)
  const mockQuery = createStateMachineMock([
    { status: 'acknowledged', raw_status: 'acknowledged', source: 'mock' },
    { status: 'MATCHED', raw_status: 'MATCHED', original_size: '5', executed_size: '5', fill_price: 0.75, side: 'BUY', source: 'mock' }
  ]);
  
  const record = {
    client_order_id: 'test1',
    order_id: '0xtest1',
    status: 'acknowledged',
    size: 5,
    ack_ts: new Date().toISOString(),
  };
  
  // First reconcile: acknowledged (no change expected)
  let result = await reconcileOrderStatus({
    record,
    nowMs: Date.now(),
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: mockQuery,
    onEvent: mockEvent,
  });
  
  console.log(`  After reconcile #1: status=${result.status}, executed_size=${result.record?.executed_size}`);
  
  // Second reconcile: MATCHED with full fill
  result = await reconcileOrderStatus({
    record: result.record,
    nowMs: Date.now() + 2000,
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: mockQuery,
    onEvent: mockEvent,
  });
  
  console.log(`  After reconcile #2: status=${result.status}, executed_size=${result.record?.executed_size}`);
  
  // Assertions
  const statusCorrect = result.status === 'filled';
  const executedSizeCorrect = result.record?.executed_size === 5;
  const filledEvent = eventLog.find(e => e.type === 'ORDER_FILLED');
  const filledEventCorrect = !!filledEvent;
  
  console.log('\n--- ASSERTIONS ---');
  console.log(`  status === 'filled': ${statusCorrect} (got: ${result.status})`);
  console.log(`  executed_size === 5: ${executedSizeCorrect} (got: ${result.record?.executed_size})`);
  console.log(`  ORDER_FILLED emitted: ${filledEventCorrect}`);
  
  const pass = statusCorrect && executedSizeCorrect && filledEventCorrect;
  console.log(`\nRESULT: ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
  return pass;
}

// ============ TEST 2: MATCHED partial fill ============
async function test2_MATCHED_partial_fill() {
  console.log('\n========================================');
  console.log('TEST 2: MATCHED partial fill');
  console.log('========================================');
  reset();
  
  const mockQuery = createStateMachineMock([
    { status: 'acknowledged', raw_status: 'acknowledged', source: 'mock' },
    { status: 'MATCHED', raw_status: 'MATCHED', original_size: '5', executed_size: '2.5', fill_price: 0.75, side: 'BUY', source: 'mock' }
  ]);
  
  const record = {
    client_order_id: 'test2',
    order_id: '0xtest2',
    status: 'acknowledged',
    size: 5,
    ack_ts: new Date().toISOString(),
  };
  
  let result = await reconcileOrderStatus({
    record,
    nowMs: Date.now(),
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: mockQuery,
    onEvent: mockEvent,
  });
  
  result = await reconcileOrderStatus({
    record: result.record,
    nowMs: Date.now() + 2000,
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: mockQuery,
    onEvent: mockEvent,
  });
  
  const statusCorrect = result.status === 'partial_filled';
  const executedSizeCorrect = result.record?.executed_size === 2.5;
  const partialEvent = eventLog.find(e => e.type === 'ORDER_PARTIAL_FILLED');
  const partialEventCorrect = !!partialEvent;
  
  console.log('\n--- ASSERTIONS ---');
  console.log(`  status === 'partial_filled': ${statusCorrect} (got: ${result.status})`);
  console.log(`  executed_size === 2.5: ${executedSizeCorrect} (got: ${result.record?.executed_size})`);
  console.log(`  ORDER_PARTIAL_FILLED emitted: ${partialEventCorrect}`);
  
  const pass = statusCorrect && executedSizeCorrect && partialEventCorrect;
  console.log(`\nRESULT: ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
  return pass;
}

// ============ TEST 3: Submit, no fill, then cancel ============
async function test3_no_fill_cancel() {
  console.log('\n========================================');
  console.log('TEST 3: Submit, no fill, then cancel');
  console.log('========================================');
  reset();
  
  const mockQuery = createStateMachineMock([
    { status: 'acknowledged', raw_status: 'acknowledged', source: 'mock' },
    { status: 'canceled', raw_status: 'canceled', original_size: '5', executed_size: '0', source: 'mock' }
  ]);
  
  const record = {
    client_order_id: 'test3',
    order_id: '0xtest3',
    status: 'acknowledged',
    size: 5,
    ack_ts: new Date().toISOString(),
  };
  
  let result = await reconcileOrderStatus({
    record,
    nowMs: Date.now(),
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: mockQuery,
    onEvent: mockEvent,
  });
  
  result = await reconcileOrderStatus({
    record: result.record,
    nowMs: Date.now() + 2000,
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: mockQuery,
    onEvent: mockEvent,
  });
  
  // In this case, status should be 'canceled' but executed_size should remain 0
  const statusCorrect = result.status === 'canceled';
  const executedSizeCorrect = result.record?.executed_size === 0;
  
  console.log('\n--- ASSERTIONS ---');
  console.log(`  status === 'canceled': ${statusCorrect} (got: ${result.status})`);
  console.log(`  executed_size === 0: ${executedSizeCorrect} (got: ${result.record?.executed_size})`);
  
  // For live mode, position should NOT have been opened at submit time
  // The key is that executed_size stays 0, so position = 0
  const pass = statusCorrect && executedSizeCorrect;
  console.log(`\nRESULT: ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
  return pass;
}

// ============ TEST 4: Partial fill then cancel remainder ============
async function test4_partial_fill_then_cancel() {
  console.log('\n========================================');
  console.log('TEST 4: Partial fill then cancel remainder');
  console.log('========================================');
  reset();
  
  const mockQuery = createStateMachineMock([
    { status: 'acknowledged', raw_status: 'acknowledged', source: 'mock' },
    { status: 'MATCHED', raw_status: 'MATCHED', original_size: '5', executed_size: '2', fill_price: 0.75, side: 'BUY', source: 'mock' },
    { status: 'canceled', raw_status: 'canceled', original_size: '5', executed_size: '2', source: 'mock' }
  ]);
  
  const record = {
    client_order_id: 'test4',
    order_id: '0xtest4',
    status: 'acknowledged',
    size: 5,
    ack_ts: new Date().toISOString(),
  };
  
  // First: partial fill
  let result = await reconcileOrderStatus({
    record,
    nowMs: Date.now(),
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: mockQuery,
    onEvent: mockEvent,
  });
  
  console.log(`  After reconcile #1: status=${result.status}, executed=${result.record?.executed_size}`);
  
  // Second: cancel
  result = await reconcileOrderStatus({
    record: result.record,
    nowMs: Date.now() + 2000,
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: mockQuery,
    onEvent: mockEvent,
  });
  
  console.log(`  After reconcile #2: status=${result.status}, executed=${result.record?.executed_size}`);
  
  // After partial fill, when cancel happens, the status should be partial_filled (not partially_filled_canceled)
  // partially_filled_canceled is only for LATE FILL AFTER CANCEL (fill happened after cancel request)
  // Here, cancel happened AFTER the partial fill was already known, so status = partial_filled
  const statusCorrect = result.status === 'partial_filled';
  const executedSizeCorrect = result.record?.executed_size === 2;
  
  console.log('\n--- ASSERTIONS ---');
  console.log(`  status === 'partial_filled': ${statusCorrect} (got: ${result.status})`);
  console.log(`  executed_size === 2: ${executedSizeCorrect} (got: ${result.record?.executed_size})`);
  
  const pass = statusCorrect && executedSizeCorrect;
  console.log(`\nRESULT: ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
  return pass;
}

// ============ TEST 5: Restart after partial fill ============
async function test5_restart_after_partial_fill() {
  console.log('\n========================================');
  console.log('TEST 5: Restart after partial fill');
  console.log('========================================');
  reset();
  
  // Simulate restarting with an order that was partially filled before shutdown
  // When we reconcile, we should find executed_size = 2 and status = partial_filled
  const mockQuery = createStateMachineMock([
    { status: 'MATCHED', raw_status: 'MATCHED', original_size: '5', executed_size: '2', fill_price: 0.75, side: 'BUY', source: 'mock' }
  ]);
  
  // Record loaded from previous state - was acknowledged before shutdown
  const record = {
    client_order_id: 'test5',
    order_id: '0xtest5',
    status: 'acknowledged',  // Status before restart
    size: 5,
    ack_ts: new Date(Date.now() - 60000).toISOString(),  // Acknowledged 60s ago
  };
  
  // After restart, reconcile should discover the actual executed_size from exchange
  let result = await reconcileOrderStatus({
    record,
    nowMs: Date.now(),
    unresolvedMsLimit: 1000,
    dryRun: false,
    liveQuery: mockQuery,
    onEvent: mockEvent,
  });
  
  console.log(`  After restart reconcile: status=${result.status}, executed=${result.record?.executed_size}`);
  
  // Should now correctly show partial_filled with executed_size = 2
  const statusCorrect = result.status === 'partial_filled';
  const executedSizeCorrect = result.record?.executed_size === 2;
  
  console.log('\n--- ASSERTIONS ---');
  console.log(`  status === 'partial_filled': ${statusCorrect} (got: ${result.status})`);
  console.log(`  executed_size === 2: ${executedSizeCorrect} (got: ${result.record?.executed_size})`);
  
  // The key: position should be based on executed_size (2), not original size (5)
  // This proves no false non-flat exposure from submitted-but-unfilled orders
  const pass = statusCorrect && executedSizeCorrect;
  console.log(`\nRESULT: ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
  return pass;
}

// ============ RUN ALL TESTS ============
async function runAllTests() {
  console.log('========================================');
  console.log('EXECUTION ACCOUNTING FIX - TEST SUITE');
  console.log('========================================');
  
  const results = [];
  
  results.push(await test1_MATCHED_fully_filled());
  results.push(await test2_MATCHED_partial_fill());
  results.push(await test3_no_fill_cancel());
  results.push(await test4_partial_fill_then_cancel());
  results.push(await test5_restart_after_partial_fill());
  
  console.log('\n========================================');
  console.log('SUMMARY');
  console.log('========================================');
  const passed = results.filter(r => r).length;
  console.log(`Passed: ${passed} / ${results.length}`);
  
  if (results.every(r => r)) {
    console.log('\n✅ ALL TESTS PASSED - READY_FOR_NEXT_CANARY');
    process.exit(0);
  } else {
    console.log('\n❌ SOME TESTS FAILED - NOT_READY_YET');
    process.exit(1);
  }
}

runAllTests().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});
