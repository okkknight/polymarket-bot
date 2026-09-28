import { appendFile, mkdir } from 'node:fs/promises';
import { buildIntentId } from '../state/trade_state_store.mjs';

export const ORDER_STATUS = {
  NEW: 'new',
  ACKNOWLEDGED: 'acknowledged',
  PARTIAL_FILLED: 'partial_filled',
  FILLED: 'filled',
  CANCELED: 'canceled',
  EXPIRED: 'expired',
  REJECTED: 'rejected',
  // New convergence states for late fill after cancel
  PARTIAL_FILLED_CANCELED: 'partially_filled_canceled',
  PARTIAL_FILLED_OPEN: 'partial_filled_open',
};

const VALID_TRANSITIONS = {
  // Live venues may return immediate partial/full fills on submit.
  [ORDER_STATUS.NEW]: [ORDER_STATUS.ACKNOWLEDGED, ORDER_STATUS.PARTIAL_FILLED, ORDER_STATUS.FILLED, ORDER_STATUS.REJECTED, ORDER_STATUS.CANCELED],
  [ORDER_STATUS.ACKNOWLEDGED]: [ORDER_STATUS.PARTIAL_FILLED, ORDER_STATUS.FILLED, ORDER_STATUS.CANCELED, ORDER_STATUS.EXPIRED, ORDER_STATUS.REJECTED],
  [ORDER_STATUS.PARTIAL_FILLED]: [ORDER_STATUS.FILLED, ORDER_STATUS.CANCELED, ORDER_STATUS.EXPIRED],
  [ORDER_STATUS.FILLED]: [],
  [ORDER_STATUS.CANCELED]: [],
  [ORDER_STATUS.EXPIRED]: [],
  [ORDER_STATUS.REJECTED]: [],
  // New convergence states - terminal states after late fill
  [ORDER_STATUS.PARTIAL_FILLED_CANCELED]: [],
  [ORDER_STATUS.PARTIAL_FILLED_OPEN]: [ORDER_STATUS.FILLED, ORDER_STATUS.CANCELED, ORDER_STATUS.EXPIRED, ORDER_STATUS.PARTIAL_FILLED_CANCELED],
};

const EXEC_QUALITY_PATH = 'data/execution_quality.csv';
let execQualityHeaderReady = false;

async function ensureExecQualityHeader() {
  if (execQualityHeaderReady) return;
  await mkdir('data', { recursive: true });
  try {
    await appendFile(EXEC_QUALITY_PATH, 'ts,market_id,signal,midpoint_signal,limit_price,fill_price,size,slippage_bps,latency_ms\n', { flag: 'wx' });
  } catch {}
  execQualityHeaderReady = true;
}

async function logExecutionQuality({ intent, fillPrice }) {
  const midpointSignal = Number(intent?.meta?.midpoint_signal ?? intent?.limit_price ?? 0);
  const limitPrice = Number(intent?.limit_price ?? 0);
  const size = Number(intent?.size ?? 0);
  const signal = String(intent?.meta?.signal || 'unknown');
  const tsSignal = Date.parse(intent?.meta?.signal_ts || intent?.ts || '');
  const latencyMs = Number.isFinite(tsSignal) ? Math.max(0, Date.now() - tsSignal) : 0;
  const slippageBps = midpointSignal > 0 ? ((Number(fillPrice || 0) - midpointSignal) / midpointSignal) * 10000 : 0;

  await ensureExecQualityHeader();
  await appendFile(
    EXEC_QUALITY_PATH,
    `${new Date().toISOString()},${intent?.market_id || ''},${signal},${midpointSignal},${limitPrice},${Number(fillPrice || 0)},${size},${Number(slippageBps.toFixed(6))},${latencyMs}\n`,
    'utf8'
  );
}

export function buildLimitIntent({ runId, marketId, tokenId, side = 'buy', size, limitPrice, ttlSec = 120, meta = {} }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const intent = {
    ts: new Date().toISOString(),
    run_id: runId,
    market_id: String(marketId),
    token_id: String(tokenId),
    side: String(side),
    size: Number(size),
    limit_price: Number(limitPrice),
    expiration: nowSec + Number(ttlSec),
  };
  intent.meta = meta || {};
  intent.client_order_id = buildIntentId({
    marketId: intent.market_id,
    tokenId: intent.token_id,
    side: intent.side,
    size: intent.size,
    limitPrice: intent.limit_price,
  });
  return intent;
}

export function preTradeGuard({ halted, runtimeState = null, marketKnown, positionKnown, balanceKnown }) {
  const runtime = String(runtimeState || '').toUpperCase();
  if (runtime === 'RECONCILING') return { ok: false, reason: 'reconciling' };
  if (runtime === 'HALTED' || halted) return { ok: false, reason: 'halted' };
  if (!marketKnown) return { ok: false, reason: 'unknown_market_state' };
  if (!positionKnown) return { ok: false, reason: 'unknown_position_state' };
  if (!balanceKnown) return { ok: false, reason: 'unknown_balance_state' };
  return { ok: true };
}

