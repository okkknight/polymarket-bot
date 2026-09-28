import { isFinalOrderStatus, reconcileOrderStatus, ORDER_STATUS } from './limit_order_executor.mjs';
import { createLiveExecutionGateway } from './live_execution_gateway.mjs';
import { RUNTIME_STATE, ensureRuntimeStateFields, setRuntimeState } from '../state/runtime_state_controller.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getReconcileConfig() {
  return {
    graceSec: Math.max(1, Number(process.env.RECONCILE_GRACE_SEC || 30)),
    intervalSec: Math.max(1, Number(process.env.RECONCILE_INTERVAL_SEC || 10)),
    maxRetry: Math.max(1, Number(process.env.RECONCILE_MAX_RETRY || 3)),
  };
}

function isRetryableReconcileReason(reason) {
  const normalized = String(reason || '').toLowerCase();
  return (
    normalized === 'exchange_reconciliation_mismatch' ||
    normalized === 'position_mismatch' ||
    normalized === 'unconfirmed_recovered_holdings' ||
    normalized === 'unconfirmed_recovered_holdings_exist' ||
    normalized === 'inconsistent_order_state'
  );
}

async function runBoundedReconcileLoop({
  state,
  reason,
  detail = {},
  onEvent = async () => {},
  attemptFn = async () => ({ ok: true }),
}) {
  ensureRuntimeStateFields(state);
  const cfg = getReconcileConfig();
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const mismatchReason = String(reason || 'reconcile_mismatch');

  setRuntimeState(state, RUNTIME_STATE.RECONCILING, { reason: mismatchReason });
  state.reconcile.max_retry = cfg.maxRetry;
  state.reconcile.interval_sec = cfg.intervalSec;
  state.reconcile.grace_sec = cfg.graceSec;
  state.reconcile.retry_count = 0;
  state.reconcile.started_at = startedAtIso;
  state.reconcile.last_error = null;

  await onEvent('RECONCILE_STARTED', {
    reason: mismatchReason,
    started_at: startedAtIso,
    grace_sec: cfg.graceSec,
    interval_sec: cfg.intervalSec,
    max_retry: cfg.maxRetry,
    ...detail,
  });

  let lastResult = null;
  let retriesPerformed = 0;
  let lastReason = mismatchReason;

  while (retriesPerformed < cfg.maxRetry) {
    retriesPerformed += 1;
    state.reconcile.retry_count = retriesPerformed;
    state.reconcile.last_retry_at = new Date().toISOString();

    await onEvent('RECONCILE_RETRY', {
      reason: mismatchReason,
      retry_count: retriesPerformed,
      max_retry: cfg.maxRetry,
      interval_sec: cfg.intervalSec,
      elapsed_sec: Number(((Date.now() - startedAtMs) / 1000).toFixed(3)),
      ...detail,
    });

    await sleep(cfg.intervalSec * 1000);

    try {
      lastResult = await attemptFn({ retryCount: retriesPerformed, config: cfg });
    } catch (e) {
      lastResult = { ok: false, reason: String(e?.message || e) };
    }

    if (lastResult?.ok) {
      setRuntimeState(state, RUNTIME_STATE.RUNNING);
      state.reconcile.last_success_at = new Date().toISOString();
      await onEvent('RECONCILE_SUCCESS', {
        reason: mismatchReason,
        retry_count: retriesPerformed,
        max_retry: cfg.maxRetry,
        elapsed_sec: Number(((Date.now() - startedAtMs) / 1000).toFixed(3)),
        ...detail,
      });
      return { ok: true, result: lastResult, retriesPerformed };
    }

    lastReason = String(lastResult?.reason || lastReason || mismatchReason);
    state.reconcile.last_error = lastReason;

    const elapsedSec = (Date.now() - startedAtMs) / 1000;
    if (elapsedSec >= cfg.graceSec) break;
  }

  setRuntimeState(state, RUNTIME_STATE.HALTED, { reason: lastReason || mismatchReason });
  await onEvent('RECONCILE_FAILED_HALTING', {
    reason: lastReason || mismatchReason,
    retry_count: retriesPerformed,
    max_retry: cfg.maxRetry,
    interval_sec: cfg.intervalSec,
    grace_sec: cfg.graceSec,
    elapsed_sec: Number(((Date.now() - startedAtMs) / 1000).toFixed(3)),
    ...detail,
  });

  return {
    ok: false,
    reason: lastReason || mismatchReason,
    result: lastResult,
    retriesPerformed,
  };
}

export async function rebuildStateFromExchange({
  state,
  liveGateway,
  onEvent = async () => {},
}) {
  ensureRuntimeStateFields(state);

  const initial = await rebuildStateFromExchangeOnce({
    state,
    liveGateway,
    onEvent,
  });

  if (initial?.ok) {
    setRuntimeState(state, RUNTIME_STATE.RUNNING);
    return initial;
  }

  const initialReason = String(initial?.reason || 'exchange_reconciliation_failed');
  if (!isRetryableReconcileReason(initialReason)) {
    setRuntimeState(state, RUNTIME_STATE.HALTED, { reason: initialReason });
    return { ...initial, ok: false, halted: true, reason: initialReason };
  }

  const bounded = await runBoundedReconcileLoop({
    state,
    reason: initialReason,
    onEvent,
    detail: {
      mismatch_type: 'position_mismatch',
      source: 'startup_exchange_reconciliation',
    },
    attemptFn: async () => {
      const retried = await rebuildStateFromExchangeOnce({
        state,
        liveGateway,
        onEvent,
      });
      return {
        ok: Boolean(retried?.ok),
        reason: retried?.reason || null,
        payload: retried,
      };
    },
  });

  if (bounded.ok) {
    return bounded.result?.payload || initial;
  }

  const failedPayload = bounded.result?.payload || initial;
  return {
    ...failedPayload,
    ok: false,
    halted: true,
    reason: bounded.reason || failedPayload.reason || initialReason,
  };
}

