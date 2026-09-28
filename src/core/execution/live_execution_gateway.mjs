import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateLiveGatewayConfig, validateOrderIntentPayload, mapLiveGatewayError } from './live_config_guard.mjs';

const DEFAULT_BASE = 'https://clob.polymarket.com';
const BRIDGE = fileURLToPath(new URL('../../../execution/live_gateway_bridge.py', import.meta.url));
const DEFAULT_PYTHON = process.env.POLY_PYTHON || fileURLToPath(new URL('../../../.venv-clob/bin/python3', import.meta.url));

function normalizeOrderStatus(s, originalSize = null, executedSize = null) {
  const v = String(s || '').toLowerCase();
  if (!v) return null;
  
  // Handle MATCHED status - this is a real fill
  if (v === 'matched') {
    // Use size_matched vs original_size to determine exact state.
    // If execution is unknown at submit time, do not force terminal cancellation.
    const hasExec = Number.isFinite(Number(executedSize));
    const hasOrig = Number.isFinite(Number(originalSize));
    const exec = hasExec ? Number(executedSize) : null;
    const orig = hasOrig ? Number(originalSize) : null;

    if (!hasExec) return 'acknowledged';
    if (exec <= 0) return 'canceled';
    if (hasOrig && orig > 0 && exec >= orig) return 'filled';
    return 'partial_filled';
  }
  
  // Standard status mappings
  if (v === 'live' || v === 'open') return 'acknowledged';
  if (v === 'partially_filled' || v === 'partial') return 'partial_filled';
  if (v === 'cancelled' || v === 'canceled') return 'canceled';
  if (v === 'filled' || v === 'complete') return 'filled';
  if (v === 'expired') return 'expired';
  if (v === 'rejected') return 'rejected';
  
  return v;
}