export const TERMINAL_ORDER_STATUSES = [
  ORDER_STATUS.FILLED,
  ORDER_STATUS.CANCELED,
  ORDER_STATUS.EXPIRED,
  ORDER_STATUS.REJECTED,
  ORDER_STATUS.PARTIAL_FILLED_CANCELED,
];

export function isFinalOrderStatus(status) {
  const s = String(status || '').toLowerCase();
  return TERMINAL_ORDER_STATUSES.includes(s);
}

export function isUnresolvedOrderStatus(status) {
  return !isFinalOrderStatus(status);
}

export function canTransitOrderStatus(fromStatus, toStatus) {
  const from = String(fromStatus || ORDER_STATUS.NEW).toLowerCase();
  const to = String(toStatus || '').toLowerCase();
  
  // Standard valid transitions
  if ((VALID_TRANSITIONS[from] || []).includes(to)) {
    return { ok: true, reason: 'valid_transition' };
  }
  
  // Check for late exchange truth after cancel - but DON'T allow by default
  // This is a special case that requires explicit allowance
  if (from === ORDER_STATUS.CANCELED && (to === ORDER_STATUS.PARTIAL_FILLED || to === ORDER_STATUS.FILLED)) {
    return { ok: false, reason: 'late_exchange_fill_after_cancel' };
  }
  
  return { ok: false, reason: 'invalid_transition' };
}

export async function transitionOrderStatus({ record, toStatus, patch = {}, onEvent = async () => {}, allowLateFill = false }) {
  const from = String(record?.status || ORDER_STATUS.NEW).toLowerCase();
  const to = String(toStatus || '').toLowerCase();
  const transCheck = canTransitOrderStatus(from, to);
  
  if (!transCheck.ok) {
    // Check for late exchange fill after cancel - special handling
    if (transCheck.reason === 'late_exchange_fill_after_cancel' && allowLateFill) {
      await onEvent('ORDER_LATE_EXCHANGE_FILL_AFTER_CANCEL', {
        client_order_id: record?.client_order_id,
        order_id: record?.order_id,
        from_status: from,
        to_status: to,
        detail: 'exchange reported fill after cancel - accepting late truth',
      });
      // Keep the higher-value status (partial_fill or filled over canceled)
      const next = { 
        ...record, 
        ...patch, 
        status: to, 
        status_ts: new Date().toISOString(),
        terminal_source: 'exchange_late_fill',
        reconciliation_conflict: true,
      };
      return { ok: true, record: next, isLateFill: true };
    }
    
    await onEvent('ORDER_STATUS_TRANSITION_REJECTED', {
      client_order_id: record?.client_order_id,
      order_id: record?.order_id,
      from_status: from,
      to_status: to,
      reason: transCheck.reason,
    });
    return { ok: false, reason: transCheck.reason, record };
  }

  const next = { ...record, ...patch, status: to, status_ts: new Date().toISOString() };
  if (transCheck.isLateFill) {
    next.terminal_source = 'exchange_late_fill';
    next.reconciliation_conflict = true;
  }
  await onEvent('ORDER_STATUS_TRANSITIONED', {
    client_order_id: next?.client_order_id,
    order_id: next?.order_id,
    from_status: from,
    to_status: to,
  });
  return { ok: true, record: next };
}

export async function queryOrderStatusFromSource({ record, dryRun = true, liveQuery = null, onEvent = async () => {} }) {
  if (dryRun) {
    await onEvent('ORDER_STATUS_QUERY_SOURCE', {
      client_order_id: record?.client_order_id,
      order_id: record?.order_id,
      source: 'dry_run_local',
      status: record?.status,
    });
    return { status: record?.status || ORDER_STATUS.NEW, source: 'dry_run_local' };
  }

  if (typeof liveQuery === 'function') {
    const q = await liveQuery(record);
    await onEvent('ORDER_STATUS_QUERY_SOURCE', {
      client_order_id: record?.client_order_id,
      order_id: record?.order_id,
      source: q?.source || 'live_gateway_query',
      status: q?.status || null,
      raw_status: q?.raw_status || null,
    });
    return q;
  }

  await onEvent('ORDER_STATUS_QUERY_SOURCE', {
    client_order_id: record?.client_order_id,
    order_id: record?.order_id,
    source: 'live_api_placeholder',
    status: null,
  });
  return { status: null, source: 'live_api_placeholder' };
}