async function rebuildStateFromExchangeOnce({
  state,
  liveGateway,
  onEvent = async () => {},
}) {
  await onEvent('EXCHANGE_RECONCILIATION_STARTED', {
    local_intents_count: Object.keys(state.intents || {}).length,
  });

  // 1. Query exchange open orders (with retry)
  const maxAttempts = Number(process.env.EXPOSURE_SYNC_MAX_RETRIES || 3);
  let openOrdersResult = { orders: [], reason: 'query_unknown', source: 'unknown' };
  let exchangeOpenOrders = [];
  
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
    openOrdersResult = await liveGateway.getOpenOrders();
    exchangeOpenOrders = openOrdersResult.orders || [];
    
    await onEvent('EXCHANGE_OPEN_ORDERS_QUERY_ATTEMPT', {
      attempt,
      max_attempts: Math.max(1, maxAttempts),
      ok: !openOrdersResult?.reason,
      source: openOrdersResult.source || 'unknown',
      reason: openOrdersResult.reason,
      count: exchangeOpenOrders.length,
      bridge_elapsed_ms: openOrdersResult.bridge_elapsed_ms,
    });
    
    if (!openOrdersResult?.reason) break;
    if (attempt < Math.max(1, maxAttempts)) await sleep(1000 * attempt);
  }
  
  await onEvent('EXCHANGE_OPEN_ORDERS_QUERY', {
    count: exchangeOpenOrders.length,
    source: openOrdersResult.source || 'unknown',
    reason: openOrdersResult.reason,
  });
  if (openOrdersResult?.reason) {
    await onEvent('EXCHANGE_RECONCILIATION_FAILED', {
      reason: 'exchange_open_orders_query_failed',
      detail: openOrdersResult.reason,
      action: 'SAFE_HALT',
    });
    return {
      ok: false,
      halted: true,
      reason: 'exchange_open_orders_query_failed',
      rebuiltIntents: state.intents || {},
      rebuiltIndex: state.intent_index || {},
    };
  }

  // 2. Query exchange positions (with retry)
  let positionsResult = { positions: [], reason: 'query_unknown', source: 'unknown' };
  let exchangePositions = [];
  
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
    positionsResult = await liveGateway.getPositions();
    exchangePositions = positionsResult.positions || [];
    
    await onEvent('EXCHANGE_POSITIONS_QUERY_ATTEMPT', {
      attempt,
      max_attempts: Math.max(1, maxAttempts),
      ok: !positionsResult?.reason,
      source: positionsResult.source || 'unknown',
      reason: positionsResult.reason,
      count: exchangePositions.length,
      bridge_elapsed_ms: positionsResult.bridge_elapsed_ms,
    });
    
    if (!positionsResult?.reason) break;
    if (attempt < Math.max(1, maxAttempts)) await sleep(1000 * attempt);
  }
  
  await onEvent('EXCHANGE_POSITIONS_QUERY', {
    count: exchangePositions.length,
    source: positionsResult.source || 'unknown',
    reason: positionsResult.reason,
  });
  if (positionsResult?.reason) {
    await onEvent('EXCHANGE_RECONCILIATION_FAILED', {
      reason: 'exchange_positions_query_failed',
      detail: positionsResult.reason,
      action: 'SAFE_HALT',
    });
    return {
      ok: false,
      halted: true,
      reason: 'exchange_positions_query_failed',
      rebuiltIntents: state.intents || {},
      rebuiltIndex: state.intent_index || {},
    };
  }

  // 3. Rebuild local state from exchange data
  const rebuiltIntents = {};
  const rebuiltIndex = {};

  for (const exchOrder of exchangeOpenOrders) {
    const clientOrderId = exchOrder.client_order_id || exchOrder.orderID;
    if (!clientOrderId) continue;
    
    rebuiltIntents[clientOrderId] = {
      client_order_id: clientOrderId,
      order_id: exchOrder.order_id || exchOrder.orderID || clientOrderId,
      market_id: exchOrder.market_id || '',
      token_id: exchOrder.token_id || '',
      side: exchOrder.side || 'buy',
      size: Number(exchOrder.size) || 0,
      limit_price: Number(exchOrder.price || exchOrder.limit_price) || 0,
      status: normalizeExchangeStatus(exchOrder.status),
      status_ts: exchOrder.status_ts || new Date().toISOString(),
      fill_price: exchOrder.fill_price,
      fill_size: exchOrder.fill_size,
    };
    rebuiltIndex[clientOrderId] = normalizeExchangeStatus(exchOrder.status);
  }

  // 4. Compare with stored state
  const localIntents = state.intents || {};
  const localKeys = new Set(Object.keys(localIntents));
  const rebuiltKeys = new Set(Object.keys(rebuiltIntents));

  const onlyLocal = [...localKeys].filter(k => !rebuiltKeys.has(k));
  const onlyExchange = [...rebuiltKeys].filter(k => !localKeys.has(k));
  const common = [...localKeys].filter(k => rebuiltKeys.has(k));

  let mismatches = 0;
  for (const k of common) {
    const local = localIntents[k];
    const exch = rebuiltIntents[k];
    if (local?.status !== exch?.status) {
      mismatches += 1;
    }
  }

  await onEvent('EXCHANGE_RECONCILIATION_COMPARE', {
    only_local_count: onlyLocal.length,
    only_exchange_count: onlyExchange.length,
    common_count: common.length,
    mismatches: mismatches,
    local_keys: onlyLocal.slice(0, 10),
    exchange_keys: onlyExchange.slice(0, 10),
  });

  // 5. If mismatch -> bounded reconciliation in caller
  if (mismatches > 0 || onlyLocal.length > 0 || onlyExchange.length > 0) {
    await onEvent('EXCHANGE_RECONCILIATION_MISMATCH', {
      mismatches,
      only_local: onlyLocal.length,
      only_exchange: onlyExchange.length,
      action: 'RECONCILE',
    });
    return {
      ok: false,
      halted: true,
      reason: 'exchange_reconciliation_mismatch',
      rebuiltIntents,
      rebuiltIndex,
    };
  }

  // 6. Success: update state with exchange data
  await onEvent('EXCHANGE_RECONCILIATION_SUCCESS', {
    reconciled_orders: Object.keys(rebuiltIntents).length,
  });

  return {
    ok: true,
    halted: false,
    reason: null,
    rebuiltIntents,
    rebuiltIndex,
  };
}

