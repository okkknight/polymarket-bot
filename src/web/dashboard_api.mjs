#!/usr/bin/env node
/**
 * Polymarket Bot - Monitoring Dashboard API Server
 * 
 * Provides read-only APIs for live monitoring
 * Connected to real exchange data via bridge
 * 
 * Run: node dashboard_api.mjs
 * Default port: 3456
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isUnresolvedOrderStatus } from '../core/execution/limit_order_executor.mjs';
import { fileURLToPath } from 'node:url';

const PORT = process.env.DASHBOARD_PORT || 3456;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const DATA_DIR = (() => {
  const configured = process.env.DATA_DIR || './data';
  return path.isAbsolute(configured) ? configured : path.resolve(APP_ROOT, configured);
})();
const PYTHON_BIN = process.env.POLY_PYTHON || path.join(APP_ROOT, '.venv-clob/bin/python3');
const BRIDGE_PATH = path.join(APP_ROOT, 'execution/live_gateway_bridge.py');
const RUN_VERDICT_PATH = path.join(DATA_DIR, 'run_verdict.json');
const DEBUG_DASHBOARD_ENV = /^(1|true|yes)$/i.test(String(process.env.DEBUG_DASHBOARD_ENV || ''));
let CACHED_LIVE_ENV = null;
let CACHED_LIVE_ENV_SOURCE = null;
let LIVE_ENV_LOGGED = false;

function logLiveEnvSummaryOnce() {
  if (LIVE_ENV_LOGGED) return;
  LIVE_ENV_LOGGED = true;
  const loadedCount = Object.keys(CACHED_LIVE_ENV || {}).length;
  if (DEBUG_DASHBOARD_ENV) {
    console.log(
      `[dashboard-env] source=${CACHED_LIVE_ENV_SOURCE || 'none'} loaded_vars=${loadedCount}`
    );
    return;
  }
  if (CACHED_LIVE_ENV_SOURCE) {
    console.log(`[dashboard-env] loaded env from ${path.basename(CACHED_LIVE_ENV_SOURCE)}`);
  }
}

function loadLiveEnvFromFile() {
  if (CACHED_LIVE_ENV) return CACHED_LIVE_ENV;
  const candidates = [
    path.join(SCRIPT_DIR, '.env.live.local'),
    path.join(process.cwd(), '.env.live.local'),
  ];
  const loaded = {};
  for (const p of candidates) {
    if (!fs.existsSync(p)) {
      if (DEBUG_DASHBOARD_ENV) {
        console.log(`[dashboard-env] env file not found: ${p}`);
      }
      continue;
    }
    if (DEBUG_DASHBOARD_ENV) {
      console.log(`[dashboard-env] loading env from: ${p}`);
    }
    CACHED_LIVE_ENV_SOURCE = p;
    const envContent = fs.readFileSync(p, 'utf-8');
    let count = 0;
    envContent.split('\n').forEach(line => {
      const raw = String(line || '').trim();
      if (!raw || raw.startsWith('#')) return;
      const idx = raw.indexOf('=');
      if (idx <= 0) return;
      const key = raw.slice(0, idx).trim();
      let value = raw.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      loaded[key] = value;
      count++;
    });
    if (DEBUG_DASHBOARD_ENV) {
      console.log(`[dashboard-env] loaded ${count} vars from ${path.basename(p)}`);
    }
    // SCRIPT_DIR path has highest priority; once found, stop.
    if (p.startsWith(SCRIPT_DIR)) break;
  }
  CACHED_LIVE_ENV = loaded;
  logLiveEnvSummaryOnce();
  return CACHED_LIVE_ENV;
}

const LIVE_FILE_ENV = loadLiveEnvFromFile();

// Helper to call bridge
function bridgeCall(action, payload = {}) {
  const TIMEOUT_MS = 15000;
  return new Promise((resolve) => {
    let settled = false;
    let python = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (python && !python.killed) {
        try {
          python.kill('SIGTERM');
        } catch {}
      }
      finish({ ok: false, error: `bridge_call_timeout_${TIMEOUT_MS}ms` });
    }, TIMEOUT_MS);

    // Load env vars from fixed live env path(s)
    const env = { ...process.env, ...LIVE_FILE_ENV };
    try {
      python = spawn(PYTHON_BIN, [
        BRIDGE_PATH,
        action,
        JSON.stringify(payload)
      ], {
        cwd: APP_ROOT,
        env,
      });
    } catch (e) {
      finish({ ok: false, error: `bridge_spawn_error: ${e.message}` });
      return;
    }
    
    let stdout = '';
    let stderr = '';
    
    python.stdout.on('data', (data) => { stdout += data; });
    python.stderr.on('data', (data) => { stderr += data; });

    python.on('error', (e) => {
      finish({ ok: false, error: `bridge_spawn_error: ${e.message}` });
    });
    
    python.on('close', (code) => {
      if (code !== 0 && stderr) {
        console.error(`Bridge error: ${stderr}`);
        finish({ ok: false, error: stderr });
        return;
      }
      try {
        finish(JSON.parse(stdout));
      } catch (e) {
        const extra = stderr ? ` stderr=${stderr}` : '';
        finish({ ok: false, error: `parse_error: ${stdout}${extra}` });
      }
    });
  });
}

// Helper to read JSON file
function readJsonFile(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

// Helper to read JSONL file (last N lines) - real-time
function readJsonlFile(filepath, lastN = 200) {
  try {
    const content = fs.readFileSync(filepath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    const events = lines.slice(-lastN).map(l => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
    return events;
  } catch (e) {
    return [];
  }
}

function parsePositiveInt(value, fallback, { min = 1, max = 200 } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function resolveEventsPath() {
  const pointerPath = path.join(DATA_DIR, 'current_events_path.txt');
  try {
    const target = fs.readFileSync(pointerPath, 'utf-8').trim();
    if (target) {
      if (path.isAbsolute(target) && fs.existsSync(target)) return target;
      const candidateBases = [path.dirname(DATA_DIR), DATA_DIR, SCRIPT_DIR];
      for (const base of candidateBases) {
        const candidate = path.resolve(base, target);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {}

  const fallbacks = [
    path.join(DATA_DIR, 'events.jsonl'),
    path.join(DATA_DIR, 'paper_trading_realtime_events.jsonl'),
    path.join(DATA_DIR, 'live_canary_3m_auto_events.jsonl'),
  ];
  for (const candidate of fallbacks) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return fallbacks[0];
}

// GET /api/overview - combines bot state + exchange state
async function handleOverview() {
  // Bot state
  const state = readJsonFile(path.join(DATA_DIR, 'trader_state.json')) || {};
  const events = readJsonlFile(resolveEventsPath(), 10);
  const lastEvent = events[events.length - 1] || {};
  const runVerdict = readJsonFile(RUN_VERDICT_PATH) || {};
  
  // Legacy support for old state format
  const intents = state.intents || state.execution_ledger?.intents || {};
  
  // Cash truth: determine canonical cash source based on mode
  const isLive = state.mode === 'live';
  const canonicalCashSource = state.canonical_cash_source || (isLive ? 'exchange' : 'paper');
  const paperCash = state.paper_cash ?? state.cash ?? 1000;
  
  // Exchange state - get balance (normalized)
  let exchangeBalance = null;
  let exchangeOpenOrders = [];
  let exchangePositionsResult = {};
  let claimableMarkets = [];
  
  try {
    // Get positions from exchange
    const posResult = await bridgeCall('get_positions', {});
    if (posResult.ok) {
      exchangePositionsResult = posResult.positions || {};
    }

    // Get open orders from dedicated endpoint (no longer bundled in get_positions)
    const ooResult = await bridgeCall('open_orders', {});
    if (ooResult.ok) {
      exchangeOpenOrders = ooResult.orders || [];
    }
    
    // Get collateral balance (USDC has 6 decimals)
    const balResult = await bridgeCall('balance', {});
    if (balResult.ok) {
      exchangeBalance = parseFloat(balResult.balance || '0') / 1e6;
    }
    
    // Get claimable markets
    const claimResult = await bridgeCall('get_claimable_markets', {});
    if (claimResult.ok) {
      claimableMarkets = claimResult.claimable_markets || [];
    }
  } catch (e) {
    console.error('Exchange query error:', e.message);
  }
  
  // Calculate totals
  const botOpenOrders = Object.keys(intents).length;
  
  // Use canonical cash for live/canary, paper cash only for debug display
  const canonicalCash = isLive ? (exchangeBalance ?? paperCash) : paperCash;
  
  // Exposure ledger - counts by source and lifecycle
  const holdings = state.exposure_ledger?.holdings || {};
  const avgPrices = state.exposure_ledger?.avg_prices || {};
  const sourceByAsset = state.exposure_ledger?.source_by_asset || {};
  const lifecycleByAsset = state.exposure_ledger?.lifecycle_by_asset || {};
  const syncedAt = state.exposure_ledger?.synced_at || null;
  const adoptedAt = state.exposure_ledger?.adopted_at || null;
  
  const holdingCount = Object.keys(holdings).filter(k => Math.abs(holdings[k] || 0) > 0.001).length;
  
  // Count by source
  const unmanagedCount = Object.values(sourceByAsset).filter(s => s === 'unmanaged_historical').length;
  const managedCount = Object.values(sourceByAsset).filter(s => s === 'managed_by_bot').length;
  const recoveredCount = Object.values(sourceByAsset).filter(s => s === 'recovered_from_exchange').length;
  const confirmedCount = Object.values(sourceByAsset).filter(s => s === 'recovered_from_exchange_confirmed' || s === 'recovered_from_exchange_confirmed_auto').length;
  
  // Count by lifecycle
  const activeOpenCount = Object.values(lifecycleByAsset).filter(l => l === 'active_open').length;
  const resolvedUnclaimedCount = Object.values(lifecycleByAsset).filter(l => l === 'resolved_unclaimed').length;
  const claimedClosedCount = Object.values(lifecycleByAsset).filter(l => l === 'claimed_closed').length;
  const historicalClosedCount = Object.values(lifecycleByAsset).filter(l => l === 'historical_closed').length;
  
  // Unconfirmed = any holding that is NOT managed_by_bot OR recovered_from_exchange_confirmed
  const unconfirmedCount = holdingCount - managedCount - confirmedCount;
  
  // Exchange holdings count
  const exchangeHoldingsCount = Object.keys(exchangePositionsResult).filter(k => {
    const p = exchangePositionsResult[k];
    return Math.abs((p.yes || 0) - (p.no || 0)) > 0.001;
  }).length;
  
  // Settlement ledger
  const settlementMarkets = state.settlement_ledger?.markets || {};
  const claimableCount = Object.keys(settlementMarkets).filter(k => 
    settlementMarkets[k].status === 'CLAIMABLE'
  ).length;
  
  // Calculate total claimable value
  let claimableValueTotal = 0;
  for (const m of claimableMarkets) {
    claimableValueTotal += m.claimable_value || 0;
  }
  
  return {
    // Bot state
    bot_status: state.halted ? 'halted' : 'running',
    mode: state.mode || 'live',
    // Cash truth: canonical cash is exchange for live/canary
    canonical_cash: canonicalCash,
    canonical_cash_source: canonicalCashSource,
    paper_cash: paperCash,
    exchange_cash: exchangeBalance,
    // Legacy / debug
    bot_cash: canonicalCash,
    bot_equity: canonicalCash,
    bot_holdings_count: holdingCount,
    bot_open_orders: botOpenOrders,
    
    // Exchange state (normalized)
    exchange_balance: exchangeBalance,
    exchange_open_orders: exchangeOpenOrders.length,
    exchange_holdings_count: exchangeHoldingsCount,
    
    // Derived / reconciliation
    claimable_markets_count: claimableMarkets.length,
    claimable_value_total: claimableValueTotal,
    settlement_markets_count: Object.keys(settlementMarkets || {}).length,
    
    // Exposure sync status
    exposure_synced_at: syncedAt,
    exposure_adopted_at: adoptedAt,
    exposure_unmanaged_count: unmanagedCount,
    exposure_managed_count: managedCount,
    exposure_recovered_count: recoveredCount,
    exposure_confirmed_count: confirmedCount,
    exposure_unconfirmed_count: unconfirmedCount,
    exposure_active_open_count: activeOpenCount,
    exposure_resolved_unclaimed_count: resolvedUnclaimedCount,
    exposure_claimed_closed_count: claimedClosedCount,
    exposure_historical_closed_count: historicalClosedCount,
    exposure_sync_status: state.halted && state.halt_reason?.includes('unconfirmed') ? 'HALTED_UNCONFIRMED' : (unconfirmedCount > 0 ? 'UNCONFIRMED_HOLDINGS' : (syncedAt ? 'SYNCED' : 'NOT_SYNCED')),
    run_verdict_action: runVerdict?.verdict?.action || null,
    run_verdict_real_fill: runVerdict?.verdict?.real_fill ?? null,
    run_verdict_consistency: runVerdict?.verdict?.consistency_status || null,
    
    // Legacy
    last_event_ts: lastEvent.ts || null,
    halted: state.halted || false,
    halt_reason: state.halt_reason || null,
  };
}

// GET /api/verdict - latest run verdict center output
function handleVerdict() {
  return readJsonFile(RUN_VERDICT_PATH) || {};
}

// GET /api/orders - combines bot orders + exchange orders
async function handleOrders() {
  // Bot orders from state
  const state = readJsonFile(path.join(DATA_DIR, 'trader_state.json')) || {};
  const intents = state.intents || {};
  
  // Exchange orders
  let exchangeOrders = [];
  try {
    const result = await bridgeCall('open_orders', {});
    if (result.ok) {
      exchangeOrders = result.orders || [];
    }
  } catch (e) {
    console.error('Exchange orders error:', e.message);
  }
  
  // Combine bot orders
  const botOrders = Object.entries(intents).map(([clientOrderId, order]) => ({
    source: 'bot',
    client_order_id: clientOrderId,
    market_id: order.market_id || null,
    side: order.side || null,
    original_size: order.original_size || order.size || 0,
    executed_size: order.executed_size || 0,
    remaining_size: (order.original_size || order.size || 0) - (order.executed_size || 0),
    status: order.status || 'unknown',
    raw_status: order.raw_status || null,
    order_id: order.order_id || null,
    fill_price: order.fill_price || null,
    lifecycle_finalized_at: order.lifecycle_finalized_at || null,
    resolution_source: order.lifecycle_resolution_reason || null,
  }));
  
  // Add exchange-only orders
  const botOrderIdSet = new Set(
    Object.values(intents).flatMap((bo) => [
      String(bo?.client_order_id || ''),
      String(bo?.order_id || ''),
    ].filter(Boolean))
  );

  const exchangeOnlyOrders = exchangeOrders
    .filter(eo => {
      const exchangeOrderId = String(eo.orderID || eo.order_id || '');
      return exchangeOrderId ? !botOrderIdSet.has(exchangeOrderId) : true;
    })
    .map(eo => ({
      source: 'exchange',
      client_order_id: eo.orderID || eo.order_id || 'unknown',
      market_id: eo.market || null,
      side: eo.side || null,
      original_size: Number(eo.size) || 0,
      executed_size: Number(eo.size_matched || eo.sizeMatched || 0),
      remaining_size: (Number(eo.size) || 0) - (Number(eo.size_matched || eo.sizeMatched || 0)),
      status: eo.status || 'unknown',
      raw_status: eo.status || null,
      order_id: eo.orderID || eo.order_id || null,
      fill_price: eo.price || null,
      lifecycle_finalized_at: null,
      resolution_source: 'exchange_only',
    }));
  
  return [...botOrders, ...exchangeOnlyOrders];
}

// GET /api/positions - exchange positions + bot exposure ledger with reconciliation
async function handlePositions({ page = null, pageSize = null } = {}) {
  // Bot state
  const state = readJsonFile(path.join(DATA_DIR, 'trader_state.json')) || {};
  
  // Get holdings from exposure ledger
  const holdings = state.exposure_ledger?.holdings || {};
  const avgPrices = state.exposure_ledger?.avg_prices || {};
  
  // Exchange positions from trades
  let exchangePositionsResult = {};
  try {
    const result = await bridgeCall('get_positions', {});
    if (result.ok) {
      exchangePositionsResult = result.positions || {};
    }
  } catch (e) {
    console.error('Exchange positions error:', e.message);
  }
  
  const positions = [];
  const allAssets = new Set([
    ...Object.keys(holdings).filter(k => Math.abs(holdings[k] || 0) > 0.001),
    ...Object.keys(exchangePositionsResult).filter(k => {
      const p = exchangePositionsResult[k];
      return Math.abs((p.yes || 0) - (p.no || 0)) > 0.001;
    })
  ]);
  
  for (const asset of allAssets) {
    const botQty = holdings[asset] || 0;
    const exchangePos = exchangePositionsResult[asset] || {};
    const exchangeNet = (exchangePos.yes || 0) - (exchangePos.no || 0);
    const exchangeQty = Math.abs(exchangeNet);
    
    const outcome = exchangeNet > 0 ? 'yes' : (exchangeNet < 0 ? 'no' : (botQty > 0 ? 'unknown' : '-'));
    
    // Compare absolute values since sign indicates outcome
    const diff = Math.abs(botQty) - exchangeQty;
    
    positions.push({
      source: 'bot',
      asset_id: asset,
      outcome: outcome,
      bot_qty: botQty,
      exchange_qty: exchangeQty,
      avg_price: avgPrices[asset] || 0,
      diff: diff,
    });
  }
  
  positions.sort((a, b) => {
    const aMismatch = Math.abs(Number(a?.diff || 0)) > 0.001 ? 1 : 0;
    const bMismatch = Math.abs(Number(b?.diff || 0)) > 0.001 ? 1 : 0;
    if (aMismatch !== bMismatch) return bMismatch - aMismatch;
    return String(a?.asset_id || '').localeCompare(String(b?.asset_id || ''));
  });

  const hasPageParam = page !== null && page !== undefined && String(page).trim() !== '';
  const hasPageSizeParam = pageSize !== null && pageSize !== undefined && String(pageSize).trim() !== '';
  const pagingRequested = hasPageParam || hasPageSizeParam;
  if (!pagingRequested) {
    return positions;
  }

  const safePageSize = parsePositiveInt(pageSize, 20, { min: 5, max: 200 });
  const total = positions.length;
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const safePage = parsePositiveInt(page, 1, { min: 1, max: totalPages });
  const start = (safePage - 1) * safePageSize;
  const end = start + safePageSize;
  const items = positions.slice(start, end);

  return {
    items,
    page: safePage,
    page_size: safePageSize,
    total,
    total_pages: totalPages,
  };
}

// GET /api/events - real-time from events.jsonl
function handleEvents() {
  return readJsonlFile(resolveEventsPath(), 200);
}

// GET /api/health - exchange connectivity + bot state
async function handleHealth() {
  const startedAt = Date.now();
  // Check exchange connectivity
  let exchangeOk = false;
  let exchangeError = null;
  
  try {
    const result = await bridgeCall('health', {});
    exchangeOk = result.ok === true || result.status === 'ok';
    exchangeError = result.error;
  } catch (e) {
    exchangeOk = false;
    exchangeError = e.message;
  }
  
  // Bot state
  const state = readJsonFile(path.join(DATA_DIR, 'trader_state.json')) || {};
  const lastUpdate = state.updated_at;
  const now = Date.now();
  const isStale = !lastUpdate || (now - new Date(lastUpdate).getTime()) > 60000;
  
  // Count unresolved orders
  const intents = state.intents || state.execution_ledger?.intents || {};
  const unresolvedCount = Object.values(intents).filter(o => {
    const s = String(o.status || '').toLowerCase();
    return isUnresolvedOrderStatus(s);
  }).length;
  
  // Keep /api/health lightweight. Heavy exchange data is already served by /api/positions and /api/claims.
  const mismatchCount = Number(state.exposure_ledger?.unmanaged_count || 0);
  const claimableCount = null;
  
  return {
    exchange_connectivity: exchangeOk ? 'ok' : 'error',
    exchange_error: exchangeError,
    reconciliation_status: state.exposure_ledger?.last_reconcile_ts ? 'ok' : 'not_run',
    mismatch_count: mismatchCount,
    claim_queue_size: claimableCount,
    bot_alive: !isStale,
    bot_halted: state.halted || false,
    unresolved_orders: unresolvedCount,
    last_update_ts: lastUpdate,
    
    // Cash truth for live/canary
    canonical_cash_source: state.canonical_cash_source || (state.mode === 'live' ? 'exchange' : 'paper'),
    exchange_cash: state.exchange_cash_balance,
    paper_cash: state.paper_cash,
    
    // Exposure sync info
    exposure_synced_at: state.exposure_ledger?.synced_at || null,
    exposure_unmanaged_count: state.exposure_ledger?.unmanaged_count || 0,
    exposure_sync_status: state.halt_reason === 'unmanaged_historical_holdings' ? 'HALTED_UNMANAGED' : (state.exposure_ledger?.synced_at ? 'SYNCED' : 'NOT_SYNCED'),
    halt_reason: state.halt_reason || null,
    health_latency_ms: Date.now() - startedAt,
  };
}

// GET /api/claims - claimable markets
async function handleClaims() {
  try {
    const result = await bridgeCall('get_claimable_markets', {});
    if (result.ok) {
      return result.claimable_markets || [];
    }
  } catch (e) {
    console.error('Claims error:', e.message);
  }
  return [];
}

// GET /api/canary - canary run status
async function handleCanaryStatus() {
  // Check for runs directory
  const runsDir = path.join(APP_ROOT, 'runs');
  let runs = [];
  try {
    const entries = fs.readdirSync(runsDir, { withFileTypes: true });
    runs = entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
      .reverse()
      .slice(0, 5);
  } catch (e) {}
  
  // Get latest run info
  let latestRun = null;
  let preSnapshot = null;
  let postReport = null;
  
  if (runs.length > 0) {
    latestRun = runs[0];
    const runDir = path.join(runsDir, latestRun);
    
    try {
      preSnapshot = readJsonFile(path.join(runDir, 'pre_run_snapshot.json'));
    } catch (e) {}
    
    try {
      postReport = readJsonFile(path.join(runDir, 'post_run_report.json'));
    } catch (e) {}
  }
  
  // Current state
  const state = readJsonFile(path.join(DATA_DIR, 'trader_state.json')) || {};
  
  // Get current holdings
  const holdings = state.exposure_ledger?.holdings || {};
  const holdingsCount = Object.keys(holdings).filter(k => Math.abs(holdings[k] || 0) > 0.001).length;
  
  // Get exchange positions
  let exchangePositions = {};
  try {
    const result = await bridgeCall('get_positions', {});
    if (result.ok) exchangePositions = result.positions || {};
  } catch (e) {}
  
  const exchHoldingsCount = Object.keys(exchangePositions).filter(k => {
    const p = exchangePositions[k];
    return Math.abs((p.yes || 0) - (p.no || 0)) > 0.001;
  }).length;
  
  return {
    canary_active: false, // Would need to check if bot is running
    latest_run_id: latestRun,
    pre_snapshot: preSnapshot ? {
      run_id: preSnapshot.run_id,
      timestamp: preSnapshot.timestamp,
      exchange_balance: preSnapshot.exchange?.balance,
      holdings_count: preSnapshot.exchange?.holdings_count,
    } : null,
    post_report: postReport ? {
      run_id: postReport.run_id,
      timestamp: postReport.timestamp,
      success: postReport.success,
      total_orders: postReport.summary?.total_orders,
      matched_orders: postReport.summary?.matched_orders,
      halted: postReport.state?.halted,
    } : null,
    current_state: {
      halted: state.halted || false,
      halt_reason: state.halt_reason || null,
      holdings_count: holdingsCount,
      exchange_holdings_count: exchHoldingsCount,
      exposure_sync_status: state.exposure_ledger?.last_reconcile_ts ? 'SYNCED' : 'NOT_SYNCED',
      unresolved_orders: Object.keys(state.intents || {}).filter(k => {
        const s = String(state.intents[k]?.status || '').toLowerCase();
        return isUnresolvedOrderStatus(s);
      }).length,
    },
  };
}
// Main request handler
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const reqPath = url.pathname;
  
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }
  
  try {
    let result;
    
    switch (reqPath) {
      case '/api/overview':
        result = await handleOverview();
        break;
      case '/api/orders':
        result = await handleOrders();
        break;
      case '/api/positions':
        result = await handlePositions({
          page: url.searchParams.get('page'),
          pageSize: url.searchParams.get('pageSize'),
        });
        break;
      case '/api/events':
        result = handleEvents();
        break;
      case '/api/health':
        result = await handleHealth();
        break;
      case '/api/verdict':
        result = handleVerdict();
        break;
      case '/api/claims':
        result = await handleClaims();
        break;
      case '/api/canary':
        result = await handleCanaryStatus();
        break;
      case '/api':
        result = {
          endpoints: [
            '/api/overview',
            '/api/orders', 
            '/api/positions',
            '/api/events',
            '/api/health',
            '/api/verdict',
            '/api/claims',
            '/api/canary',
          ],
        };
        break;
      default:
        // Check for static files (dashboard.html)
        if (reqPath === '/' || reqPath === '/dashboard.html') {
          try {
            const html = fs.readFileSync(path.join(APP_ROOT, 'dashboard.html'), 'utf-8');
            res.setHeader('Content-Type', 'text/html');
            res.writeHead(200);
            res.end(html);
            return;
          } catch (e) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'dashboard.html not found' }));
            return;
          }
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
    }
    
    res.writeHead(200);
    res.end(JSON.stringify(result, null, 2));
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
}

const server = http.createServer(handleRequest);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Dashboard API] Listening on http://localhost:${PORT}`);
  console.log(`[Dashboard API] Endpoints:`);
  console.log(`  GET /api/overview (bot + exchange)`);
  console.log(`  GET /api/orders (bot + exchange)`);
  console.log(`  GET /api/positions (bot + exchange)`);
  console.log(`  GET /api/events (real-time)`);
  console.log(`  GET /api/health`);
  console.log(`  GET /api/verdict`);
  console.log(`  GET /api/claims`);
});

export { server };