// Convergence limits for late fill after cancel scenarios
const DEFAULT_MAX_LATE_FILL_RECONCILES = 5;
const DEFAULT_MAX_CANCEL_RECONCILES = 3;
const DEFAULT_MAX_ORDER_LIFECYCLE_MS = 120000; // 2 minutes max
const DEFAULT_RECONCILE_GRACE_SEC = 30;
const DEFAULT_RECONCILE_INTERVAL_SEC = 10;
const DEFAULT_RECONCILE_MAX_RETRY = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runBoundedUnresolvedOrderReconcile({
  record,
  unresolvedMsLimit,
  dryRun,
  liveQuery,
  onEvent,
  maxLateFillReconciles,
  maxCancelReconciles,
  maxOrderLifecycleMs,
  originalReason = 'inconsistent_order_state',
}) {
  if (dryRun) {
    return { ok: false, final: false, haltReason: originalReason, record };
  }

  const graceSec = Math.max(1, Number(process.env.RECONCILE_GRACE_SEC || DEFAULT_RECONCILE_GRACE_SEC));
  const intervalSec = Math.max(1, Number(process.env.RECONCILE_INTERVAL_SEC || DEFAULT_RECONCILE_INTERVAL_SEC));
  const maxRetry = Math.max(1, Number(process.env.RECONCILE_MAX_RETRY || DEFAULT_RECONCILE_MAX_RETRY));
  const startedAtMs = Date.now();
  let retries = 0;
  let lastResult = { ok: false, final: false, haltReason: originalReason, record };
  let workingRecord = record;

  await onEvent('RECONCILE_STARTED', {
    reason: originalReason,
    mismatch_type: 'unresolved_order_state',
    client_order_id: workingRecord?.client_order_id || null,
    order_id: workingRecord?.order_id || null,
    grace_sec: graceSec,
    interval_sec: intervalSec,
    max_retry: maxRetry,
  });

  while (retries < maxRetry) {
    retries += 1;
    await onEvent('RECONCILE_RETRY', {
      reason: originalReason,
      mismatch_type: 'unresolved_order_state',
      client_order_id: workingRecord?.client_order_id || null,
      order_id: workingRecord?.order_id || null,
      retry_count: retries,
      max_retry: maxRetry,
      interval_sec: intervalSec,
      elapsed_sec: Number(((Date.now() - startedAtMs) / 1000).toFixed(3)),
    });

    await sleep(intervalSec * 1000);

    lastResult = await reconcileOrderStatus({
      record: workingRecord,
      nowMs: Date.now(),
      unresolvedMsLimit,
      dryRun,
      liveQuery,
      onEvent,
      maxLateFillReconciles,
      maxCancelReconciles,
      maxOrderLifecycleMs,
      boundedRetryEnabled: false,
    });

    if (lastResult?.record) {
      workingRecord = lastResult.record;
    }
    if (lastResult?.ok) {
      await onEvent('RECONCILE_SUCCESS', {
        reason: originalReason,
        mismatch_type: 'unresolved_order_state',
        client_order_id: workingRecord?.client_order_id || null,
        order_id: workingRecord?.order_id || null,
        retry_count: retries,
        max_retry: maxRetry,
        elapsed_sec: Number(((Date.now() - startedAtMs) / 1000).toFixed(3)),
      });
      return lastResult;
    }

    const elapsedSec = (Date.now() - startedAtMs) / 1000;
    if (elapsedSec >= graceSec) break;
  }

  await onEvent('RECONCILE_FAILED_HALTING', {
    reason: lastResult?.haltReason || originalReason,
    mismatch_type: 'unresolved_order_state',
    client_order_id: workingRecord?.client_order_id || null,
    order_id: workingRecord?.order_id || null,
    retry_count: retries,
    max_retry: maxRetry,
    interval_sec: intervalSec,
    grace_sec: graceSec,
    elapsed_sec: Number(((Date.now() - startedAtMs) / 1000).toFixed(3)),
  });

  return {
    ...lastResult,
    ok: false,
    final: Boolean(lastResult?.final),
    haltReason: lastResult?.haltReason || originalReason,
    record: workingRecord,
  };
}