function normalizeExchangeStatus(s) {
  if (!s) return ORDER_STATUS.NEW;
  const v = String(s).toLowerCase();
  if (v === 'filled' || v === 'matched') return ORDER_STATUS.FILLED;
  if (v === 'canceled' || v === 'cancelled') return ORDER_STATUS.CANCELED;
  if (v === 'rejected') return ORDER_STATUS.REJECTED;
  if (v === 'expired') return ORDER_STATUS.EXPIRED;
  if (v === 'partial' || v === 'partially_filled') return ORDER_STATUS.PARTIAL_FILLED;
  if (v === 'acknowledged' || v === 'open' || v === 'live') return ORDER_STATUS.ACKNOWLEDGED;
  return ORDER_STATUS.NEW;
}

function hasBotOwnedCancelEvidence(state, record) {
  const clientOrderId = String(record?.client_order_id || '').trim();
  const orderId = String(record?.order_id || '').trim();
  if (!clientOrderId || !orderId) return false;

  const localIntent = state?.intents?.[clientOrderId];
  const localOrder = state?.orders?.[clientOrderId];
  return Boolean(
    localIntent &&
    String(localIntent.order_id || '').trim() === orderId &&
    localOrder &&
    String(localOrder.order_id || '').trim() === orderId &&
    String(localOrder.source || '').toLowerCase() === 'live_submit',
  );
}

async function attemptRecoveryCancellation({ state, record, liveCancel, persistState, onEvent }) {
  if (!hasBotOwnedCancelEvidence(state, record)) {
    await onEvent('RECOVERY_CANCEL_SKIPPED', {
      client_order_id: record?.client_order_id || null,
      order_id: record?.order_id || null,
      reason: 'bot_ownership_unverified',
    });
    return { eligible: false, ok: false, reason: 'recovery_cancel_ownership_unverified', record };
  }

  if (typeof liveCancel !== 'function') {
    await onEvent('RECOVERY_CANCEL_SKIPPED', {
      client_order_id: record.client_order_id,
      order_id: record.order_id,
      reason: 'live_cancel_unavailable',
    });
    return { eligible: true, ok: false, reason: 'recovery_live_cancel_unavailable', record };
  }

  const priorAttempt = record.cancel_attempt?.status;
  if (priorAttempt === 'attempted' || priorAttempt === 'unknown') {
    await onEvent('RECOVERY_CANCEL_SKIPPED', {
      client_order_id: record.client_order_id,
      order_id: record.order_id,
      reason: 'prior_cancel_outcome_unresolved',
    });
    return { eligible: true, ok: false, reason: 'recovery_cancel_outcome_unresolved', record };
  }

  const attemptedAt = new Date().toISOString();
  record.cancel_attempt = { status: 'attempted', attempted_at: attemptedAt };
  await persistState(state);
  await onEvent('RECOVERY_CANCEL_ATTEMPTED', {
    client_order_id: record.client_order_id,
    order_id: record.order_id,
    attempted_at: attemptedAt,
  });

  try {
    const result = await liveCancel(record);
    const status = normalizeExchangeStatus(result?.status);
    if (status !== ORDER_STATUS.CANCELED) {
      record.cancel_attempt = {
        status: 'unknown',
        attempted_at: attemptedAt,
        response_status: result?.status || null,
      };
      await persistState(state);
      await onEvent('RECOVERY_CANCEL_AMBIGUOUS', {
        client_order_id: record.client_order_id,
        order_id: record.order_id,
        response_status: result?.status || null,
      });
      return { eligible: true, ok: false, reason: 'recovery_cancel_ambiguous', record };
    }

    const confirmedAt = new Date().toISOString();
    record.status = ORDER_STATUS.CANCELED;
    record.status_ts = confirmedAt;
    record.cancel_requested_at = Date.now();
    record.cancel_attempt = {
      status: 'confirmed',
      attempted_at: attemptedAt,
      confirmed_at: confirmedAt,
      source: result?.source || null,
    };
    await persistState(state);
    await onEvent('RECOVERY_CANCEL_CONFIRMED', {
      client_order_id: record.client_order_id,
      order_id: record.order_id,
      source: result?.source || null,
    });
    return { eligible: true, ok: true, record };
  } catch (error) {
    record.cancel_attempt = {
      status: 'unknown',
      attempted_at: attemptedAt,
      error: String(error?.message || error),
    };
    await persistState(state);
    await onEvent('RECOVERY_CANCEL_AMBIGUOUS', {
      client_order_id: record.client_order_id,
      order_id: record.order_id,
      error: String(error?.message || error),
    });
    return { eligible: true, ok: false, reason: 'recovery_cancel_ambiguous', record };
  }
}

