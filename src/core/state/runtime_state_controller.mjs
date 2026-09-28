export const RUNTIME_STATE = Object.freeze({
  RUNNING: 'RUNNING',
  RECONCILING: 'RECONCILING',
  HALTED: 'HALTED',
});

function nowIso() {
  return new Date().toISOString();
}

function normalizeRuntimeState(rawState, halted) {
  if (halted === true) return RUNTIME_STATE.HALTED;
  const normalized = String(rawState || '').toUpperCase();
  if (normalized === RUNTIME_STATE.HALTED) return RUNTIME_STATE.RUNNING;
  if (normalized === RUNTIME_STATE.RUNNING) return RUNTIME_STATE.RUNNING;
  if (normalized === RUNTIME_STATE.RECONCILING) return RUNTIME_STATE.RECONCILING;
  return RUNTIME_STATE.RUNNING;
}

export function getRuntimeState(state = {}) {
  return normalizeRuntimeState(state?.runtime_state, Boolean(state?.halted));
}

export function isReconciling(state = {}) {
  return getRuntimeState(state) === RUNTIME_STATE.RECONCILING;
}

export function ensureRuntimeStateFields(state = {}) {
  const runtimeState = getRuntimeState(state);
  const reconcile = state?.reconcile && typeof state.reconcile === 'object' ? state.reconcile : {};

  state.runtime_state = runtimeState;
  state.runtime_state_ts = state.runtime_state_ts || nowIso();
  state.halted = runtimeState === RUNTIME_STATE.HALTED;
  state.reconcile = {
    active: runtimeState === RUNTIME_STATE.RECONCILING,
    reason: reconcile.reason ?? null,
    started_at: reconcile.started_at ?? null,
    retry_count: Number(reconcile.retry_count || 0),
    max_retry: Number(reconcile.max_retry || 0) || null,
    interval_sec: Number(reconcile.interval_sec || 0) || null,
    grace_sec: Number(reconcile.grace_sec || 0) || null,
    last_retry_at: reconcile.last_retry_at ?? null,
    last_success_at: reconcile.last_success_at ?? null,
    last_failure_at: reconcile.last_failure_at ?? null,
    last_error: reconcile.last_error ?? null,
  };

  return state;
}

export function setRuntimeState(state = {}, nextState, { reason = null } = {}) {
  ensureRuntimeStateFields(state);

  const requested = String(nextState || '').toUpperCase();
  const target =
    requested === RUNTIME_STATE.RUNNING ||
    requested === RUNTIME_STATE.RECONCILING ||
    requested === RUNTIME_STATE.HALTED
      ? requested
      : state.runtime_state;

  const now = nowIso();
  state.runtime_state = target;
  state.runtime_state_ts = now;
  state.last_reconcile_ts = now;

  if (target === RUNTIME_STATE.RUNNING) {
    state.halted = false;
    state.halt_reason = null;
    state.reconcile.active = false;
    state.reconcile.reason = null;
    state.reconcile.started_at = null;
    state.reconcile.retry_count = 0;
    state.reconcile.last_success_at = now;
    state.reconcile.last_error = null;
  } else if (target === RUNTIME_STATE.RECONCILING) {
    state.halted = false;
    state.reconcile.active = true;
    state.reconcile.reason = reason || state.reconcile.reason || 'reconciliation_in_progress';
    state.reconcile.started_at = state.reconcile.started_at || now;
  } else if (target === RUNTIME_STATE.HALTED) {
    state.halted = true;
    state.halt_reason = reason || state.halt_reason || 'halted';
    state.reconcile.active = false;
    state.reconcile.last_failure_at = now;
    state.reconcile.last_error = reason || state.reconcile.last_error || state.halt_reason || 'halted';
  }

  return state;
}