export async function reconcileOrderStatus({ 
  record, 
  nowMs = Date.now(), 
  unresolvedMsLimit = 10000, 
  dryRun = true, 
  liveQuery = null, 
  onEvent = async () => {},
  maxLateFillReconciles = DEFAULT_MAX_LATE_FILL_RECONCILES,
  maxCancelReconciles = DEFAULT_MAX_CANCEL_RECONCILES,
  maxOrderLifecycleMs = DEFAULT_MAX_ORDER_LIFECYCLE_MS,
  boundedRetryEnabled = true,
}) {
  const currentStatus = String(record?.status || ORDER_STATUS.NEW).toLowerCase();
  const refTs = Date.parse(record?.ack_ts || record?.ts || 0);
  const ageMs = Number.isFinite(refTs) ? Math.max(0, nowMs - refTs) : null;
  
  // Initialize convergence tracking fields if not present
  if (!record.cancel_requested_at) record.cancel_requested_at = null;
  if (!record.late_fill_reconcile_count) record.late_fill_reconcile_count = 0;
  if (!record.cancel_reconcile_count) record.cancel_reconcile_count = 0;
  if (!record.lifecycle_finalized_at) record.lifecycle_finalized_at = null;
  if (!record.executed_size) record.executed_size = Number(record?.executed_size || 0);
  if (!record.original_size) record.original_size = Number(record?.size || 0);

  // Track previous executed_size to detect new fills
  const prevExecutedSize = record.executed_size || 0;

  const queried = await queryOrderStatusFromSource({ record, dryRun, liveQuery, onEvent });
  const queriedStatus = queried?.status ? String(queried.status).toLowerCase() : null;
  
  // Extract executed size from exchange response if available
  // Use executed_size from query (which comes from size_matched)
  if (queried?.executed_size != null) {
    record.executed_size = Number(queried.executed_size);
  }
  // Also use original_size from query if available
  if (queried?.original_size != null) {
    record.original_size = Number(queried.original_size);
  }
  // Use fill_price if available
  if (queried?.fill_price != null) {
    record.fill_price = Number(queried.fill_price);
  }
  
  // Detect new fills - when executed_size increased
  const newExecutedSize = record.executed_size || 0;
  const fillDelta = newExecutedSize - prevExecutedSize;

  // PRIORITY BRANCH: late partial fill after cancel must converge immediately
  // Do this before generic fillDelta fast path to avoid returning plain partial_filled.
  if (
    !dryRun &&
    currentStatus === ORDER_STATUS.CANCELED &&
    queriedStatus === ORDER_STATUS.PARTIAL_FILLED &&
    newExecutedSize > 0
  ) {
    record.late_fill_reconcile_count = (record.late_fill_reconcile_count || 0) + 1;
    record.status = ORDER_STATUS.PARTIAL_FILLED_CANCELED;
    record.status_ts = new Date().toISOString();
    record.lifecycle_finalized_at = nowMs;
    record.lifecycle_resolution_reason = 'late_fill_with_remaining_canceled';

    await onEvent('ORDER_PARTIAL_FILLED', {
      client_order_id: record?.client_order_id,
      order_id: record?.order_id,
      fill_size: Math.max(0, fillDelta),
      fill_price: record.fill_price,
      total_executed_size: newExecutedSize,
      original_size: record.original_size,
      remaining_size: record.original_size - newExecutedSize,
      reason: 'late_fill_after_cancel',
    });

    await onEvent('ORDER_LIFECYCLE_FINALIZED', {
      client_order_id: record?.client_order_id,
      order_id: record?.order_id,
      final_status: ORDER_STATUS.PARTIAL_FILLED_CANCELED,
      executed_size: newExecutedSize,
      remaining_size: record.original_size - newExecutedSize,
      late_fill_reconcile_count: record.late_fill_reconcile_count,
      reason: record.lifecycle_resolution_reason,
    });

    return { ok: true, final: true, status: ORDER_STATUS.PARTIAL_FILLED_CANCELED, record, converged: true };
  }
  
  // Handle fill state directly - exchange truth dominates
  // If we have a fill (executed_size > 0 and status changed to filled/partial), update status immediately
  if (fillDelta > 0 && !dryRun) {
    const isFullFill = newExecutedSize >= record.original_size;
    const fillStatus = isFullFill ? 'filled' : 'partial_filled';
    
    // Directly update status based on fill - no transition validation needed
    // Exchange reported the fill, so we trust that
    record.status = fillStatus;
    record.status_ts = new Date().toISOString();
    
    await onEvent(isFullFill ? 'ORDER_FILLED' : 'ORDER_PARTIAL_FILLED', {
      client_order_id: record?.client_order_id,
      order_id: record?.order_id,
      fill_size: fillDelta,
      fill_price: record.fill_price,
      total_executed_size: newExecutedSize,
      original_size: record.original_size,
      remaining_size: record.original_size - newExecutedSize,
    });
    
    // Check if fully filled - return final
    if (isFullFill) {
      await onEvent('ORDER_LIFECYCLE_FINALIZED', {
        client_order_id: record?.client_order_id,
        order_id: record?.order_id,
        final_status: 'filled',
        executed_size: newExecutedSize,
        reason: 'fully_filled',
      });
      return { ok: true, final: true, status: 'filled', record, converged: true };
    }
    
    // For partial fills, still return with updated status
    return { ok: true, final: false, status: 'partial_filled', record };
  }
  
  // Check if exchange still has open order
  const exchangeOrderStillOpen =
    queriedStatus === 'open' ||
    queriedStatus === ORDER_STATUS.ACKNOWLEDGED ||
    queriedStatus === 'partial_filled' ||
    queriedStatus === 'matched';

  await onEvent('ORDER_RECONCILE_CHECK', {
    client_order_id: record?.client_order_id,
    order_id: record?.order_id,
    status: currentStatus,
    queried_status: queriedStatus,
    status_source: queried?.source || null,
    age_ms: ageMs,
    executed_size: record.executed_size,
    remaining_size: record.original_size - record.executed_size,
    exchange_order_still_open: exchangeOrderStillOpen,
  });

  let justTransitionedFromCancel = false;
  
  // Handle transition when exchange reports different status
  if (queriedStatus && queriedStatus !== currentStatus) {
    const statusBeforeTransition = currentStatus;
    // Track if we just transitioned from canceled to partial/filled (late fill after cancel)
    if (currentStatus === ORDER_STATUS.CANCELED && (queriedStatus === ORDER_STATUS.PARTIAL_FILLED || queriedStatus === ORDER_STATUS.FILLED)) {
      record.late_fill_reconcile_count = (record.late_fill_reconcile_count || 0) + 1;
      justTransitionedFromCancel = true;
      
      await onEvent('ORDER_LATE_EXCHANGE_FILL_AFTER_CANCEL', {
        client_order_id: record?.client_order_id,
        order_id: record?.order_id,
        from_status: currentStatus,
        to_status: queriedStatus,
        late_fill_reconcile_count: record.late_fill_reconcile_count,
        executed_size: record.executed_size,
        remaining_size: record.original_size - record.executed_size,
        detail: 'exchange reported fill after cancel',
      });
    }
    
    // Allow late fills after cancel from exchange - exchange truth dominates
    let transitioned = await transitionOrderStatus({ 
      record, 
      toStatus: queriedStatus, 
      onEvent,
      allowLateFill: !dryRun // Only allow late fills in live mode
    });
    
    // If transition failed but we have a valid fill, still update the status
    // This is critical: exchange truth should dominate even if transition validation fails
    if (!transitioned.ok && queriedStatus && (queriedStatus === 'filled' || queriedStatus === 'partial_filled')) {
      // Force accept the exchange status - it's the truth
      record.status = queriedStatus;
      record.status_ts = new Date().toISOString();
      transitioned.ok = true;
      await onEvent('ORDER_STATUS_FORCED_BY_EXCHANGE', {
        client_order_id: record?.client_order_id,
        order_id: record?.order_id,
        from_status: currentStatus,
        to_status: queriedStatus,
        reason: 'exchange_fill_truth_dominates',
      });
    }
    
    // Special case: if transitioning from canceled to partial_filled (late fill after cancel),
    // the remaining portion is already canceled. Resolve to "partially_filled_canceled" immediately.
    if (transitioned.ok && currentStatus === ORDER_STATUS.CANCELED && queriedStatus === ORDER_STATUS.PARTIAL_FILLED) {
      const finalStatus = ORDER_STATUS.PARTIAL_FILLED_CANCELED;
      record.status = finalStatus;
      record.status_ts = new Date().toISOString();
      record.lifecycle_finalized_at = nowMs;
      record.lifecycle_resolution_reason = 'late_fill_with_remaining_canceled';
      
      await onEvent('ORDER_LIFECYCLE_FINALIZED', {
        client_order_id: record?.client_order_id,
        order_id: record?.order_id,
        final_status: finalStatus,
        executed_size: record.executed_size,
        remaining_size: record.original_size - record.executed_size,
        late_fill_reconcile_count: record.late_fill_reconcile_count,
        reason: record.lifecycle_resolution_reason,
      });
      
      return { ok: true, final: true, status: finalStatus, record, converged: true };
    }
    
    if (transitioned.ok && transitioned.record) {
      const transitionedStatus = String(transitioned.record.status || '').toLowerCase();
      const transitionedToFilled = transitionedStatus === ORDER_STATUS.FILLED && statusBeforeTransition !== ORDER_STATUS.FILLED;
      if (transitionedToFilled) {
        const executed = Number(transitioned.record.executed_size || 0);
        const fillSize = Math.max(0, executed - Number(prevExecutedSize || 0));
        await onEvent('ORDER_FILLED', {
          client_order_id: transitioned.record?.client_order_id,
          order_id: transitioned.record?.order_id,
          fill_size: fillSize,
          fill_price: transitioned.record?.fill_price,
          total_executed_size: executed,
          original_size: transitioned.record?.original_size,
          remaining_size: Number(transitioned.record?.original_size || 0) - executed,
          reason: fillSize > 0 ? 'status_transition_filled' : 'status_transition_filled_no_delta',
        });
      }
    }

    if (!transitioned.ok) {
      // Check if we've exceeded convergence limits
      const lifecycleAgeMs = record.cancel_requested_at ? (nowMs - record.cancel_requested_at) : ageMs;
      
      if (record.late_fill_reconcile_count >= maxLateFillReconciles ||
          record.cancel_reconcile_count >= maxCancelReconciles ||
          lifecycleAgeMs > maxOrderLifecycleMs) {
        
        // CONVERGENCE: Force finalize the lifecycle
        const finalStatus = resolveConvergenceState({
          executed_size: record.executed_size,
          original_size: record.original_size,
          exchange_order_still_open: exchangeOrderStillOpen,
          queried_status: queriedStatus,
        });
        
        record.status = finalStatus;
        record.status_ts = new Date().toISOString();
        record.lifecycle_resolution_reason = `convergence_limit_reached_late_fill=${record.late_fill_reconcile_count}_cancel=${record.cancel_reconcile_count}_age=${lifecycleAgeMs}`;

        if (finalStatus === ORDER_STATUS.PARTIAL_FILLED_OPEN) {
          await onEvent('ORDER_PARTIAL_FILLED', {
            client_order_id: record?.client_order_id,
            order_id: record?.order_id,
            fill_size: 0,
            fill_price: record.fill_price,
            total_executed_size: record.executed_size,
            original_size: record.original_size,
            remaining_size: record.original_size - record.executed_size,
            reason: 'partial_fill_open_remaining',
          });
          await onEvent('ORDER_LIFECYCLE_STUCK', {
            client_order_id: record?.client_order_id,
            order_id: record?.order_id,
            status: finalStatus,
            executed_size: record.executed_size,
            remaining_size: record.original_size - record.executed_size,
            late_fill_reconcile_count: record.late_fill_reconcile_count,
            cancel_reconcile_count: record.cancel_reconcile_count,
            lifecycle_age_ms: lifecycleAgeMs,
            reason: record.lifecycle_resolution_reason,
            exchange_order_still_open: exchangeOrderStillOpen,
          });
          return { ok: true, final: false, status: finalStatus, record, converged: false };
        }

        record.lifecycle_finalized_at = nowMs;
        await onEvent('ORDER_LIFECYCLE_FINALIZED', {
          client_order_id: record?.client_order_id,
          order_id: record?.order_id,
          final_status: finalStatus,
          executed_size: record.executed_size,
          remaining_size: record.original_size - record.executed_size,
          late_fill_reconcile_count: record.late_fill_reconcile_count,
          cancel_reconcile_count: record.cancel_reconcile_count,
          lifecycle_age_ms: lifecycleAgeMs,
          reason: record.lifecycle_resolution_reason,
          exchange_order_still_open: exchangeOrderStillOpen,
        });

        return { ok: true, final: true, status: finalStatus, record, converged: true };
      }
      
      if (boundedRetryEnabled && String(transitioned.reason || '') === 'inconsistent_order_state') {
        return runBoundedUnresolvedOrderReconcile({
          record,
          unresolvedMsLimit,
          dryRun,
          liveQuery,
          onEvent,
          maxLateFillReconciles,
          maxCancelReconciles,
          maxOrderLifecycleMs,
          originalReason: transitioned.reason,
        });
      }

      return { ok: false, final: false, haltReason: transitioned.reason, record };
    }
    record = transitioned.record;
  }

  const status = String(record?.status || ORDER_STATUS.NEW).toLowerCase();
  if (isFinalOrderStatus(status)) {
    // Emit ORDER_LIFECYCLE_FINALIZED for final states
    // Only emit if not already finalized (check if lifecycle_finalized_at exists)
    if (!record.lifecycle_finalized_at) {
      await onEvent('ORDER_LIFECYCLE_FINALIZED', {
        client_order_id: record?.client_order_id,
        order_id: record?.order_id,
        final_status: status,
        executed_size: record?.executed_size || 0,
        remaining_size: (record?.original_size || 0) - (record?.executed_size || 0),
        reason: `status_became_final_${status}`,
      });
      record.lifecycle_finalized_at = nowMs;
    }
    return { ok: true, final: true, status, record, converged: true };
  }

  // Track cancel requests
  if (currentStatus === ORDER_STATUS.CANCELED && !record.cancel_requested_at) {
    record.cancel_requested_at = nowMs;
  }
  if (currentStatus === ORDER_STATUS.CANCELED) {
    record.cancel_reconcile_count = (record.cancel_reconcile_count || 0) + 1;
  }

  if (ageMs != null && ageMs > unresolvedMsLimit) {
    // Skip convergence check if we just transitioned from cancel to late fill this tick
    // Give the order a chance to stabilize before converging
    const lifecycleAgeMs = record.cancel_requested_at ? (nowMs - record.cancel_requested_at) : ageMs;
    
    // Check if we should converge - but only if NOT just transitioned from cancel (grace period)
    if (!justTransitionedFromCancel && (
        record.late_fill_reconcile_count >= maxLateFillReconciles ||
        record.cancel_reconcile_count >= maxCancelReconciles ||
        lifecycleAgeMs > maxOrderLifecycleMs)) {
      
      // CONVERGENCE: Force finalize
      const finalStatus = resolveConvergenceState({
        executed_size: record.executed_size,
        original_size: record.original_size,
        exchange_order_still_open: exchangeOrderStillOpen,
        queried_status: queriedStatus,
      });
      
      record.status = finalStatus;
      record.status_ts = new Date().toISOString();
      record.lifecycle_resolution_reason = `timeout_convergence_late_fill=${record.late_fill_reconcile_count}_cancel=${record.cancel_reconcile_count}_age=${lifecycleAgeMs}`;

      if (finalStatus === ORDER_STATUS.PARTIAL_FILLED_OPEN) {
        await onEvent('ORDER_PARTIAL_FILLED', {
          client_order_id: record?.client_order_id,
          order_id: record?.order_id,
          fill_size: 0,
          fill_price: record.fill_price,
          total_executed_size: record.executed_size,
          original_size: record.original_size,
          remaining_size: record.original_size - record.executed_size,
          reason: 'partial_fill_open_remaining',
        });
        await onEvent('ORDER_LIFECYCLE_STUCK', {
          client_order_id: record?.client_order_id,
          order_id: record?.order_id,
          status: finalStatus,
          executed_size: record.executed_size,
          remaining_size: record.original_size - record.executed_size,
          late_fill_reconcile_count: record.late_fill_reconcile_count,
          cancel_reconcile_count: record.cancel_reconcile_count,
          lifecycle_age_ms: lifecycleAgeMs,
          reason: record.lifecycle_resolution_reason,
          exchange_order_still_open: exchangeOrderStillOpen,
        });
        return { ok: true, final: false, status: finalStatus, record, converged: false };
      }

      record.lifecycle_finalized_at = nowMs;
      await onEvent('ORDER_LIFECYCLE_FINALIZED', {
        client_order_id: record?.client_order_id,
        order_id: record?.order_id,
        final_status: finalStatus,
        executed_size: record.executed_size,
        remaining_size: record.original_size - record.executed_size,
        late_fill_reconcile_count: record.late_fill_reconcile_count,
        cancel_reconcile_count: record.cancel_reconcile_count,
        lifecycle_age_ms: lifecycleAgeMs,
        reason: record.lifecycle_resolution_reason,
        exchange_order_still_open: exchangeOrderStillOpen,
      });

      return { ok: true, final: true, status: finalStatus, record, converged: true };
    }
    
    await onEvent('ORDER_RECONCILE_TIMEOUT', {
      client_order_id: record?.client_order_id,
      order_id: record?.order_id,
      status,
      age_ms: ageMs,
      unresolved_limit_ms: unresolvedMsLimit,
      late_fill_reconcile_count: record.late_fill_reconcile_count,
      cancel_reconcile_count: record.cancel_reconcile_count,
      lifecycle_age_ms: lifecycleAgeMs,
      reason: 'inconsistent_order_state',
    });
    if (boundedRetryEnabled) {
      return runBoundedUnresolvedOrderReconcile({
        record,
        unresolvedMsLimit,
        dryRun,
        liveQuery,
        onEvent,
        maxLateFillReconciles,
        maxCancelReconciles,
        maxOrderLifecycleMs,
        originalReason: 'inconsistent_order_state',
      });
    }

    return { ok: false, final: false, haltReason: 'inconsistent_order_state', record };
  }

  return { ok: true, final: false, status, record };
}