export async function runRecoverySequence({
  state,
  unresolvedMsLimit = 10000,
  dryRun = true,
  liveCancel = null,
  liveGateway = null,
  persistState = async () => {},
  onEvent = async () => {},
}) {
  ensureRuntimeStateFields(state);
  const intents = state?.intents || {};
  const keys = Object.keys(intents);

  await onEvent('RECOVERY_STARTED', {
    halted: Boolean(state?.halted),
    halt_reason: state?.halt_reason || null,
    runtime_state: state?.runtime_state || RUNTIME_STATE.RUNNING,
    intents_count: keys.length,
    dry_run: dryRun,
  });

  // === STEP 1: Exposure Ledger Sync (NEW) ===
  if (!liveGateway) {
    liveGateway = createLiveExecutionGateway?.();
  }

  if (!dryRun) {
    const hasLiveRecoveryMethods = Boolean(
      liveGateway &&
      typeof liveGateway.getPositions === 'function' &&
      typeof liveGateway.queryOrderStatus === 'function'
    );
    if (!hasLiveRecoveryMethods) {
      await onEvent('RECOVERY_FAILED', {
        reason: 'missing_live_gateway',
        action: 'SAFE_HALT',
      });
      setRuntimeState(state, RUNTIME_STATE.HALTED, { reason: 'missing_live_gateway' });
      return { ok: false, resumed: false, reason: 'missing_live_gateway', state };
    }
  }
  
  if (liveGateway?.getPositions) {
    let exposureResult = await syncExposureLedgerFromExchange({
      state,
      liveGateway,
      onEvent,
    });

    if (!exposureResult.ok && isRetryableReconcileReason(exposureResult.reason)) {
      const boundedExposure = await runBoundedReconcileLoop({
        state,
        reason: exposureResult.reason,
        onEvent,
        detail: {
          mismatch_type: 'unconfirmed_recovered_holdings',
          source: 'recovery_exposure_sync',
        },
        attemptFn: async () => {
          const retried = await syncExposureLedgerFromExchange({
            state,
            liveGateway,
            onEvent,
          });
          return {
            ok: Boolean(retried?.ok),
            reason: retried?.reason || null,
            payload: retried,
          };
        },
      });

      exposureResult = boundedExposure.result?.payload || exposureResult;
    }
    
    if (!exposureResult.ok) {
      // Safe halt if mismatch persists across bounded retries.
      setRuntimeState(state, RUNTIME_STATE.HALTED, {
        reason: exposureResult.reason || 'exposure_sync_failed',
      });
      state.exposure_ledger = state.exposure_ledger || {};
      state.exposure_ledger.holdings = exposureResult.holdings;
      state.exposure_ledger.avg_prices = exposureResult.avgPrices;
      state.exposure_ledger.source_by_asset = exposureResult.sourceByAsset;
      state.exposure_ledger.synced_at = exposureResult.syncedAt;
      state.exposure_ledger.unmanaged_count = exposureResult.unmanagedCount;
      
      await onEvent('RECOVERY_FAILED', {
        reason: exposureResult.reason,
        action: 'SAFE_HALT',
        unmanaged_count: exposureResult.unmanagedCount,
      });
      
      return {
        ok: false,
        resumed: false,
        reason: exposureResult.reason,
        state,
      };
    }
    
    // Apply synced holdings
    state.exposure_ledger = state.exposure_ledger || {};
    state.exposure_ledger.holdings = exposureResult.holdings;
    state.exposure_ledger.avg_prices = exposureResult.avgPrices;
    state.exposure_ledger.source_by_asset = exposureResult.sourceByAsset;
    state.exposure_ledger.synced_at = exposureResult.syncedAt;
    state.exposure_ledger.last_reconcile_ts = exposureResult.syncedAt;
  }

  // === STEP 2: Order Lifecycle Reconciliation ===

  let allConsistent = true;
  let failureReason = null;

  for (const k of keys) {
    const rec = state.intents?.[k] || intents[k];
    let check = await reconcileOrderStatus({
      record: rec,
      unresolvedMsLimit,
      dryRun,
      liveQuery: liveGateway?.queryOrderStatus,
      onEvent,
      boundedRetryEnabled: false,
    });

    if (check.record?.client_order_id) {
      state.intents[check.record.client_order_id] = check.record;
      state.intent_index = state.intent_index || {};
      state.intent_index[check.record.client_order_id] = check.record.status || 'acknowledged';
    }

    if (!check.ok && isRetryableReconcileReason(check.haltReason)) {
      if (!dryRun) {
        const cancellation = await attemptRecoveryCancellation({
          state,
          record: check.record || rec,
          liveCancel,
          persistState,
          onEvent,
        });
        if (cancellation.record?.client_order_id) {
          state.intents[cancellation.record.client_order_id] = cancellation.record;
          state.intent_index = state.intent_index || {};
          state.intent_index[cancellation.record.client_order_id] = cancellation.record.status || 'acknowledged';
        }
        if (cancellation.ok) {
          check = {
            ok: true,
            final: true,
            status: cancellation.record.status,
            record: cancellation.record,
            converged: true,
          };
        } else {
          check = {
            ok: false,
            record: cancellation.record || check.record,
            haltReason: cancellation.reason,
          };
        }
      }

      if (!check.ok && !dryRun) {
        failureReason = check.haltReason || check.reason || 'recovery_cancel_failed';
      } else if (!check.ok) {
      const recClientId = check.record?.client_order_id || rec?.client_order_id || null;
      const recOrderId = check.record?.order_id || rec?.order_id || null;
      const boundedOrder = await runBoundedReconcileLoop({
        state,
        reason: check.haltReason || 'inconsistent_order_state',
        onEvent,
        detail: {
          mismatch_type: 'unresolved_order_state',
          client_order_id: recClientId,
          order_id: recOrderId,
          source: 'recovery_order_reconcile',
        },
        attemptFn: async () => {
          const baseRecord = recClientId ? (state.intents?.[recClientId] || check.record || rec) : (check.record || rec);
          const retried = await reconcileOrderStatus({
            record: baseRecord,
            unresolvedMsLimit,
            dryRun,
            liveQuery: liveGateway?.queryOrderStatus,
            onEvent,
            boundedRetryEnabled: false,
          });

          if (retried.record?.client_order_id) {
            state.intents[retried.record.client_order_id] = retried.record;
            state.intent_index = state.intent_index || {};
            state.intent_index[retried.record.client_order_id] = retried.record.status || 'acknowledged';
          }

          return {
            ok: Boolean(retried?.ok),
            reason: retried?.haltReason || retried?.reason || null,
            payload: retried,
          };
        },
      });

      check = boundedOrder.result?.payload || check;
      if (!boundedOrder.ok) {
        failureReason =
          check?.haltReason ||
          check?.reason ||
          boundedOrder.reason ||
          'reconcile_failed';
      }
      }
    }

    if (!check.ok) {
      allConsistent = false;
      failureReason = failureReason || check.haltReason || check.reason || 'reconcile_failed';
      state.halt_reason = failureReason;
      await onEvent('RECOVERY_FAILED', {
        client_order_id: rec?.client_order_id,
        reason: failureReason,
      });
      break;
    }
  }

  if (!allConsistent) {
    const haltReason = failureReason || state.halt_reason || 'recovery_failed';
    setRuntimeState(state, RUNTIME_STATE.HALTED, { reason: haltReason });
    return { ok: false, resumed: false, reason: haltReason, state };
  }

  // resume gate: all orders must be final or no orders at all
  const nonFinal = Object.values(state.intents || {}).filter((r) => !isFinalOrderStatus(r?.status));
  if (nonFinal.length > 0) {
    setRuntimeState(state, RUNTIME_STATE.HALTED, { reason: 'recovery_incomplete_non_final_orders' });
    await onEvent('RECOVERY_BLOCKED', {
      reason: 'recovery_incomplete_non_final_orders',
      non_final_count: nonFinal.length,
    });
    return { ok: false, resumed: false, reason: 'recovery_incomplete_non_final_orders', state };
  }

  setRuntimeState(state, RUNTIME_STATE.RUNNING);
  
  // === CRITICAL FIX: Also update order ledger from recovered state ===
  // Ensure all orders (including those filled while offline) have persistent records
  state.orders = state.orders || {};
  const intentsList = state.intents || {};
  const now = new Date().toISOString();
  
  for (const [clientOrderId, order] of Object.entries(intentsList)) {
    if (!state.orders[clientOrderId]) {
      // Create order ledger entry from intents if not exists
      state.orders[clientOrderId] = {
        order_id: order.order_id || clientOrderId,
        client_order_id: clientOrderId,
        asset_id: order.token_id || order.asset_id || '',
        market_id: order.market_id || '',
        side: order.side || 'buy',
        price: order.limit_price || order.price || 0,
        size: order.size || 0,
        normalized_status: order.status || 'unknown',
        executed_size: order.executed_size || order.fill_size || 0,
        remaining_size: (order.size || 0) - (order.executed_size || order.fill_size || 0),
        created_at: order.created_at || order.status_ts || now,
        updated_at: now,
        finalized_at: order.lifecycle_finalized_at || null,
        final_state: isFinalOrderStatus(order.status) ? order.status : null,
        final_reason: order.lifecycle_resolution_reason || (isFinalOrderStatus(order.status) ? order.status : null),
        source: 'recovery_recovered',
        run_id: order.run_id || 'unknown',
      };
    } else {
      // Update existing order record with latest status
      const existing = state.orders[clientOrderId];
      existing.normalized_status = order.status || existing.normalized_status;
      existing.executed_size = order.executed_size || order.fill_size || existing.executed_size;
      existing.remaining_size = (order.size || existing.size || 0) - (order.executed_size || order.fill_size || 0);
      existing.updated_at = now;
      if (isFinalOrderStatus(order.status)) {
        existing.final_state = order.status;
        existing.final_reason = order.lifecycle_resolution_reason || order.status;
        existing.finalized_at = order.lifecycle_finalized_at || now;
      }
    }
  }
  
  // Also check for any exchange positions that don't have corresponding order records
  // These are fills that happened while the bot was offline
  const exposureHoldings = state.exposure_ledger?.holdings || {};
  const trackedAssets = new Set(Object.keys(exposureHoldings));
  const orderedAssets = new Set(Object.values(state.orders || {}).map(o => o.asset_id).filter(Boolean));
  
  for (const assetId of trackedAssets) {
    if (!orderedAssets.has(assetId) && exposureHoldings[assetId] !== 0) {
      // This is a fill from offline - create a recovered order record
      const recoveryClientId = `recovery_${assetId}_${Date.now()}`;
      state.orders[recoveryClientId] = {
        order_id: `recovered_${assetId}`,
        client_order_id: recoveryClientId,
        asset_id: assetId,
        market_id: '',
        side: exposureHoldings[assetId] > 0 ? 'buy' : 'sell',
        price: state.exposure_ledger?.avg_prices?.[assetId] || 0,
        size: Math.abs(exposureHoldings[assetId]),
        normalized_status: 'filled',
        executed_size: Math.abs(exposureHoldings[assetId]),
        remaining_size: 0,
        created_at: now,
        updated_at: now,
        finalized_at: now,
        final_state: 'filled',
        final_reason: 'exchange_recovered_fill',
        source: 'recovery_recovered',
        run_id: 'offline_fill_recovery',
      };
      await onEvent('RECOVERY_ORDER_LEDGER_CREATED', {
        asset_id: assetId,
        client_order_id: recoveryClientId,
        executed_size: exposureHoldings[assetId],
      });
    }
  }
  
  await onEvent('RECOVERY_ORDER_LEDGER_SYNC', {
    orders_count: Object.keys(state.orders || {}).length,
    recovered_fills: Object.keys(state.orders || {}).filter(k => state.orders[k].source === 'recovery_recovered').length,
  });
  
  await onEvent('RECOVERY_RESUMED', {
    reason: 'all_orders_final_and_state_consistent',
    intents_count: Object.keys(state.intents || {}).length,
    runtime_state: state.runtime_state,
  });
  return { ok: true, resumed: true, state };
}