function bridgeCall(action, payload = {}) {
  const startedAt = Date.now();
  const timeoutMs = Number(process.env.LIVE_BRIDGE_TIMEOUT_MS || 45000);
  try {
    const out = execFileSync(DEFAULT_PYTHON, [BRIDGE, action, JSON.stringify(payload)], {
      env: process.env,
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    const elapsedMs = Date.now() - startedAt;
    const j = JSON.parse(out || '{}');
    if (!j?.ok) throw new Error(j?.error || 'bridge_call_failed');
    return { ...j, bridge_elapsed_ms: elapsedMs, bridge_timeout_ms: timeoutMs };
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    const stdout = String(e?.stdout || '').trim();
    const stderr = String(e?.stderr || '').trim();
    let detail = stderr || stdout || e?.message || 'bridge_exec_failed';
    try {
      const j = JSON.parse(stdout || '{}');
      if (j?.error) detail = j.error;
    } catch {}
    const code = e?.code || e?.status || 'unknown';
    const signal = e?.signal || 'none';
    throw new Error(`bridge_exec_failed:action=${action}:elapsed_ms=${elapsedMs}:timeout_ms=${timeoutMs}:code=${code}:signal=${signal}:detail=${detail}`);
  }
}

export function createLiveExecutionGateway({
  baseUrl = process.env.POLY_CLOB_BASE_URL || DEFAULT_BASE,
  apiKey = process.env.POLY_CLOB_API_KEY || '',
  orderPath = process.env.POLY_CLOB_ORDER_PATH || '/order',
  orderStatusPath = process.env.POLY_CLOB_ORDER_STATUS_PATH || '/order/{orderId}',
} = {}) {
  const base = String(baseUrl).replace(/\/$/, '');
  const cfgCheck = validateLiveGatewayConfig({
    apiKey,
    apiSecret: process.env.POLY_CLOB_API_SECRET || '',
    apiPassphrase: process.env.POLY_CLOB_API_PASSPHRASE || '',
    baseUrl: base,
    orderPath,
    orderStatusPath,
    privateKey: process.env.PRIVATE_KEY || '',
    accountOwner: process.env.POLY_ACCOUNT_OWNER || process.env.POLY_FUNDER || '',
    funder: process.env.POLY_FUNDER || '',
  });

  return {
    async submitLimitOrder(intent) {
      if (!cfgCheck.ok) throw new Error(`live_gateway_config_invalid:${cfgCheck.issues.join(',')}`);
      const payloadCheck = validateOrderIntentPayload(intent);
      if (!payloadCheck.ok) throw new Error(`live_order_payload_invalid:${payloadCheck.issues.join(',')}`);
      try {
        const j = bridgeCall('submit', intent);
        const rawStatus = j.raw_status || j.status || null;
        const fillSizeRaw = j.executed_size ?? j.fill_size;
        const fillSize = Number.isFinite(Number(fillSizeRaw)) ? Number(fillSizeRaw) : undefined;
        const originalSize = Number.isFinite(Number(j.original_size))
          ? Number(j.original_size)
          : Number.isFinite(Number(intent?.size))
            ? Number(intent.size)
            : undefined;
        return {
          client_order_id: intent.client_order_id,
          order_id: String(j.order_id || `live_${intent.client_order_id}`),
          status: normalizeOrderStatus(rawStatus, originalSize, fillSize) || 'acknowledged',
          ack_ts: new Date().toISOString(),
          fill_price: Number.isFinite(Number(j.fill_price)) ? Number(j.fill_price) : undefined,
          fill_size: fillSize,
          raw_status: rawStatus,
          original_size: originalSize,
          source: j.source || 'py_clob_client_v2_submit',
        };
      } catch (e) {
        const kind = mapLiveGatewayError(e);
        throw new Error(`live_submit_${kind}:${e?.message || e}`);
      }
    },

    async queryOrderStatus(record) {
      if (!cfgCheck.ok) return { status: null, source: 'live_gateway_query', reason: `config_invalid:${cfgCheck.issues.join(',')}` };
      if (!record?.order_id) return { status: null, source: 'live_gateway_query', reason: 'missing_order_id' };
      try {
        const j = bridgeCall('query', { order_id: record.order_id });
        
        // Extract execution fields from response
        const originalSize = j.original_size;
        const executedSize = j.executed_size;
        
        return {
          status: normalizeOrderStatus(j.status, originalSize, executedSize) || null,
          source: j.source || 'py_clob_client_v2_query',
          raw_status: j.raw_status || null,
          // Execution fields - CRITICAL for fill tracking
          original_size: Number.isFinite(Number(originalSize)) ? Number(originalSize) : null,
          executed_size: Number.isFinite(Number(executedSize)) ? Number(executedSize) : null,
          fill_price: Number.isFinite(Number(j.fill_price)) ? Number(j.fill_price) : null,
          side: j.side || null,
          outcome: j.outcome || null,
          associated_trades: j.associated_trades || [],
        };
      } catch (e) {
        const kind = mapLiveGatewayError(e);
        return { status: null, source: 'live_gateway_query', reason: `query_${kind}` };
      }
    },

    async cancelOrder(record) {
      if (!cfgCheck.ok) throw new Error(`live_gateway_config_invalid:${cfgCheck.issues.join(',')}`);
      if (!record?.order_id) throw new Error('missing_order_id');
      try {
        const j = bridgeCall('cancel', { order_id: record.order_id });
        return {
          status: normalizeOrderStatus(j.status) || 'canceled',
          source: j.source || 'py_clob_client_v2_cancel',
        };
      } catch (e) {
        const kind = mapLiveGatewayError(e);
        throw new Error(`live_cancel_${kind}:${e?.message || e}`);
      }
    },

    // Exchange reconciliation: query all open orders from the exchange
    async getOpenOrders() {
      if (!cfgCheck.ok) return { orders: [], reason: `config_invalid:${cfgCheck.issues.join(',')}` };
      try {
        const j = await bridgeCall('open_orders', {});
        if (j?.ok === false) {
          return { orders: [], reason: j.error || 'query_failed', source: j.source || 'py_clob_client_v2_get_open_orders' };
        }
        return {
          orders: Array.isArray(j.orders) ? j.orders : [],
          source: j.source || 'py_clob_client_v2_get_open_orders',
        };
      } catch (e) {
        const kind = mapLiveGatewayError(e);
        return { orders: [], reason: `query_${kind}` };
      }
    },

    // Exchange reconciliation: query positions from the exchange
    async getPositions() {
      if (!cfgCheck.ok) return { positions: [], reason: `config_invalid:${cfgCheck.issues.join(',')}` };
      try {
        const j = await bridgeCall('get_positions', {});
        if (j?.ok === false) {
          return { positions: [], reason: j.error || 'query_failed', source: j.source || 'polymarket_data_api_account_positions' };
        }
        // Bridge returns {positions: {...}} but gateway expects array
        const pos = j.positions || {};
        // Convert to array format for compatibility
        const posArray = Object.entries(pos).map(([asset, v]) => ({
          asset_id: asset,
          yes: v.yes || 0,
          no: v.no || 0,
          avg_price: v.avg_price || 0,
        }));
        return {
          positions: posArray,
          account_owner: j.account_owner || null,
          source: j.source || 'polymarket_data_api_account_positions',
          bridge_elapsed_ms: j.bridge_elapsed_ms,
          bridge_timeout_ms: j.bridge_timeout_ms,
          timing_ms: j.timing_ms,
          counts: j.counts,
        };
      } catch (e) {
        const kind = mapLiveGatewayError(e);
        return {
          positions: [],
          reason: `query_${kind}`,
          detail: String(e?.message || e || ''),
          source: 'live_gateway_query',
        };
      }
    },

    // Get exchange minimum order size for a token
    async getMinOrderSize(tokenId) {
      if (!cfgCheck.ok) return { minSize: null, reason: `config_invalid:${cfgCheck.issues.join(',')}` };
      try {
        const j = bridgeCall('market', { token_id: tokenId });
        return {
          minSize: Number(j?.min_order_size) || 1,
          source: j.source || 'py_clob_client_v2_get_market',
        };
      } catch (e) {
        const kind = mapLiveGatewayError(e);
        return { minSize: 1, reason: `query_${kind}`, fallback: true };
      }
    },

    // Get markets status (resolution info)
    async getMarketsStatus(marketIds) {
      if (!cfgCheck.ok) return { markets: [], reason: `config_invalid:${cfgCheck.issues.join(',')}` };
      try {
        const j = bridgeCall('get_markets_status', { market_ids: marketIds });
        return {
          markets: Array.isArray(j.markets) ? j.markets : [],
          source: j.source || 'py_clob_client_v2_get_market',
        };
      } catch (e) {
        const kind = mapLiveGatewayError(e);
        return { markets: [], reason: `query_${kind}` };
      }
    },

    // Get this configured account's redeemable positions (read-only).
    async getClaimableMarkets() {
      if (!cfgCheck.ok) return { markets: [], reason: `config_invalid:${cfgCheck.issues.join(',')}` };
      try {
        const j = bridgeCall('get_claimable_markets', {});
        return {
          markets: Array.isArray(j.claimable_markets) ? j.claimable_markets : [],
          account_owner: j.account_owner || null,
          source: j.source || 'polymarket_data_api_account_positions',
        };
      } catch (e) {
        const kind = mapLiveGatewayError(e);
        return { markets: [], reason: `query_${kind}` };
      }
    },

    // Get recent account trades (for recovery evidence backfill)
    async getRecentTrades(limit = Number(process.env.EXPOSURE_SYNC_RECENT_TRADES_LIMIT || 300)) {
      if (!cfgCheck.ok) return { trades: [], reason: `config_invalid:${cfgCheck.issues.join(',')}` };
      try {
        const j = bridgeCall('recent_trades', { limit });
        if (j?.ok === false) {
          return { trades: [], reason: j.error || 'query_failed', source: j.source || 'py_clob_client_v2_get_trades' };
        }
        return {
          trades: Array.isArray(j.trades) ? j.trades : [],
          reason: j.truncated ? 'recent_trades_inconclusive' : null,
          source: j.source || 'py_clob_client_v2_get_trades',
          bridge_elapsed_ms: j.bridge_elapsed_ms,
          bridge_timeout_ms: j.bridge_timeout_ms,
          pages_scanned: j.pages_scanned ?? null,
          truncated: Boolean(j.truncated),
        };
      } catch (e) {
        const kind = mapLiveGatewayError(e);
        return { trades: [], reason: `query_${kind}`, detail: String(e?.message || e || '') };
      }
    },

    // Check exchange health / connectivity
    async healthCheck() {
      if (!cfgCheck.ok) return { ok: false, reason: `config_invalid` };
      try {
        const j = bridgeCall('health', {});
        return {
          ok: j?.ok === true || j?.status === 'ok',
          source: j.source || 'py_clob_client_v2_health',
        };
      } catch (e) {
        return { ok: false, reason: `health_check_failed` };
      }
    },

    // Get exchange cash balance
    async getBalance() {
      if (!cfgCheck.ok) return { ok: false, reason: `config_invalid` };
      try {
        const j = bridgeCall('balance', {});
        return {
          ok: j.ok,
          balance: j.balance || '0',
          allowances: j.allowances || {},
          account_owner: j.account_owner || null,
          source: j.source || 'py_clob_client_v2_get_balance_allowance',
        };
      } catch (e) {
        return { ok: false, reason: `balance_query_failed` };
      }
    },
  };
}