// Resolve final convergence state based on executed vs remaining
function resolveConvergenceState({ executed_size, original_size, exchange_order_still_open, queried_status }) {
  const executed = Number(executed_size || 0);
  const remaining = Number(original_size || 0) - executed;
  
  // Case A: partial fill with remaining canceled
  if (executed > 0 && remaining <= 0) {
    return ORDER_STATUS.PARTIAL_FILLED_CANCELED;
  }
  
  // Case B: fully filled (even if was canceled after)
  if (queried_status === ORDER_STATUS.FILLED || executed >= original_size) {
    return ORDER_STATUS.FILLED;
  }
  
  // Case C: partial fill with open remaining
  if (executed > 0 && remaining > 0 && exchange_order_still_open) {
    return ORDER_STATUS.PARTIAL_FILLED_OPEN;
  }
  
  // Default: if there's executed amount, mark as partially filled canceled
  if (executed > 0) {
    return ORDER_STATUS.PARTIAL_FILLED_CANCELED;
  }
  
  // Nothing executed, fully canceled
  return ORDER_STATUS.CANCELED;
}

export async function submitLimitIntent({ intent, state, dryRun = true, liveSubmit = null, onEvent = async () => {} }) {
  await onEvent('ORDER_SUBMIT_REQUESTED', {
    run_id: intent.run_id,
    market_id: intent.market_id,
    intent: {
      client_order_id: intent.client_order_id,
      token_id: intent.token_id,
      side: intent.side,
      size: intent.size,
      limit_price: intent.limit_price,
      expiration: intent.expiration,
    },
  });

  if (state.intents?.[intent.client_order_id] || state.intent_index?.[intent.client_order_id]) {
    const existing = state.intents?.[intent.client_order_id] || {
      client_order_id: intent.client_order_id,
      status: state.intent_index?.[intent.client_order_id] || 'seen',
    };
    await onEvent('ORDER_DUPLICATE_IGNORED', {
      run_id: intent.run_id,
      market_id: intent.market_id,
      client_order_id: intent.client_order_id,
      existing_status: existing.status,
      dedupe_source: state.intents?.[intent.client_order_id] ? 'intents' : 'intent_index',
    });
    return existing;
  }

  if (!dryRun) {
    if (typeof liveSubmit !== 'function') throw new Error('live_submit_not_configured');
    const submitted = await liveSubmit(intent);
    const base = {
      status: ORDER_STATUS.NEW,
      client_order_id: intent.client_order_id,
      order_id: submitted?.order_id || `live_${intent.client_order_id}`,
      ts: new Date().toISOString(),
      ack_ts: null,
    };

    const firstStatus = submitted?.status || ORDER_STATUS.ACKNOWLEDGED;
    const tx = await transitionOrderStatus({
      record: base,
      toStatus: firstStatus,
      patch: {
        ack_ts: new Date().toISOString(),
        fill_price: submitted?.fill_price,
        fill_size: submitted?.fill_size,
      },
      onEvent,
    });
    if (!tx.ok) throw new Error(tx.reason || 'live_status_transition_failed');

    const out = tx.record;
    await onEvent('ORDER_ACKNOWLEDGED', {
      run_id: intent.run_id,
      market_id: intent.market_id,
      client_order_id: intent.client_order_id,
      order_id: out.order_id,
      source: submitted?.source || 'live_gateway_submit',
    });
    if (String(out.status).toLowerCase() === ORDER_STATUS.FILLED) {
      await onEvent('ORDER_FILLED', {
        run_id: intent.run_id,
        market_id: intent.market_id,
        client_order_id: intent.client_order_id,
        order_id: out.order_id,
        fill_price: out.fill_price,
        fill_size: out.fill_size,
        reason: 'live_submit_filled',
      });
      await logExecutionQuality({ intent, fillPrice: out.fill_price });
    }
    // Persist to state for duplicate detection
    state.intents = state.intents || {};
    state.intent_index = state.intent_index || {};
    state.intents[out.client_order_id] = out;
    state.intent_index[out.client_order_id] = out.status;
    return out;
  }

  const baseRecord = {
    status: ORDER_STATUS.NEW,
    client_order_id: intent.client_order_id,
    order_id: `dryrun_${intent.client_order_id}`,
    ts: new Date().toISOString(),
    ack_ts: null,
  };

  const ackTx = await transitionOrderStatus({
    record: baseRecord,
    toStatus: ORDER_STATUS.ACKNOWLEDGED,
    patch: { ack_ts: new Date().toISOString() },
    onEvent,
  });
  if (!ackTx.ok) throw new Error(ackTx.reason || 'order_ack_transition_failed');
  const ack = ackTx.record;

  await onEvent('ORDER_ACKNOWLEDGED', {
    run_id: intent.run_id,
    market_id: intent.market_id,
    client_order_id: intent.client_order_id,
    order_id: ack.order_id,
  });

  const fillTx = await transitionOrderStatus({
    record: ack,
    toStatus: ORDER_STATUS.FILLED,
    patch: {
      fill_price: Number(intent.limit_price),
      fill_size: Number(intent.size),
      fill_ts: new Date().toISOString(),
    },
    onEvent,
  });
  if (!fillTx.ok) throw new Error(fillTx.reason || 'order_fill_transition_failed');
  const filled = fillTx.record;

  await onEvent('ORDER_FILLED', {
    run_id: intent.run_id,
    market_id: intent.market_id,
    client_order_id: intent.client_order_id,
    order_id: ack.order_id,
    fill_price: filled.fill_price,
    fill_size: filled.fill_size,
    reason: 'dry_run_immediate_fill',
  });
  await logExecutionQuality({ intent, fillPrice: filled.fill_price });

  // Persist to state for duplicate detection
  state.intents = state.intents || {};
  state.intent_index = state.intent_index || {};
  state.intents[filled.client_order_id] = filled;
  state.intent_index[filled.client_order_id] = filled.status;

  return filled;
}