/**
 * Sync exposure ledger from exchange holdings
 * Required startup: for rebuilds holdings from exchange truth
 */
export async function syncExposureLedgerFromExchange({
  state,
  liveGateway,
  onEvent = async () => {},
}) {
  await onEvent('EXPOSURE_SYNC_STARTED', {
    existing_holdings_count: Object.keys(state.exposure_ledger?.holdings || {}).length,
    env_proxy: {
      node_use_env_proxy: process.env.NODE_USE_ENV_PROXY || null,
      https_proxy: process.env.HTTPS_PROXY || process.env.https_proxy || null,
      http_proxy: process.env.HTTP_PROXY || process.env.http_proxy || null,
      all_proxy: process.env.ALL_PROXY || process.env.all_proxy || null,
      no_proxy: process.env.NO_PROXY || process.env.no_proxy || null,
    },
  });

  // 1. Query exchange positions/holdings (with retry + fallback source logging)
  const maxAttempts = Number(process.env.EXPOSURE_SYNC_MAX_RETRIES || 3);
  let positionsResult = { positions: [], reason: 'query_unknown', source: 'unknown' };

  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
    positionsResult = await liveGateway.getPositions();
    const isOk = !positionsResult?.reason;

    await onEvent('EXPOSURE_SYNC_EXCHANGE_QUERY_ATTEMPT', {
      attempt,
      max_attempts: Math.max(1, maxAttempts),
      ok: isOk,
      source: positionsResult?.source || 'unknown',
      reason: positionsResult?.reason,
      detail: positionsResult?.detail,
      bridge_elapsed_ms: positionsResult?.bridge_elapsed_ms,
      bridge_timeout_ms: positionsResult?.bridge_timeout_ms,
      timing_ms: positionsResult?.timing_ms,
      counts: positionsResult?.counts,
    });

    if (isOk) break;

    if (attempt < Math.max(1, maxAttempts)) {
      const backoffMs = Math.min(1000 * (2 ** (attempt - 1)), 5000);
      await sleep(backoffMs);
    }
  }

  const exchangePositions = positionsResult.positions || [];

  await onEvent('EXPOSURE_SYNC_EXCHANGE_QUERY', {
    positions_count: exchangePositions.length,
    source: positionsResult.source || 'unknown',
    reason: positionsResult.reason,
    detail: positionsResult.detail,
    retries: Math.max(1, maxAttempts),
  });

  if (positionsResult?.reason) {
    await onEvent('RECOVERY_FAILED', {
      reason: 'exposure_exchange_query_failed',
      detail: positionsResult.detail || positionsResult.reason,
      action: 'SAFE_HALT',
    });
    return {
      ok: false,
      halted: true,
      reason: 'exposure_exchange_query_failed',
      detail: positionsResult.detail || positionsResult.reason,
      holdings: state.exposure_ledger?.holdings || {},
      avgPrices: state.exposure_ledger?.avg_prices || {},
      sourceByAsset: state.exposure_ledger?.source_by_asset || {},
      lifecycleByAsset: state.exposure_ledger?.lifecycle_by_asset || {},
      syncedAt: new Date().toISOString(),
      unconfirmedCount: 0,
      managedCount: 0,
      confirmedCount: 0,
    };
  }

  // 2. Build holdings from exchange
  const holdings = {};
  const avgPrices = {};
  const sourceByAsset = {};
  const lifecycleByAsset = {};

  // Build bot-origin evidence set for automatic low-risk adoption
  const botEvidenceAssets = new Set();
  for (const rec of Object.values(state.orders || {})) {
    const asset = rec?.asset_id || rec?.token_id;
    if (!asset) continue;
    const executed = Number(rec?.executed_size || 0);
    const source = String(rec?.source || '').toLowerCase();
    // Conservative evidence: require executed_size > 0. Do not auto-adopt on submit-only records.
    if (executed > 0 || (source === 'recovery_recovered' && executed > 0)) {
      botEvidenceAssets.add(String(asset));
    }
  }
  for (const rec of Object.values(state.intents || {})) {
    const asset = rec?.asset_id || rec?.token_id;
    if (!asset) continue;
    const executed = Number(rec?.executed_size || 0);
    if (executed > 0) botEvidenceAssets.add(String(asset));
  }

  // Enrich bot evidence using recent exchange trades matched by known order_id.
  // This closes the gap where submit returned canceled/new, but exchange filled later.
  let recentTradesScanned = 0;
  let recentTradesMatchedOrders = 0;
  let recentTradesBackfilledExecutions = 0;
  if (typeof liveGateway?.getRecentTrades === 'function') {
    const tradesLimit = Number(process.env.EXPOSURE_SYNC_RECENT_TRADES_LIMIT || 300);
    const recentTradesResult = await liveGateway.getRecentTrades(tradesLimit);
    if (!recentTradesResult?.reason) {
      const trades = Array.isArray(recentTradesResult?.trades) ? recentTradesResult.trades : [];
      recentTradesScanned = trades.length;

      const tradesByOrderAndAsset = new Map();
      const traderEvidenceByAsset = new Map();
      const accountOwner = String(process.env.POLY_ACCOUNT_OWNER || process.env.POLY_FUNDER || '').trim().toLowerCase();
      for (const trade of trades) {
        const takerOrderId = String(trade?.taker_order_id || trade?.order_id || trade?.orderID || '').trim();
        const takerAsset = String(trade?.asset_id || trade?.token_id || '').trim();
        const takerSize = Number(trade?.size || trade?.matched_amount || trade?.size_matched || 0);
        if (takerOrderId && takerAsset && takerSize > 0) {
          const key = `${takerOrderId}::${takerAsset}`;
          tradesByOrderAndAsset.set(key, Number(tradesByOrderAndAsset.get(key) || 0) + takerSize);
        }
        const traderSide = String(trade?.trader_side || '').toUpperCase();
        const tradeOwner = String(trade?.owner || '').trim().toLowerCase();
        const isTakerForThisAccount = traderSide === 'TAKER' && Boolean(accountOwner) && tradeOwner === accountOwner;
        if (isTakerForThisAccount && takerAsset && takerSize > 0) {
          traderEvidenceByAsset.set(takerAsset, Number(traderEvidenceByAsset.get(takerAsset) || 0) + takerSize);
        }

        const makerOrders = Array.isArray(trade?.maker_orders) ? trade.maker_orders : [];
        for (const maker of makerOrders) {
          const makerOrderId = String(maker?.order_id || maker?.orderID || '').trim();
          const makerAsset = String(maker?.asset_id || maker?.token_id || '').trim();
          const makerSize = Number(maker?.matched_amount || maker?.size || maker?.size_matched || 0);
          if (!makerOrderId || !makerAsset || !(makerSize > 0)) continue;
          const key = `${makerOrderId}::${makerAsset}`;
          tradesByOrderAndAsset.set(key, Number(tradesByOrderAndAsset.get(key) || 0) + makerSize);

          const makerOwner = String(maker?.owner || '').trim().toLowerCase();
          const isMakerForThisAccount = traderSide === 'MAKER' && accountOwner && makerOwner === accountOwner;
          if (isMakerForThisAccount) {
            traderEvidenceByAsset.set(makerAsset, Number(traderEvidenceByAsset.get(makerAsset) || 0) + makerSize);
          }
        }
      }

      for (const rec of Object.values(state.orders || {})) {
        const orderId = String(rec?.order_id || '').trim();
        const asset = String(rec?.asset_id || rec?.token_id || '').trim();
        if (!orderId || !asset) continue;
        const key = `${orderId}::${asset}`;
        const matchedSize = Number(tradesByOrderAndAsset.get(key) || 0);
        if (!(matchedSize > 0)) continue;

        recentTradesMatchedOrders++;
        botEvidenceAssets.add(asset);

        const prevExecuted = Number(rec?.executed_size || 0);
        if (matchedSize > prevExecuted) {
          rec.executed_size = matchedSize;
          rec.updated_at = new Date().toISOString();
          rec.final_reason = rec.final_reason || 'recent_trade_evidence_backfill';
          recentTradesBackfilledExecutions++;
        }
      }

      for (const [asset, evidenceSize] of traderEvidenceByAsset.entries()) {
        if (asset && Number(evidenceSize) > 0) botEvidenceAssets.add(asset);
      }

      await onEvent('EXPOSURE_SYNC_RECENT_TRADES_EVIDENCE', {
        source: recentTradesResult.source || 'py_clob_client_v2_get_trades',
        scanned_trades: recentTradesScanned,
        matched_orders: recentTradesMatchedOrders,
        backfilled_executions: recentTradesBackfilledExecutions,
        trader_asset_evidence_assets: traderEvidenceByAsset.size,
        limit: tradesLimit,
      });
    } else {
      await onEvent('EXPOSURE_SYNC_RECENT_TRADES_EVIDENCE_FAILED', {
        reason: recentTradesResult.reason,
        detail: recentTradesResult.detail,
      });
    }
  }

  const autoAdoptEnabled = String(process.env.EXPOSURE_AUTO_ADOPT || 'false').toLowerCase() === 'true';

  let unmanagedCount = 0;
  let recoveredCount = 0;
  let confirmedCount = 0;
  let managedCount = 0;
  let autoAdoptedCount = 0;

  for (const pos of exchangePositions) {
    const asset = pos.asset_id || pos.condition_id;
    if (!asset) continue;
    
    const yesQty = Number(pos.yes) || 0;
    const noQty = Number(pos.no) || 0;
    const net = yesQty - noQty;
    
    if (Math.abs(net) < 0.001) continue; // Skip zero positions
    
    // Determine outcome
    const outcome = net > 0 ? 'yes' : 'no';
    const qty = Math.abs(net);
    
    // Classify holding
    const existingBotHoldings = state.exposure_ledger?.holdings || {};
    const existingSource = state.exposure_ledger?.source_by_asset?.[asset];
    const existingLifecycle = state.exposure_ledger?.lifecycle_by_asset?.[asset];
    const existingQty = Math.abs(existingBotHoldings[asset] || 0);
    
    let source = 'unmanaged_historical';
    let lifecycle = 'active_open';
    
    if (existingSource === 'recovered_from_exchange_confirmed' || existingSource === 'recovered_from_exchange_confirmed_auto') {
      // Already confirmed - keep as confirmed
      source = existingSource === 'recovered_from_exchange_confirmed_auto'
        ? 'recovered_from_exchange_confirmed_auto'
        : 'recovered_from_exchange_confirmed';
      lifecycle = existingLifecycle || 'active_open';
      confirmedCount++;
    } else if (existingQty > 0.001) {
      // Bot already has this holding - check if matches
      if (Math.abs(existingQty - qty) < 0.001) {
        source = 'managed_by_bot';
        lifecycle = existingLifecycle || 'active_open';
        managedCount++;
      } else {
        // Position size changed - recovered from exchange
        if (autoAdoptEnabled && botEvidenceAssets.has(String(asset))) {
          source = 'recovered_from_exchange_confirmed_auto';
          lifecycle = 'active_open';
          confirmedCount++;
          autoAdoptedCount++;
          await onEvent('EXPOSURE_AUTO_ADOPTED', {
            asset_id: asset,
            outcome,
            qty,
            reason: 'bot_evidence_matched_recovered_delta',
          });
        } else {
          source = 'recovered_from_exchange';
          recoveredCount++;
        }
      }
    } else {
      // No bot holding in ledger. Auto-adopt only when strong bot evidence exists.
      if (autoAdoptEnabled && botEvidenceAssets.has(String(asset))) {
        source = 'recovered_from_exchange_confirmed_auto';
        lifecycle = 'active_open';
        confirmedCount++;
        autoAdoptedCount++;
        await onEvent('EXPOSURE_AUTO_ADOPTED', {
          asset_id: asset,
          outcome,
          qty,
          reason: 'bot_evidence_matched_missing_local_holding',
        });
      } else {
        source = 'unmanaged_historical';
        lifecycle = 'historical_closed';
        unmanagedCount++;
      }
    }
    
    holdings[asset] = net; // Preserve sign
    avgPrices[asset] = pos.avg_price || 0;
    sourceByAsset[asset] = source;
    lifecycleByAsset[asset] = lifecycle;
  }

  await onEvent('EXPOSURE_SYNC_CLASSIFICATION', {
    managed_by_bot: managedCount,
    recovered_from_exchange: recoveredCount,
    recovered_from_exchange_confirmed: confirmedCount,
    recovered_from_exchange_confirmed_auto: autoAdoptedCount,
    unmanaged_historical: unmanagedCount,
    auto_adopt_enabled: autoAdoptEnabled,
    total_holdings: Object.keys(holdings).length,
  });

  // 3. Check for unconfirmed recovered holdings → bounded reconciliation in caller
  const unconfirmedRecovered = recoveredCount + unmanagedCount;
  if (unconfirmedRecovered > 0) {
    await onEvent('EXPOSURE_SYNC_UNCONFIRMED_HOLDINGS', {
      unconfirmed_count: unconfirmedRecovered,
      action: 'RECONCILE',
      reason: 'unconfirmed_recovered_holdings_exist',
    });
    
    return {
      ok: false,
      halted: true,
      reason: 'unconfirmed_recovered_holdings',
      holdings,
      avgPrices,
      sourceByAsset,
      lifecycleByAsset,
      syncedAt: new Date().toISOString(),
      unconfirmedCount: unconfirmedRecovered,
      managedCount,
      confirmedCount,
      autoAdoptedCount,
    };
  }

  // 4. Success - holdings synced and confirmed
  await onEvent('EXPOSURE_SYNC_SUCCESS', {
    holdings_count: Object.keys(holdings).length,
    managed: managedCount,
    confirmed: confirmedCount,
    auto_adopted: autoAdoptedCount,
  });

  return {
    ok: true,
    halted: false,
    holdings,
    avgPrices,
    sourceByAsset,
    lifecycleByAsset,
    syncedAt: new Date().toISOString(),
    unconfirmedCount: 0,
    managedCount,
    confirmedCount,
    autoAdoptedCount,
  };
}

