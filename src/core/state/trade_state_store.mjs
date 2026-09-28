import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ensureRuntimeStateFields } from './runtime_state_controller.mjs';

function withDefaults(state) {
  const normalized = {
    version: state?.version ?? '2.0',
    halted: Boolean(state?.halted),
    halt_reason: state?.halt_reason ?? null,
    cash: state?.cash ?? 1000,
    mode: state?.mode ?? 'live',
    last_reconcile_ts: state?.last_reconcile_ts ?? null,
    intents: state?.intents && typeof state.intents === 'object' ? state.intents : {},
    intent_index: state?.intent_index && typeof state.intent_index === 'object' ? state.intent_index : {},
    
    // Order ledger - CRITICAL: must persist across runs
    orders: state?.orders && typeof state.orders === 'object' ? state.orders : {},
    
    // Cash truth - canonical cash source for live/canary
    canonical_cash_source: state?.canonical_cash_source ?? (state?.mode === 'live' ? 'exchange' : 'paper'),
    exchange_cash_balance: state?.exchange_cash_balance ?? null,
    paper_cash: state?.paper_cash ?? state?.cash ?? 1000,
    
    // Execution ledger
    execution_ledger: state?.execution_ledger ?? { intents: {}, fills: {}, last_fill_ts: null },
    
    // Exposure ledger (new in v2.0)
    exposure_ledger: state?.exposure_ledger ?? {
      holdings: {},
      avg_prices: {},
      source_by_asset: {},
      lifecycle_by_asset: {},
      last_reconcile_ts: null,
      adopted_at: null,
      adopted_by: null,
    },
    
    // Settlement ledger
    settlement_ledger: state?.settlement_ledger ?? { markets: {} },
    
    // Claims
    claims: state?.claims ?? { pending: [], completed: [], failed: [] },
    
    updated_at: state?.updated_at ?? null,
  };

  return ensureRuntimeStateFields(normalized);
}

export async function loadTradeState(path = 'data/trader_state.json') {
  try {
    const raw = await readFile(path, 'utf8');
    return withDefaults(JSON.parse(raw));
  } catch {
    return withDefaults({});
  }
}

export async function saveTradeState(state, path = 'data/trader_state.json') {
  await mkdir('data', { recursive: true });
  const normalized = withDefaults({ ...state, updated_at: new Date().toISOString() });
  await writeFile(path, JSON.stringify(normalized, null, 2), 'utf8');
}

export function buildIntentId({ marketId, tokenId, side, size, limitPrice }) {
  // Deterministic across restarts: MUST NOT include runId / timestamps.
  return [
    String(marketId || ''),
    String(tokenId || ''),
    String(side || ''),
    Number(size).toFixed(6),
    Number(limitPrice).toFixed(6),
  ].join('|');
}