/**
 * Manual adoption of exchange holdings
 * One-time flow to confirm historical holdings as recovered
 */
export async function adoptExchangeHoldings({
  state,
  liveGateway,
  onEvent = async () => {},
}) {
  await onEvent('EXPOSURE_ADOPTION_STARTED', {
    existing_holdings_count: Object.keys(state.exposure_ledger?.holdings || {}).length,
  });

  // 1. Query exchange positions
  const positionsResult = await liveGateway.getPositions();
  if (positionsResult?.reason) {
    await onEvent('EXPOSURE_ADOPTION_BLOCKED', {
      reason: positionsResult.reason,
      detail: positionsResult.detail || positionsResult.reason,
      action: 'SAFE_HALT',
    });
    return {
      ok: false,
      halted: true,
      reason: 'exposure_positions_inconclusive',
      holdings: state.exposure_ledger?.holdings || {},
    };
  }
  const exchangePositions = positionsResult.positions || [];
  
  await onEvent('EXPOSURE_ADOPTION_EXCHANGE_QUERY', {
    positions_count: exchangePositions.length,
  });

  // 2. Adopt all holdings as confirmed
  const holdings = {};
  const avgPrices = {};
  const sourceByAsset = {};
  const lifecycleByAsset = {};
  let adoptedCount = 0;

  for (const pos of exchangePositions) {
    const asset = pos.asset_id || pos.condition_id;
    if (!asset) continue;
    
    const yesQty = Number(pos.yes) || 0;
    const noQty = Number(pos.no) || 0;
    const net = yesQty - noQty;
    
    if (Math.abs(net) < 0.001) continue;
    
    holdings[asset] = net;
    avgPrices[asset] = pos.avg_price || 0;
    sourceByAsset[asset] = 'recovered_from_exchange_confirmed';
    lifecycleByAsset[asset] = 'active_open';
    adoptedCount++;
  }

  const adoptedAt = new Date().toISOString();

  // 3. Update state
  state.exposure_ledger = state.exposure_ledger || {};
  state.exposure_ledger.holdings = holdings;
  state.exposure_ledger.avg_prices = avgPrices;
  state.exposure_ledger.source_by_asset = sourceByAsset;
  state.exposure_ledger.lifecycle_by_asset = lifecycleByAsset;
  state.exposure_ledger.adopted_at = adoptedAt;
  state.exposure_ledger.adopted_by = 'manual';
  state.exposure_ledger.last_reconcile_ts = adoptedAt;

  await onEvent('EXPOSURE_ADOPTED_FROM_EXCHANGE', {
    adopted_count: adoptedCount,
    adopted_at: adoptedAt,
    adopted_by: 'manual',
  });

  return {
    ok: true,
    adopted_count: adoptedCount,
    adopted_at: adoptedAt,
    account_owner: positionsResult.account_owner || null,
    holdings,
    sourceByAsset,
    lifecycleByAsset,
    state,
  };
}
