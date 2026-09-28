#!/usr/bin/env node
// Guard: prevent direct execution without going through ops/scripts
if (!process.env.RUN_VIA_SH) {
  console.error("ERROR: polymarket_paper_trading_realtime.mjs should not be run directly.");
  console.error("Please use the recommended entrypoint: bash ops/scripts/run_live_canary_strict_sync.sh");
  console.error("Or set RUN_VIA_SH=1 to bypass this check (not recommended).");
  process.exit(1);
}

import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { selectFirstTradableRollingMarket, buildRollingSlugCandidates } from '../core/rolling_market_selector.mjs';
import { buildShadowOrderFromSignal, simulateFillPrice, calcFillSlippageBps } from '../core/polymarket_execution_adapter.mjs';
import { loadTradeState, saveTradeState } from '../core/state/trade_state_store.mjs';
import { compactTradeState } from '../core/state/state_compaction.mjs';
import { buildLimitIntent, preTradeGuard, submitLimitIntent, reconcileOrderStatus, isFinalOrderStatus } from '../core/execution/limit_order_executor.mjs';
import { runRecoverySequence, rebuildStateFromExchange } from '../core/execution/recovery_controller.mjs';
import { createLiveExecutionGateway } from '../core/execution/live_execution_gateway.mjs';
import { createLiveRiskTracker, checkLiveRiskGuard, markLiveOrderSent } from '../core/risk/live_guardrails.mjs';
import { validateRuntimeConfig } from '../core/risk/runtime_config_guard.mjs';
import { verifyStrategyEvidenceReport } from '../core/risk/strategy_evidence_guard.mjs';
import { nextBackoffMs, classifyNetworkError, shouldSafeHaltByNetwork } from '../core/execution/network_recovery.mjs';

// Load environment variables from .env.live.local for live mode
import { readFileSync } from 'node:fs';
const envPath = new URL('./.env.live.local', import.meta.url).pathname;
try {
  const envContent = readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  });
} catch (e) {
  // .env.live.local not found, continue without it
}

const GAMMA = 'https://gamma-api.polymarket.com/markets';
const CLOB = 'https://clob.polymarket.com';

const MODE = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : 'paper';

const CFG = {
  mode: MODE,
  liveDryRun: process.argv.includes('--liveDryRun') ? String(process.argv[process.argv.indexOf('--liveDryRun') + 1]).toLowerCase() !== 'false' : true,
  unresolvedOrderLimitMs: Number(process.argv.includes('--unresolvedOrderLimitMs') ? process.argv[process.argv.indexOf('--unresolvedOrderLimitMs') + 1] : 10000),
  resumeFromHalt: process.argv.includes('--resumeFromHalt') ? String(process.argv[process.argv.indexOf('--resumeFromHalt') + 1]).toLowerCase() !== 'false' : false,
  compactEverySec: Number(process.argv.includes('--compactEverySec') ? process.argv[process.argv.indexOf('--compactEverySec') + 1] : 300),
  keepRecentOpen: Number(process.argv.includes('--keepRecentOpen') ? process.argv[process.argv.indexOf('--keepRecentOpen') + 1] : 200),
  netFailThreshold: Number(process.argv.includes('--netFailThreshold') ? process.argv[process.argv.indexOf('--netFailThreshold') + 1] : 3),
  netBackoffBaseMs: Number(process.argv.includes('--netBackoffBaseMs') ? process.argv[process.argv.indexOf('--netBackoffBaseMs') + 1] : 1000),
  netBackoffMaxMs: Number(process.argv.includes('--netBackoffMaxMs') ? process.argv[process.argv.indexOf('--netBackoffMaxMs') + 1] : 15000),
  maxOrderNotional: Number(process.argv.includes('--maxOrderNotional') ? process.argv[process.argv.indexOf('--maxOrderNotional') + 1] : 20),
  maxOrdersPerMinute: Number(process.argv.includes('--maxOrdersPerMinute') ? process.argv[process.argv.indexOf('--maxOrdersPerMinute') + 1] : 6),
  dailyLossLimit: Number(process.argv.includes('--dailyLossLimit') ? process.argv[process.argv.indexOf('--dailyLossLimit') + 1] : 20),
  cooldownSec: Number(process.argv.includes('--cooldownSec') ? process.argv[process.argv.indexOf('--cooldownSec') + 1] : 30),
  maxNoMarketCycles: Number(process.argv.includes('--maxNoMarketCycles') ? process.argv[process.argv.indexOf('--maxNoMarketCycles') + 1] : 12),
  slugPrefix: 'btc-updown-5m',
  watchSec: 30,
  tickSec: 1,
  durationSec: Number(process.argv.includes('--durationSec') ? process.argv[process.argv.indexOf('--durationSec') + 1] : 0),
  // strategy fixed (current best)
  window: 3,
  entryTh: 0.0003,
  gate: 0.00015,
  baseSize: Number(process.argv.includes('--baseSize') ? process.argv[process.argv.indexOf('--baseSize') + 1] : 1),
  minOrderUsd: Number(process.argv.includes('--minOrderUsd') ? process.argv[process.argv.indexOf('--minOrderUsd') + 1] : 1),
  minOrderShares: Number(process.argv.includes('--minOrderShares') ? process.argv[process.argv.indexOf('--minOrderShares') + 1] : 5),
  scaleFactor: 0.0003,
  maxPosition: Number(process.argv.includes('--maxPosition') ? process.argv[process.argv.indexOf('--maxPosition') + 1] : 4),
  singleTradePerTick: true,
  noPyramid: true,
  flip: 'close_only',
  feeRate: 0.001,
  slippageBps: 1,
  fallbackNoMarketSec: 600,
  validationMode: process.argv.includes('--validationMode') ? String(process.argv[process.argv.indexOf('--validationMode') + 1]).toLowerCase() === 'true' : false,
  strategyReportPath: process.argv.includes('--strategyReportPath') ? String(process.argv[process.argv.indexOf('--strategyReportPath') + 1]) : '',
  strategyReportMaxAgeSec: Number(process.argv.includes('--strategyReportMaxAgeSec') ? process.argv[process.argv.indexOf('--strategyReportMaxAgeSec') + 1] : 900),
};

const VALIDATION_GUARDRAILS = {
  MAX_ORDERS_PER_RUN: 1,
  MAX_SHARES_PER_ORDER: 6,
  MAX_TOTAL_SHARES_PER_RUN: 6,
  FIRST_FILL_STOP: true,
};

const TERMINAL_LATE_FILL_AUDIT_WINDOW_MS = Number(process.env.TERMINAL_LATE_FILL_AUDIT_WINDOW_MS || 180000);
const TERMINAL_LATE_FILL_MAX_QUERIES = Number(process.env.TERMINAL_LATE_FILL_MAX_QUERIES || 12);

const OUT_LOG = process.argv.includes('--outLog') ? process.argv[process.argv.indexOf('--outLog') + 1] : 'data/paper_trading_realtime_log.csv';
const OUT_EVENTS = process.argv.includes('--outEvents') ? process.argv[process.argv.indexOf('--outEvents') + 1] : 'data/paper_trading_realtime_events.jsonl';
const OUT_ORDERS = process.argv.includes('--outOrders') ? process.argv[process.argv.indexOf('--outOrders') + 1] : 'data/shadow_trading_orders.csv';
const OUT_EVENTS_POINTER = 'data/current_events_path.txt';
const EXCHANGE_TRADES_SNAPSHOT_LIMIT = Number(process.env.EXCHANGE_TRADES_SNAPSHOT_LIMIT || 500);
const BACKFILL_BALANCE_DROP_THRESHOLD = Number(process.env.BACKFILL_BALANCE_DROP_THRESHOLD || 0.01);

function ts() { return new Date().toISOString(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function toMs(x) { const v = Date.parse(x); return Number.isFinite(v) ? v : null; }

function isTerminalLateFillAuditable(record, nowMs = Date.now()) {
  const status = String(record?.status || '').toLowerCase();
  if (!isFinalOrderStatus(status)) return false;
  if (!['canceled', 'expired', 'rejected'].includes(status)) return false;
  if (record?.late_fill_audit_done_at) return false;
  const executedSize = Number(record?.executed_size || 0);
  if (executedSize > 0) return false;
  const auditCount = Number(record?.late_fill_audit_count || 0);
  if (auditCount >= TERMINAL_LATE_FILL_MAX_QUERIES) return false;
  const refTs = Date.parse(record?.ack_ts || record?.status_ts || record?.ts || 0);
  if (!Number.isFinite(refTs)) return true;
  const ageMs = Math.max(0, nowMs - refTs);
  return ageMs <= TERMINAL_LATE_FILL_AUDIT_WINDOW_MS;
}

async function markTerminalLateFillAudit({
  record,
  onEvent,
  runId,
  marketId,
  nowMs = Date.now(),
}) {
  const status = String(record?.status || '').toLowerCase();
  if (!isFinalOrderStatus(status) || !['canceled', 'expired', 'rejected'].includes(status)) return;

  const executedSize = Number(record?.executed_size || 0);
  if (executedSize > 0) {
    if (!record.late_fill_audit_done_at) {
      record.late_fill_audit_done_at = ts();
      await onEvent('ORDER_TERMINAL_LATE_FILL_AUDIT_CLOSED', {
        run_id: runId,
        market_id: marketId || record?.market_id || null,
        client_order_id: record?.client_order_id,
        order_id: record?.order_id,
        status,
        executed_size: executedSize,
        reason: 'fill_detected',
      });
    }
    return;
  }

  const previousCount = Number(record?.late_fill_audit_count || 0);
  const nextCount = previousCount + 1;
  record.late_fill_audit_count = nextCount;

  const refTs = Date.parse(record?.ack_ts || record?.status_ts || record?.ts || 0);
  const ageMs = Number.isFinite(refTs) ? Math.max(0, nowMs - refTs) : null;
  const windowExpired = Number.isFinite(ageMs) ? ageMs > TERMINAL_LATE_FILL_AUDIT_WINDOW_MS : false;
  const limitReached = nextCount >= TERMINAL_LATE_FILL_MAX_QUERIES;

  await onEvent('ORDER_TERMINAL_LATE_FILL_AUDIT', {
    run_id: runId,
    market_id: marketId || record?.market_id || null,
    client_order_id: record?.client_order_id,
    order_id: record?.order_id,
    status,
    executed_size: executedSize,
    audit_count: nextCount,
    max_audit_queries: TERMINAL_LATE_FILL_MAX_QUERIES,
    age_ms: ageMs,
    window_ms: TERMINAL_LATE_FILL_AUDIT_WINDOW_MS,
    exhausted: windowExpired || limitReached,
  });

  if (windowExpired || limitReached) {
    record.late_fill_audit_done_at = ts();
    record.late_fill_audit_exhausted_reason = windowExpired ? 'window_expired' : 'max_queries_reached';
    await onEvent('ORDER_TERMINAL_LATE_FILL_AUDIT_EXHAUSTED', {
      run_id: runId,
      market_id: marketId || record?.market_id || null,
      client_order_id: record?.client_order_id,
      order_id: record?.order_id,
      status,
      executed_size: executedSize,
      audit_count: nextCount,
      reason: record.late_fill_audit_exhausted_reason,
      age_ms: ageMs,
      window_ms: TERMINAL_LATE_FILL_AUDIT_WINDOW_MS,
      max_audit_queries: TERMINAL_LATE_FILL_MAX_QUERIES,
    });
  }
}

// Use native https for API calls (Node.js fetch doesn't work well with proxy)
import https from 'https';
import http from 'http';
import { URL } from 'url';

function fetchJson(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https://');
    const urlObj = new URL(url);
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
    
    // Proxy tunnel mode for HTTPS
    if (proxyUrl && isHttps) {
      const proxyUrlObj = new URL(proxyUrl);
      
      const options = {
        hostname: proxyUrlObj.hostname,
        port: proxyUrlObj.port || 80,
        method: 'CONNECT',
        path: `${urlObj.hostname}:${urlObj.port || 443}`,
        headers: {
          'Host': `${urlObj.hostname}:${urlObj.port || 443}`
        }
      };
      
      const req = http.request(options);
      
      req.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Proxy connect failed: ${res.statusCode}`));
          return;
        }
        
        // Establish TLS tunnel through proxy
        const tlsOptions = {
          socket: socket,
          servername: urlObj.hostname,
          rejectUnauthorized: false
        };
        
        const tlsReq = https.request({
          ...tlsOptions,
          hostname: urlObj.hostname,
          port: urlObj.port || 443,
          path: urlObj.pathname + urlObj.search,
          method: 'GET',
          headers: {
            'Host': urlObj.hostname
          }
        });
        
        const timeout = setTimeout(() => {
          tlsReq.destroy();
          reject(new Error('timeout'));
        }, timeoutMs);
        
        tlsReq.on('response', (proxyRes) => {
          if (proxyRes.statusCode >= 400) {
            clearTimeout(timeout);
            reject(new Error(`HTTP ${proxyRes.statusCode}`));
            return;
          }
          let data = '';
          proxyRes.on('data', chunk => data += chunk);
          proxyRes.on('end', () => {
            clearTimeout(timeout);
            try {
              resolve(JSON.parse(data));
            } catch(e) {
              reject(new Error('json_parse_error'));
            }
          });
        });
        
        tlsReq.on('error', (e) => {
          clearTimeout(timeout);
          reject(e);
        });
        
        tlsReq.end();
      });
      
      req.on('error', (e) => {
        reject(e);
      });
      
      req.end();
      return;
    }
    
    // Direct connection (or HTTP proxy for HTTP URLs)
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'Host': urlObj.hostname
      }
    };
    
    const client = isHttps ? https : http;
    
    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error('timeout'));
    }, timeoutMs);
    
    const req = client.request(options, (res) => {
      if (res.statusCode >= 400) {
        clearTimeout(timeout);
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          reject(new Error('json_parse_error'));
        }
      });
    });
    
    req.on('error', (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    
    req.end();
  });
}

function parseMaybe(v, fallback = null) {
  if (v == null) return fallback;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
  return v;
}

function parseTokenIdFromClientOrderId(clientOrderId) {
  const text = String(clientOrderId || '');
  if (!text.includes('|')) return '';
  const parts = text.split('|');
  if (parts.length < 2) return '';
  return String(parts[1] || '');
}

function mergeIntentRecord(existing = {}, incoming = {}, orderRec = null) {
  const merged = { ...existing, ...incoming };
  if (!merged.market_id) merged.market_id = orderRec?.market_id || null;
  if (!merged.token_id) merged.token_id = orderRec?.asset_id || orderRec?.token_id || null;
  if (!merged.asset_id) merged.asset_id = orderRec?.asset_id || orderRec?.token_id || null;
  if (!merged.side) merged.side = orderRec?.side || null;
  if (!merged.size) merged.size = orderRec?.size || null;
  if (!merged.limit_price) merged.limit_price = orderRec?.price || orderRec?.limit_price || null;
  return merged;
}

function resolveTokenIdForRecord({ order, clientOrderId = '', orderRecord = null }) {
  return String(
    order?.token_id ||
    order?.asset_id ||
    orderRecord?.asset_id ||
    orderRecord?.token_id ||
    parseTokenIdFromClientOrderId(clientOrderId) ||
    ''
  );
}

function clampLimitPrice(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return n;
  return Math.min(0.99, Math.max(0.01, n));
}

function resolveYesNo(market) {
  // Prefer CLOB token ids first (most reliable for midpoint/orderbook APIs).
  const idsRaw = market?.clobTokenIds;
  let ids = [];
  if (Array.isArray(idsRaw)) ids = idsRaw.map(String);
  else ids = parseMaybe(idsRaw, []) || [];
  if (ids.length >= 2) {
    return { yes: String(ids[0]), no: String(ids[1]) };
  }

  // Fallback to tokens payload when clobTokenIds is missing.
  let yes = null, no = null;
  const t = parseMaybe(market?.tokens, null);
  if (Array.isArray(t)) {
    for (const x of t) {
      const o = String(x?.outcome || '').toLowerCase();
      const id = String(x?.tokenId || x?.id || '');
      if (!id) continue;
      if (o === 'yes') yes = id;
      if (o === 'no') no = id;
    }
  }
  if (!(yes && no)) throw new Error('cannot_resolve_yes_no');
  return { yes, no };
}

async function midpoint(tokenId) {
  const j = await fetchJson(`${CLOB}/midpoint?token_id=${encodeURIComponent(tokenId)}`, 10000);
  const p = Number(j?.mid ?? j?.midpoint ?? j?.price);
  if (!Number.isFinite(p)) throw new Error('midpoint_empty');
  return p;
}

async function btcPrice() {
  const j = await fetchJson('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT', 10000);
  const p = Number(j?.data?.[0]?.last);
  if (!Number.isFinite(p)) throw new Error('btc_price_empty');
  return p;
}

async function event(type, payload = {}) {
  await appendFile(OUT_EVENTS, JSON.stringify({ ts: ts(), type, ...payload }) + '\n', 'utf8');
}

function parseExchangeBalance(rawBalance) {
  const v = Number(rawBalance);
  if (!Number.isFinite(v)) return null;
  return v / 1e6;
}

function extractTradeId(trade) {
  const id = String(trade?.id || '').trim();
  if (id) return id;
  const tx = String(trade?.transaction_hash || '').trim();
  if (tx) return tx;
  const orderId = String(trade?.taker_order_id || trade?.order_id || trade?.orderID || '').trim();
  const asset = String(trade?.asset_id || trade?.token_id || '').trim();
  const mt = String(trade?.match_time || trade?.last_update || '').trim();
  return `${orderId}|${asset}|${mt}`;
}

function buildExchangeTradesSnapshot(trades) {
  const list = Array.isArray(trades) ? trades : [];
  const ids = new Set();
  for (const trade of list) {
    ids.add(extractTradeId(trade));
  }
  return {
    count: list.length,
    ids,
  };
}

function computeExchangeTradesDelta(beforeSnapshot, afterSnapshot) {
  if (!beforeSnapshot || !afterSnapshot) return null;
  if (!(beforeSnapshot.ids instanceof Set) || !(afterSnapshot.ids instanceof Set)) return null;
  let delta = 0;
  for (const id of afterSnapshot.ids) {
    if (!beforeSnapshot.ids.has(id)) delta += 1;
  }
  if (delta === 0 && Number.isFinite(beforeSnapshot.count) && Number.isFinite(afterSnapshot.count) && afterSnapshot.count > beforeSnapshot.count) {
    delta = afterSnapshot.count - beforeSnapshot.count;
  }
  return delta;
}

function normalizePositionsArray(posResult) {
  if (!posResult?.positions) return [];
  if (Array.isArray(posResult.positions)) return posResult.positions;
  if (typeof posResult.positions === 'object') return Object.values(posResult.positions);
  return [];
}

function backfillExposureLedgerFromPositions(exposureLedger, positionsArray) {
  const nextHoldings = {};
  const nextAvgPrices = {};
  const nextSourceByAsset = {};
  const nextLifecycleByAsset = {};
  let nonZeroCount = 0;

  for (const pos of positionsArray || []) {
    const asset = String(pos?.asset_id || pos?.condition_id || '').trim();
    if (!asset) continue;
    const yesQty = Number(pos?.yes) || 0;
    const noQty = Number(pos?.no) || 0;
    const net = yesQty - noQty;
    if (Math.abs(net) < 0.001) continue;
    nextHoldings[asset] = net;
    nextAvgPrices[asset] = Number(pos?.avg_price || 0) || 0;
    nextSourceByAsset[asset] = 'recovered_from_exchange_confirmed_auto';
    nextLifecycleByAsset[asset] = 'active_open';
    nonZeroCount += 1;
  }

  exposureLedger.holdings = nextHoldings;
  exposureLedger.avg_prices = nextAvgPrices;
  exposureLedger.source_by_asset = nextSourceByAsset;
  exposureLedger.lifecycle_by_asset = nextLifecycleByAsset;
  exposureLedger.last_reconcile_ts = ts();
  exposureLedger.synced_at = ts();
  return { nonZeroCount };
}

function candidateSlugs(nowMs) {
  return buildRollingSlugCandidates(CFG.slugPrefix, nowMs);
}

async function fetchMarketsBySlug(slug) {
  // Primary path: direct slug query
  try {
    const arr = await fetchJson(`${GAMMA}?slug=${encodeURIComponent(slug)}`, 12000);
    if (Array.isArray(arr) && arr.length > 0) return arr;
  } catch {}

  // Fallback path A: broad recent query + local slug filter
  const broad = await fetchJson(`${GAMMA}?limit=200&active=true`, 12000);
  const list = Array.isArray(broad) ? broad : [];
  return list.filter((m) => String(m?.slug || '') === String(slug));
}

async function findTradableMarket() {
  const selected = await selectFirstTradableRollingMarket({
    slugPrefix: CFG.slugPrefix,
    nowMs: Date.now(),
    fetchMarketsBySlug,
    resolveYesNoFromMarket: (m) => {
      const { yes, no } = resolveYesNo(m);
      return { yesTokenId: yes, noTokenId: no, mappingSource: 'runner', mappingConfirmed: true };
    },
    probeMidpoint: midpoint,
    isClosed: (m) => Boolean(m?.closed) || (toMs(m?.endDate) !== null && toMs(m.endDate) <= Date.now()),
    onLog: async (line) => event('SELECTOR_LOG', { line }),
  });
  if (!selected) return null;
  return {
    marketId: String(selected.market?.id),
    slug: selected.slug,
    endDate: selected.market?.endDate || null,
    yesToken: selected.yesTokenId,
    noToken: selected.noTokenId,
  };
}

async function runReplayFallback() {
  await event('FALLBACK_TO_REPLAY', { reason: 'no_market_10m' });
  const { spawn } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    const p = spawn('node', [
      'src/runners/polymarket_paper_replay_fast.mjs',
      '--snapshots', 'data/snapshots_1490011_external_lead.csv',
      '--ticks', '7200',
      '--window', String(CFG.window),
      '--entryTh', String(CFG.entryTh),
      '--gate', String(CFG.gate),
      '--baseSize', String(CFG.baseSize),
      '--scaleFactor', String(CFG.scaleFactor),
      '--maxPosition', String(CFG.maxPosition),
      '--feeRate', String(CFG.feeRate),
      '--slippageBps', String(CFG.slippageBps),
      '--outLog', 'data/paper_trading_log.csv',
      '--outSummary', 'data/paper_trading_summary.json'
    ], { cwd: process.cwd(), stdio: 'inherit' });
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`fallback_exit_${code}`)));
  });
}

async function main() {
  await mkdir('data', { recursive: true });
  await writeFile(OUT_LOG, 'ts,btc_price,yes_price,no_price,signal,trade_action,trade_size,position,cash,equity,realizedPnl,unrealizedPnl,market_id\n', 'utf8');
  await writeFile(OUT_EVENTS, '', 'utf8');
  await writeFile(OUT_EVENTS_POINTER, `${OUT_EVENTS}\n`, 'utf8');
  if (CFG.mode === 'shadow') {
    await writeFile(OUT_ORDERS, 'ts,market_id,token_id,side,size,price,midpoint,simulated_fill_price,position_after,equity\n', 'utf8');
  }

  const cfgCheck = validateRuntimeConfig(CFG);
  if (!cfgCheck.ok) {
    await event('CONFIG_VALIDATION_FAILED', { cfg: CFG, issues: cfgCheck.issues, warnings: cfgCheck.warnings || [] });
    console.error(JSON.stringify({ blocked: true, reason: 'config_validation_failed', issues: cfgCheck.issues, warnings: cfgCheck.warnings || [] }, null, 2));
    process.exit(2);
  }
  if ((cfgCheck.warnings || []).length > 0) {
    await event('CONFIG_VALIDATION_WARNINGS', { cfg: CFG, warnings: cfgCheck.warnings });
  }

  const runId = `run_${Date.now()}`;
  if (CFG.mode === 'live' && !CFG.liveDryRun) {
    const strategyGate = await verifyStrategyEvidenceReport({
      reportPath: CFG.strategyReportPath,
      maxAgeMs: CFG.strategyReportMaxAgeSec * 1000,
    });
    if (!strategyGate.ok) {
      await event('STRATEGY_EVIDENCE_BLOCKED', { run_id: runId, reason: strategyGate.reason });
      console.log(JSON.stringify({ blocked: true, reason: strategyGate.reason }, null, 2));
      return;
    }
  }
  let tradeState = await loadTradeState();
  const liveGateway = createLiveExecutionGateway();
  let exchangeCashBefore = null;
  let exchangeCashAfter = null;
  let exchangeCashDelta = null;
  let exchangeTradesBeforeSnapshot = null;
  let exchangeTradesAfterSnapshot = null;
  let exchangeTradesDelta = null;

  // Exchange reconciliation on startup (live mode only)
  if (CFG.mode === 'live' && !CFG.liveDryRun) {
    const exchRecon = await rebuildStateFromExchange({
      state: tradeState,
      liveGateway,
      onEvent: event,
    });
    if (!exchRecon.ok) {
      tradeState.halted = true;
      tradeState.halt_reason = exchRecon.reason;
      await saveTradeState(tradeState);
      await event('SAFE_HALT_TRIGGERED', {
        run_id: runId,
        reason: exchRecon.reason,
        source: 'exchange_reconciliation',
      });
      console.log(JSON.stringify({ blocked: true, reason: exchRecon.reason }, null, 2));
      return;
    }
    // Apply rebuilt state from exchange
    if (exchRecon.rebuiltIntents) {
      tradeState.intents = exchRecon.rebuiltIntents;
      tradeState.intent_index = exchRecon.rebuiltIndex;
      await saveTradeState(tradeState);
    }
  }

  if (tradeState.halted && CFG.mode === 'live') {
    if (!CFG.resumeFromHalt) {
      await event('RUNNER_BLOCKED_BY_HALT', {
        run_id: runId,
        halt_reason: tradeState.halt_reason || 'halted',
        hint: 'set --resumeFromHalt true after running recovery',
      });
      console.log(JSON.stringify({ blocked: true, reason: tradeState.halt_reason || 'halted' }, null, 2));
      return;
    }

    const recovery = await runRecoverySequence({
      state: tradeState,
      unresolvedMsLimit: CFG.unresolvedOrderLimitMs,
      dryRun: CFG.liveDryRun,
      liveCancel: liveGateway.cancelOrder,
      persistState: async (stateToPersist) => saveTradeState(stateToPersist),
      onEvent: event,
    });
    tradeState = recovery.state;
    await saveTradeState(tradeState);
    if (!recovery.ok) {
      await event('RUNNER_RESUME_REJECTED', {
        run_id: runId,
        reason: recovery.reason || 'recovery_failed',
      });
      console.log(JSON.stringify({ blocked: true, reason: recovery.reason || 'recovery_failed' }, null, 2));
      return;
    }
  }

  await saveTradeState(tradeState);
  await event('RUNNER_START', { cfg: CFG, run_id: runId, trade_state_halted: tradeState.halted, restored_intent_count: Object.keys(tradeState.intents || {}).length, restored_index_count: Object.keys(tradeState.intent_index || {}).length });

  if (CFG.mode === 'live' && !CFG.liveDryRun && typeof liveGateway.getRecentTrades === 'function') {
    try {
      const beforeTradesRes = await liveGateway.getRecentTrades(EXCHANGE_TRADES_SNAPSHOT_LIMIT);
      if (!beforeTradesRes?.reason) {
        exchangeTradesBeforeSnapshot = buildExchangeTradesSnapshot(beforeTradesRes.trades);
        await event('RUNNER_EXCHANGE_TRADES_BEFORE', {
          source: beforeTradesRes.source || 'py_clob_client_v2_get_trades',
          trades_count: exchangeTradesBeforeSnapshot.count,
          limit: EXCHANGE_TRADES_SNAPSHOT_LIMIT,
        });
      } else {
        await event('RUNNER_EXCHANGE_TRADES_BEFORE_FAILED', {
          reason: beforeTradesRes.reason,
          detail: beforeTradesRes.detail,
          source: beforeTradesRes.source || 'unknown',
        });
      }
    } catch (e) {
      await event('RUNNER_EXCHANGE_TRADES_BEFORE_FAILED', {
        reason: 'exception',
        detail: String(e?.message || e),
      });
    }
  }

  // Query and save exchange cash balance for cash truth
  if (!CFG.liveDryRun) {
    try {
      const balResult = liveGateway.getBalance ? await liveGateway.getBalance() : null;
      if (balResult?.balance) {
        const parsedBalance = parseExchangeBalance(balResult.balance);
        tradeState.exchange_cash_balance = parsedBalance ?? tradeState.exchange_cash_balance;
        tradeState.canonical_cash_source = 'exchange';
        exchangeCashBefore = parsedBalance;
      }
    } catch (e) {
      console.error('Failed to get exchange balance:', e.message);
    }
  }
  
  let current = null;
  let lastNoMarketMs = Date.now();
  let noMarketCycles = 0;
  let lastKnownGoodMarket = null;

  let cash = 1000;
  let realizedPnl = 0;
  let position = null; // {outcome, qty, avg}
  let trades = 0;
  let wins = 0;
  let peak = 1000;
  let mdd = 0;
  const slip = CFG.slippageBps / 10000;
  const btcHist = [];

  // Initialize exposure_ledger from tradeState if exists
  if (!tradeState.exposure_ledger) {
    tradeState.exposure_ledger = {
      holdings: {},
      avg_prices: {},
      source_by_asset: {},
      lifecycle_by_asset: {},
      last_reconcile_ts: null,
    };
  }
  const exposureLedger = tradeState.exposure_ledger;

  // === UNIFIED FILL UPDATE FUNCTION ===
  // Single canonical path for ALL fill-related state updates
  function updateOrderOnFill(orderRecord, executedSize, fillPrice, intent, isTerminal) {
    if (!orderRecord || executedSize <= 0) return;

    const now = ts();
    const tokenId = orderRecord.token_id || orderRecord.asset_id || intent?.token_id || intent?.tokenId || '';
    if (!tokenId && !CFG.liveDryRun) {
      tradeState.halted = true;
      tradeState.halt_reason = 'fill_missing_token_id';
      tradeState.last_reconcile_ts = now;
      event('ORDER_FILL_ACCOUNTING_BLOCKED', {
        run_id: runId,
        reason: 'missing_token_id',
        client_order_id: orderRecord.client_order_id || null,
        order_id: orderRecord.order_id || null,
        executed_size: Number(executedSize) || 0,
        status: String(orderRecord.status || ''),
      }).catch(() => {});
      event('SAFE_HALT_TRIGGERED', {
        run_id: runId,
        reason: 'fill_missing_token_id',
        client_order_id: orderRecord.client_order_id || null,
        order_id: orderRecord.order_id || null,
      }).catch(() => {});
      return;
    }
    const side = orderRecord.side || intent?.side || 'buy';
    const target = side.toLowerCase() === 'buy' ? 'yes' : 'no';
    const status = orderRecord.status || 'filled';

    const orderLedgerRec = tradeState.orders?.[orderRecord.client_order_id] || null;
    const intentRec = tradeState.intents?.[orderRecord.client_order_id] || null;
    const prevAccounted = Number(orderLedgerRec?.accounted_executed_size ?? intentRec?.accounted_executed_size ?? 0);
    const accountedDelta = Math.max(0, Number(executedSize) - prevAccounted);

    // 1. Update order record in orders ledger
    if (orderLedgerRec) {
      orderLedgerRec.normalized_status = status;
      orderLedgerRec.executed_size = executedSize;
      orderLedgerRec.remaining_size = Number(orderRecord.original_size || orderLedgerRec.original_size || 0) - executedSize;
      orderLedgerRec.updated_at = now;
      orderLedgerRec.accounted_executed_size = prevAccounted + accountedDelta;
      if (isTerminal) {
        orderLedgerRec.final_state = status;
        orderLedgerRec.final_reason = status === 'filled' ? 'fully_filled' : 'partial_fill';
        orderLedgerRec.finalized_at = now;
      }
    }

    // 2. Update intents ledger as well
    if (intentRec) {
      intentRec.status = status;
      intentRec.executed_size = executedSize;
      intentRec.updated_at = now;
      intentRec.accounted_executed_size = prevAccounted + accountedDelta;
      if (isTerminal) {
        intentRec.lifecycle_finalized_at = now;
        intentRec.lifecycle_resolution_reason = status === 'filled' ? 'fully_filled' : 'partial_fill';
      }
    }

    // 3. Update exposure_ledger if real trade (incremental accounting only)
    if (!CFG.liveDryRun && tokenId && exposureLedger && accountedDelta > 0) {
      const currentQty = exposureLedger.holdings[tokenId] || 0;
      const currentAvg = exposureLedger.avg_prices[tokenId] || 0;

      if (target === 'yes') {
        exposureLedger.holdings[tokenId] = currentQty + accountedDelta;
        const totalCost = (currentAvg * currentQty) + (fillPrice * accountedDelta);
        exposureLedger.avg_prices[tokenId] = totalCost / (currentQty + accountedDelta);
      } else {
        exposureLedger.holdings[tokenId] = currentQty - accountedDelta;
        const totalCost = (currentAvg * Math.abs(currentQty)) + (fillPrice * accountedDelta);
        exposureLedger.avg_prices[tokenId] = totalCost / (Math.abs(currentQty) + accountedDelta);
      }
      exposureLedger.source_by_asset[tokenId] = 'managed_by_bot';
      exposureLedger.lifecycle_by_asset[tokenId] = 'active_open';
      exposureLedger.last_reconcile_ts = now;
      event('ORDER_FILL_ACCOUNTED', {
        run_id: runId,
        client_order_id: orderRecord.client_order_id,
        token_id: tokenId,
        accounted_delta: accountedDelta,
        total_executed_size: executedSize,
      }).catch(() => {});
      if (orderRecord?.client_order_id) runtimeFilledOrderIds.add(orderRecord.client_order_id);
    }

    if (CFG.validationMode && VALIDATION_GUARDRAILS.FIRST_FILL_STOP && !validationFirstFillDetected) {
      validationFirstFillDetected = true;
      validationStopTrading = true;
      event('VALIDATION_FIRST_FILL_DETECTED_STOP', {
        run_id: runId,
        client_order_id: orderRecord.client_order_id,
        executed_size: executedSize,
        status,
      }).catch(() => {});
    }
  }

  const started = Date.now();
  let lastWatch = 0;
  let tickCount = 0;
  let lastSummaryMs = started;
  let lastCompactMs = started;
  let netFailCount = 0;
  let liveCooldownUntil = 0;
  const liveRisk = createLiveRiskTracker();
  const marketsTraded = [];
  let ordersCount = 0;
  let slippageBpsSum = 0;
  const runtimeFilledOrderIds = new Set();
  let validationOrdersSubmitted = 0;
  let validationOrdersAttempted = 0;
  let validationTotalSharesSubmitted = 0;
  let validationFirstFillDetected = false;
  let validationStopTrading = false;

  while (true) {
    const now = Date.now();
    if (CFG.durationSec > 0 && now - started >= CFG.durationSec * 1000) break;
    if (CFG.validationMode && validationStopTrading) {
      await event('VALIDATION_RUN_STOPPED', {
        run_id: runId,
        reason: validationFirstFillDetected ? 'first_fill_stop' : 'validation_guardrail_stop',
        submitted_orders: validationOrdersSubmitted,
        attempted_orders: validationOrdersAttempted,
        submitted_shares: validationTotalSharesSubmitted,
      });
      break;
    }

    // watcher every 30s or when no current market
    if (!current || now - lastWatch >= CFG.watchSec * 1000) {
      lastWatch = now;
      const picked = await findTradableMarket();
      if (!picked) {
        noMarketCycles += 1;
        await event('WATCHER_NO_MARKET', { candidates: candidateSlugs(now), no_market_cycles: noMarketCycles, max_no_market_cycles: CFG.maxNoMarketCycles });

        // Fallback path B: temporarily reuse last known good market if still valid
        if (!current && lastKnownGoodMarket) {
          const endMs = toMs(lastKnownGoodMarket.endDate);
          if (!endMs || endMs > Date.now()) {
            current = lastKnownGoodMarket;
            await event('WATCHER_REUSE_LAST_MARKET', { marketId: current.marketId, slug: current.slug });
          }
        }

        if (noMarketCycles >= CFG.maxNoMarketCycles) {
          await event('RUNNER_EXIT_NO_MARKET', {
            no_market_cycles: noMarketCycles,
            max_no_market_cycles: CFG.maxNoMarketCycles,
            reason: 'market_source_unavailable',
          });
          break;
        }

        if (!current && now - lastNoMarketMs >= CFG.fallbackNoMarketSec * 1000) {
          await runReplayFallback();
          await event('RUNNER_EXIT_AFTER_FALLBACK');
          return;
        }
        if (!current) {
          await sleep(CFG.tickSec * 1000);
          continue;
        }
      } else {
        noMarketCycles = 0;
        if (!current || current.marketId !== picked.marketId) {
          if (current) await event('MARKET_ROLLOVER', { from: current.marketId, to: picked.marketId, fromSlug: current.slug, toSlug: picked.slug });
          current = picked;
          lastKnownGoodMarket = picked;
          await event('WATCHER_SELECTED_MARKET', { marketId: picked.marketId, slug: picked.slug, yesToken: picked.yesToken, noToken: picked.noToken, endDate: picked.endDate });
          marketsTraded.push(picked.marketId);
        }
        lastNoMarketMs = now;
      }
    }

    if (!current) {
      await sleep(CFG.tickSec * 1000);
      continue;
    }

    if (CFG.mode === 'live' && tradeState?.intents) {
      for (const rec of Object.values(tradeState.intents)) {
        // Reconcile non-terminal orders, and also recent terminal zero-fill orders
        // to catch late exchange fills after cancel/expire/reject.
        const recStatus = String(rec.status || '').toLowerCase();
        const shouldAuditTerminal = !CFG.liveDryRun && isTerminalLateFillAuditable(rec, Date.now());
        if (isFinalOrderStatus(recStatus) && !shouldAuditTerminal) {
          continue;
        }

        const check = await reconcileOrderStatus({
          record: rec,
          unresolvedMsLimit: CFG.unresolvedOrderLimitMs,
          dryRun: CFG.liveDryRun,
          liveQuery: liveGateway.queryOrderStatus,
          onEvent: event,
        });
        if (check.record?.client_order_id) {
          const existingIntent = tradeState.intents?.[check.record.client_order_id] || {};
          const orderRec = tradeState.orders?.[check.record.client_order_id] || null;
          const mergedIntent = mergeIntentRecord(existingIntent, check.record, orderRec);
          tradeState.intents[check.record.client_order_id] = mergedIntent;
          tradeState.intent_index[check.record.client_order_id] = mergedIntent.status || 'acknowledged';

          const rec = mergedIntent;
          const executedSize = Number(rec.executed_size) || 0;
          const fillPrice = Number(rec.fill_price) || 0;
          const orderStatus = String(rec.status || '').toLowerCase();
          const isTerminal = isFinalOrderStatus(orderStatus);
          updateOrderOnFill(rec, executedSize, fillPrice, null, isTerminal);

          if (!CFG.liveDryRun) {
            await markTerminalLateFillAudit({
              record: rec,
              onEvent: event,
              runId,
              marketId: current?.marketId,
              nowMs: Date.now(),
            });
          }
        }
        
        // Handle converged orders
        if (check.converged) {
          continue;
        }
        
        if (!check.ok) {
          // Check if already in terminal state before attempting cancel
          const currentStatus = String(check.record?.status || '').toLowerCase();
          if (isFinalOrderStatus(currentStatus)) {
            continue;
          }
          
          if (!CFG.liveDryRun && String(check.haltReason || '') === 'inconsistent_order_state' && check.record?.order_id) {
            try {
              const canceled = await liveGateway.cancelOrder(check.record);
              await event('ORDER_CANCEL_REQUESTED', {
                run_id: runId,
                market_id: current.marketId,
                order_id: check.record.order_id,
                source: canceled?.source || 'py_clob_client_v2_cancel',
              });
              const patched = { ...check.record, status: canceled?.status || 'canceled', status_ts: ts() };
              const existingPatched = tradeState.intents?.[patched.client_order_id] || {};
              const orderRec = tradeState.orders?.[patched.client_order_id] || null;
              const mergedPatched = mergeIntentRecord(existingPatched, patched, orderRec);
              tradeState.intents[patched.client_order_id] = mergedPatched;
              tradeState.intent_index[patched.client_order_id] = mergedPatched.status;
              tradeState.last_reconcile_ts = ts();
              await saveTradeState(tradeState);
              await event('ORDER_FORCE_CANCELED_AFTER_TIMEOUT', {
                run_id: runId,
                market_id: current.marketId,
                order_id: patched.order_id,
                status: patched.status,
              });
              continue;
            } catch (ce) {
              await event('ORDER_CANCEL_FAILED', {
                run_id: runId,
                market_id: current.marketId,
                order_id: check.record.order_id,
                err: String(ce?.message || ce),
              });
            }
          }

          tradeState.halted = true;
          tradeState.halt_reason = check.haltReason;
          tradeState.last_reconcile_ts = ts();
          await saveTradeState(tradeState);
          await event('SAFE_HALT_TRIGGERED', { run_id: runId, reason: check.haltReason, market_id: current.marketId });
          current = null;
          break;
        }
      }
      if (tradeState.halted) break;
    }

    try {
      const [btc, yesPrice, noPrice] = await Promise.all([
        btcPrice(),
        midpoint(current.yesToken),
        midpoint(current.noToken),
      ]);

      if (netFailCount > 0) {
        await event('NETWORK_RECOVERED', { market_id: current.marketId, consecutive_failures_cleared: netFailCount });
      }
      netFailCount = 0;

      btcHist.push(btc);
      while (btcHist.length > 20) btcHist.shift();
      const prev1 = btcHist[btcHist.length - 2];
      const prev3 = btcHist[btcHist.length - 4];
      const r1 = Number.isFinite(prev1) && prev1 !== 0 ? (btc - prev1) / prev1 : NaN;
      const r3 = Number.isFinite(prev3) && prev3 !== 0 ? (btc - prev3) / prev3 : NaN;

      let signal = 'hold';
      if (Number.isFinite(r1) && Number.isFinite(r3)) {
        if (r3 > CFG.entryTh && Math.abs(r1) > CFG.gate) signal = 'buy_yes';
        else if (r3 < -CFG.entryTh && Math.abs(r1) > CFG.gate) signal = 'buy_no';
      }

      let tradeAction = 'none';
      let tradeSize = 0;

      const mark = (outcome) => outcome === 'yes' ? yesPrice : noPrice;
      const closePos = (reason = 'close') => {
        if (!position) return;
        const px = mark(position.outcome) * (1 - slip);
        const notional = px * position.qty;
        const fee = notional * CFG.feeRate;
        const pnl = (px - position.avg) * position.qty - fee;
        cash += notional - fee;
        realizedPnl += pnl;
        trades += 1;
        if (pnl > 0) wins += 1;
        tradeAction = reason;
        tradeSize = position.qty;
        position = null;
      };

      if (signal !== 'hold') {
        const target = signal === 'buy_yes' ? 'yes' : 'no';
        if (position && position.outcome !== target) {
          if (CFG.flip === 'close_only') {
            closePos('close_flip');
          }
        } else if (!position) {
          const midpointForTarget = mark(target);
          let qty = CFG.baseSize * (Math.abs(r3) / CFG.scaleFactor);
          qty = Math.min(qty, CFG.maxPosition);
          if ((CFG.minOrderShares || 0) > CFG.maxPosition) {
            await event('RISK_SIGNAL_SKIPPED', {
              run_id: runId,
              reason: 'risk_min_order_shares_conflict_with_max_position',
              market_id: current.marketId,
              detail: { min_order_shares: CFG.minOrderShares, max_position: CFG.maxPosition },
            });
            await sleep(200);
            continue;
          }
          qty = Math.max(qty, CFG.minOrderShares || 0);

          if (Number.isFinite(midpointForTarget) && midpointForTarget > 0) {
            const minQtyByUsd = (CFG.minOrderUsd || 1) / midpointForTarget;
            if (minQtyByUsd > CFG.maxPosition) {
              await event('RISK_SIGNAL_SKIPPED', {
                run_id: runId,
                reason: 'risk_min_order_usd_conflict_with_max_position',
                market_id: current.marketId,
                detail: { min_qty_by_usd: minQtyByUsd, max_position: CFG.maxPosition, midpoint: midpointForTarget },
              });
              await sleep(200);
              continue;
            }
            qty = Math.max(qty, minQtyByUsd);
          }
          qty = Math.min(qty, CFG.maxPosition);

          if (CFG.validationMode) {
            if (validationOrdersAttempted >= VALIDATION_GUARDRAILS.MAX_ORDERS_PER_RUN) {
              await event('VALIDATION_ORDER_BLOCKED', {
                run_id: runId,
                reason: 'max_orders_per_run_reached',
                submitted_orders: validationOrdersSubmitted,
                attempted_orders: validationOrdersAttempted,
                limit: VALIDATION_GUARDRAILS.MAX_ORDERS_PER_RUN,
              });
              await sleep(200);
              continue;
            }

            const originalQty = qty;
            qty = Math.min(qty, VALIDATION_GUARDRAILS.MAX_SHARES_PER_ORDER);
            if (qty < originalQty) {
              await event('VALIDATION_SIZE_CLAMPED', {
                run_id: runId,
                reason: 'max_shares_per_order',
                original_size: originalQty,
                clamped_size: qty,
                limit: VALIDATION_GUARDRAILS.MAX_SHARES_PER_ORDER,
              });
            }

            const remainingShares = VALIDATION_GUARDRAILS.MAX_TOTAL_SHARES_PER_RUN - validationTotalSharesSubmitted;
            if (remainingShares <= 0) {
              validationStopTrading = true;
              await event('VALIDATION_ORDER_BLOCKED', {
                run_id: runId,
                reason: 'max_total_shares_per_run_reached',
                submitted_shares: validationTotalSharesSubmitted,
                limit: VALIDATION_GUARDRAILS.MAX_TOTAL_SHARES_PER_RUN,
              });
              await sleep(200);
              continue;
            }

            if (qty > remainingShares) {
              await event('VALIDATION_SIZE_CLAMPED', {
                run_id: runId,
                reason: 'max_total_shares_per_run_remaining',
                original_size: qty,
                clamped_size: remainingShares,
                submitted_shares: validationTotalSharesSubmitted,
                limit: VALIDATION_GUARDRAILS.MAX_TOTAL_SHARES_PER_RUN,
              });
              qty = remainingShares;
            }
          }

          let px = midpointForTarget * (1 + slip);

          if (CFG.mode === 'live') {
            const tokenId = target === 'yes' ? current.yesToken : current.noToken;
            const guard = preTradeGuard({
              halted: Boolean(tradeState?.halted),
              runtimeState: tradeState?.runtime_state,
              marketKnown: Boolean(current?.marketId),
              positionKnown: true,
              balanceKnown: Number.isFinite(cash),
            });
            if (!guard.ok) {
              if (guard.reason === 'reconciling') {
                await event('ORDER_SUBMIT_BLOCKED_RECONCILING', {
                  run_id: runId,
                  market_id: current.marketId,
                  runtime_state: tradeState?.runtime_state || null,
                });
                await sleep(200);
                continue;
              }
              tradeState.halted = true;
              tradeState.halt_reason = guard.reason;
              tradeState.last_reconcile_ts = ts();
              await saveTradeState(tradeState);
              await event('SAFE_HALT_TRIGGERED', { run_id: runId, reason: guard.reason, market_id: current.marketId });
              break;
            }

            if (Date.now() < liveCooldownUntil) {
              await event('RISK_COOLDOWN_ACTIVE', {
                run_id: runId,
                market_id: current.marketId,
                cooldown_until: new Date(liveCooldownUntil).toISOString(),
              });
              await sleep(200);
              continue;
            }

            const rawLimitPrice = midpointForTarget;
            const limitPrice = clampLimitPrice(rawLimitPrice);
            if (limitPrice !== rawLimitPrice) {
              await event('ORDER_PRICE_CLAMPED', {
                run_id: runId,
                market_id: current.marketId,
                raw_limit_price: rawLimitPrice,
                clamped_limit_price: limitPrice,
              });
            }

            // Live-only hard cap by real exposure ledger holdings (fail-closed clamp)
            const currentHolding = Math.abs(Number(exposureLedger?.holdings?.[tokenId] || 0));
            const remainingCapacity = Math.max(0, Number(CFG.maxPosition || 0) - currentHolding);
            if (remainingCapacity <= 0) {
              await event('RISK_SIGNAL_SKIPPED', {
                run_id: runId,
                reason: 'risk_max_position_reached_live_exposure',
                market_id: current.marketId,
                detail: { token_id: tokenId, current_holding: currentHolding, max_position: Number(CFG.maxPosition || 0) },
              });
              await sleep(200);
              continue;
            }
            if (qty > remainingCapacity) {
              await event('RISK_SIZE_CLAMPED', {
                run_id: runId,
                reason: 'risk_max_position_remaining_capacity',
                market_id: current.marketId,
                token_id: tokenId,
                original_size: qty,
                clamped_size: remainingCapacity,
                current_holding: currentHolding,
                max_position: Number(CFG.maxPosition || 0),
              });
              qty = remainingCapacity;
            }

            const intent = buildLimitIntent({
              runId,
              marketId: current.marketId,
              tokenId,
              side: 'buy',
              size: qty,
              limitPrice,
              ttlSec: 120,
            });

            const riskCheck = checkLiveRiskGuard({
              intent,
              cfg: CFG,
              tracker: liveRisk,
              realizedPnl,
            });
            if (!riskCheck.ok) {
              if (String(riskCheck.reason || '') === 'risk_max_order_notional_exceeded') {
                await event('RISK_SIGNAL_SKIPPED', {
                  run_id: runId,
                  reason: riskCheck.reason,
                  market_id: current.marketId,
                  detail: riskCheck,
                });
                await sleep(200);
                continue;
              }

              tradeState.halted = true;
              tradeState.halt_reason = riskCheck.reason;
              tradeState.last_reconcile_ts = ts();
              await saveTradeState(tradeState);
              await event('SAFE_HALT_TRIGGERED', {
                run_id: runId,
                reason: riskCheck.reason,
                market_id: current.marketId,
                detail: riskCheck,
              });
              break;
            }

            // Check exchange minimum order size (live mode only)
            if (!CFG.liveDryRun && CFG.mode === 'live') {
              const exchangeMinResult = await liveGateway.getMinOrderSize(tokenId);
              const exchangeMin = exchangeMinResult.minSize || 1;
              const effectiveMin = Math.max(CFG.minOrderShares || 1, exchangeMin);
              
              if (qty < effectiveMin) {
                await event('ORDER_SKIPPED_MIN_SIZE', {
                  run_id: runId,
                  market_id: current.marketId,
                  token_id: tokenId,
                  requested_size: qty,
                  exchange_min_size: exchangeMin,
                  effective_min_size: effectiveMin,
                  detail: 'order_size_below_exchange_minimum',
                });
                await sleep(200);
                continue;
              }
            }

            // Prefer exchange snapshot for pre-submit baseline; fall back to local ledger.
            let preSubmitNet = Number(exposureLedger?.holdings?.[tokenId] || 0);
            let preSubmitHolding = Math.abs(preSubmitNet);
            try {
              const preProbe = await liveGateway.getPositions();
              if (!preProbe?.reason) {
                const prePositions = Array.isArray(preProbe.positions) ? preProbe.positions : [];
                const preMatched = prePositions.find((p) => String(p?.asset_id || '') === String(tokenId));
                const preYes = Number(preMatched?.yes) || 0;
                const preNo = Number(preMatched?.no) || 0;
                preSubmitNet = preYes - preNo;
                preSubmitHolding = Math.abs(preSubmitNet);
              }
            } catch {}

            if (CFG.validationMode) {
              validationOrdersAttempted += 1;
            }

            let result;
            try {
              result = await submitLimitIntent({
                intent,
                state: tradeState,
                dryRun: CFG.liveDryRun,
                liveSubmit: liveGateway.submitLimitOrder,
                onEvent: event,
              });
            } catch (e) {
              liveCooldownUntil = Date.now() + CFG.cooldownSec * 1000;
              const submitErr = String(e?.message || e);

              let positionDeltaRecovered = false;
              let postSubmitHolding = null;
              let postSubmitNet = null;
              let delta = 0;
              let deltaAbs = 0;
              try {
                const probe = await liveGateway.getPositions();
                if (!probe?.reason) {
                  const probePositions = Array.isArray(probe.positions) ? probe.positions : [];
                  const matched = probePositions.find((p) => String(p?.asset_id || '') === String(tokenId));
                  const yesQty = Number(matched?.yes) || 0;
                  const noQty = Number(matched?.no) || 0;
                  postSubmitNet = yesQty - noQty;
                  postSubmitHolding = Math.abs(postSubmitNet);
                  delta = Number(postSubmitNet || 0) - Number(preSubmitNet || 0);
                  deltaAbs = Math.abs(delta);
                  if (deltaAbs > 0.0001) {
                    positionDeltaRecovered = true;
                    await event('ORDER_SUBMIT_UNCERTAIN_POSITION_DELTA', {
                      run_id: runId,
                      market_id: current.marketId,
                      client_order_id: intent.client_order_id,
                      token_id: tokenId,
                      pre_submit_holding: preSubmitHolding,
                      post_submit_holding: postSubmitHolding,
                      pre_submit_net: preSubmitNet,
                      post_submit_net: postSubmitNet,
                      delta,
                      delta_abs: deltaAbs,
                      err: submitErr,
                      source: probe.source || 'unknown',
                    });
                  }
                }
              } catch {}

              await event('ORDER_SUBMIT_FAILED', {
                run_id: runId,
                market_id: current.marketId,
                client_order_id: intent.client_order_id,
                err: submitErr,
                cooldown_sec: CFG.cooldownSec,
                uncertain_position_delta: positionDeltaRecovered,
                post_submit_holding: postSubmitHolding,
              });

              if (positionDeltaRecovered) {
                // Persist provisional bot evidence so recovery auto-adopt can match this asset
                // even when submit response was lost/errored.
                tradeState.orders = tradeState.orders || {};
                const provisionalOrderId = `uncertain_${intent.client_order_id}_${Date.now()}`;
                const executedDelta = Number(deltaAbs || 0);
                tradeState.orders[provisionalOrderId] = {
                  order_id: `uncertain_${intent.client_order_id}`,
                  client_order_id: provisionalOrderId,
                  market_id: intent.market_id,
                  asset_id: tokenId,
                  side: intent.side,
                  price: intent.limit_price,
                  size: Number(intent.size) || executedDelta,
                  normalized_status: 'uncertain_filled',
                  executed_size: executedDelta,
                  accounted_executed_size: 0,
                  remaining_size: 0,
                  created_at: ts(),
                  updated_at: ts(),
                  finalized_at: ts(),
                  final_state: 'uncertain_filled',
                  final_reason: 'submit_uncertain_position_delta',
                  source: 'submit_uncertain_probe',
                  run_id: runId,
                };

                await event('ORDER_SUBMIT_UNCERTAIN_EVIDENCE_PERSISTED', {
                  run_id: runId,
                  market_id: current.marketId,
                  token_id: tokenId,
                  client_order_id: intent.client_order_id,
                  provisional_order_id: provisionalOrderId,
                  executed_size: executedDelta,
                  pre_submit_holding: preSubmitHolding,
                  post_submit_holding: postSubmitHolding,
                  pre_submit_net: preSubmitNet,
                  post_submit_net: postSubmitNet,
                  delta,
                  delta_abs: deltaAbs,
                });

                if (CFG.validationMode) validationStopTrading = true;
                tradeState.halted = true;
                tradeState.halt_reason = 'submit_uncertain_position_delta';
                tradeState.last_reconcile_ts = ts();
                await saveTradeState(tradeState);
                await event('SAFE_HALT_TRIGGERED', {
                  run_id: runId,
                  reason: 'submit_uncertain_position_delta',
                  market_id: current.marketId,
                });
                break;
              }

              tradeState.halted = true;
              tradeState.halt_reason = 'order_submit_failed';
              tradeState.last_reconcile_ts = ts();
              await saveTradeState(tradeState);
              await event('SAFE_HALT_TRIGGERED', { run_id: runId, reason: 'order_submit_failed', market_id: current.marketId });
              break;
            }

            markLiveOrderSent(liveRisk);

            // Optional monitor-friendly event: attach submit result payload at realtime layer
            // without duplicating ORDER_SUBMIT_REQUESTED semantics.
            if (CFG.mode === 'live' && !CFG.liveDryRun) {
              await event('ORDER_SUBMIT_RESULT_ATTACHED', {
                run_id: runId,
                market_id: current.marketId,
                client_order_id: intent.client_order_id,
                intent: {
                  token_id: intent.token_id,
                  side: intent.side,
                  size: intent.size,
                  limit_price: intent.limit_price,
                  expiration: intent.expiration,
                },
                result: {
                  client_order_id: result.client_order_id,
                  order_id: result.order_id,
                  status: result.status,
                  source: result.source,
                  fill_price: result.fill_price,
                  fill_size: result.fill_size,
                },
              });
            }

            if (CFG.validationMode) {
              validationOrdersSubmitted += 1;
              validationTotalSharesSubmitted += Number(intent.size) || 0;
              if (validationTotalSharesSubmitted >= VALIDATION_GUARDRAILS.MAX_TOTAL_SHARES_PER_RUN) {
                validationStopTrading = true;
              }
            }

            tradeState.intents = tradeState.intents || {};
            tradeState.intent_index = tradeState.intent_index || {};
            tradeState.orders = tradeState.orders || {};
            
            // Build order record with full lifecycle fields
            const orderRecord = {
              order_id: result.order_id,
              client_order_id: intent.client_order_id,
              market_id: intent.market_id,
              asset_id: intent.token_id,
              side: intent.side,
              price: intent.limit_price,
              size: intent.size,
              raw_exchange_status: result.source || null,
              normalized_status: result.status || 'acknowledged',
              executed_size: result.fill_size || 0,
              accounted_executed_size: 0,
              remaining_size: intent.size - (result.fill_size || 0),
              created_at: ts(),
              updated_at: ts(),
              finalized_at: null,
              final_state: null,
              final_reason: null,
              source: 'live_submit',
              run_id: runId,
            };
            
            tradeState.intents[intent.client_order_id] = {
              ...result,
              market_id: intent.market_id,
              token_id: intent.token_id,
              side: intent.side,
              size: intent.size,
              limit_price: intent.limit_price,
              accounted_executed_size: Number(result?.accounted_executed_size || 0),
            };
            tradeState.intent_index[intent.client_order_id] = result.status || 'acknowledged';
            tradeState.orders[intent.client_order_id] = orderRecord;
            tradeState.last_reconcile_ts = ts();
            await saveTradeState(tradeState);

            // Reconcile terminal zero-fill submissions as well, to capture late fills after cancel.
            const currentOrderStatus = String(result.status || '').toLowerCase();
            const shouldAuditTerminalAtSubmit = !CFG.liveDryRun && isTerminalLateFillAuditable(result, Date.now());

            if (isFinalOrderStatus(currentOrderStatus) && !shouldAuditTerminalAtSubmit) {
              // CRITICAL FIX: Set lifecycle_finalized_at for terminal orders
              if (!result.lifecycle_finalized_at) {
                result.lifecycle_finalized_at = ts();
                result.lifecycle_resolution_reason = 'terminal_state_at_submit';
                const existingIntent = tradeState.intents?.[result.client_order_id] || {};
                const orderRec = tradeState.orders?.[result.client_order_id] || null;
                const mergedIntent = mergeIntentRecord(existingIntent, result, orderRec);
                tradeState.intents[result.client_order_id] = mergedIntent;
                await saveTradeState(tradeState);
                await event('ORDER_LIFECYCLE_FINALIZED', {
                  client_order_id: result.client_order_id,
                  order_id: result.order_id,
                  final_status: currentOrderStatus,
                  executed_size: result.executed_size || 0,
                  reason: 'finalized_at_terminal_state',
                });
              }
              await event('ORDER_RECONCILE_SKIPPED_TERMINAL', {
                client_order_id: result.client_order_id,
                order_id: result.order_id,
                status: currentOrderStatus,
                reason: 'terminal_state_skip_reconcile',
              });
              // Continue to next iteration instead of halting
              await sleep(100);
              continue;
            }

            if (isFinalOrderStatus(currentOrderStatus) && shouldAuditTerminalAtSubmit) {
              await event('ORDER_TERMINAL_LATE_FILL_AUDIT_ARMED', {
                run_id: runId,
                market_id: current.marketId,
                client_order_id: result.client_order_id,
                order_id: result.order_id,
                status: currentOrderStatus,
                executed_size: Number(result.executed_size || 0),
                window_ms: TERMINAL_LATE_FILL_AUDIT_WINDOW_MS,
                max_queries: TERMINAL_LATE_FILL_MAX_QUERIES,
                reason: 'terminal_zero_fill_submit_requires_followup',
              });
            }

            const reconcileNow = await reconcileOrderStatus({
              record: result,
              unresolvedMsLimit: CFG.unresolvedOrderLimitMs,
              dryRun: CFG.liveDryRun,
              liveQuery: liveGateway.queryOrderStatus,
              onEvent: event,
            });
            if (reconcileNow.record?.client_order_id) {
              const existingIntent = tradeState.intents?.[reconcileNow.record.client_order_id] || {};
              const orderRec = tradeState.orders?.[reconcileNow.record.client_order_id] || null;
              const mergedIntent = mergeIntentRecord(existingIntent, reconcileNow.record, orderRec);
              tradeState.intents[reconcileNow.record.client_order_id] = mergedIntent;
              tradeState.intent_index[reconcileNow.record.client_order_id] = mergedIntent.status || 'acknowledged';
              
              // Use unified function for ALL fill updates
              const rec = mergedIntent;
              const executedSize = Number(rec.executed_size) || 0;
              const fillPrice = Number(rec.fill_price) || 0;
              const orderStatus = String(rec.status || '').toLowerCase();
              const isTerminal = isFinalOrderStatus(orderStatus);
              updateOrderOnFill(rec, executedSize, fillPrice, intent, isTerminal);

              if (!CFG.liveDryRun) {
                await markTerminalLateFillAudit({
                  record: rec,
                  onEvent: event,
                  runId,
                  marketId: current?.marketId,
                  nowMs: Date.now(),
                });
              }
            }
            
            // Handle converged (finalized) orders - no more processing needed
            if (reconcileNow.converged) {
              await saveTradeState(tradeState);
              continue;
            }
            
            if (!reconcileNow.ok) {
              // If order stays unresolved, attempt defensive cancel first to reduce tail position risk.
              // But only if order is not already in a terminal convergence state
              const currentStatus = reconcileNow.record?.status || '';
              const isTerminalState = isFinalOrderStatus(String(currentStatus).toLowerCase());
              
              if (!CFG.liveDryRun && String(reconcileNow.haltReason || '') === 'inconsistent_order_state' && 
                  reconcileNow.record?.order_id && !isTerminalState) {
                try {
                  const canceled = await liveGateway.cancelOrder(reconcileNow.record);
                  await event('ORDER_CANCEL_REQUESTED', {
                    run_id: runId,
                    market_id: current.marketId,
                    order_id: reconcileNow.record.order_id,
                    source: canceled?.source || 'py_clob_client_v2_cancel',
                  });
                  const patched = { ...reconcileNow.record, status: canceled?.status || 'canceled', status_ts: ts() };
                  const existingPatched = tradeState.intents?.[patched.client_order_id] || {};
                  const orderRec = tradeState.orders?.[patched.client_order_id] || null;
                  const mergedPatched = mergeIntentRecord(existingPatched, patched, orderRec);
                  tradeState.intents[patched.client_order_id] = mergedPatched;
                  tradeState.intent_index[patched.client_order_id] = mergedPatched.status;
                  tradeState.last_reconcile_ts = ts();
                  await saveTradeState(tradeState);
                  await event('ORDER_FORCE_CANCELED_AFTER_TIMEOUT', {
                    run_id: runId,
                    market_id: current.marketId,
                    order_id: patched.order_id,
                    status: patched.status,
                  });
                  // Do not halt immediately; continue loop and let next ticks reconcile/decide.
                  await sleep(200);
                  continue;
                } catch (ce) {
                  await event('ORDER_CANCEL_FAILED', {
                    run_id: runId,
                    market_id: current.marketId,
                    order_id: reconcileNow.record.order_id,
                    err: String(ce?.message || ce),
                  });
                }
              }

              // Only halt if truly unresolved and not a convergence case
              if (!isTerminalState) {
                tradeState.halted = true;
                tradeState.halt_reason = reconcileNow.haltReason;
                tradeState.last_reconcile_ts = ts();
                await saveTradeState(tradeState);
                await event('SAFE_HALT_TRIGGERED', { run_id: runId, reason: reconcileNow.haltReason, market_id: current.marketId });
                break;
              }
            }

            const reconciledStatus = String(reconcileNow.record?.status || result.status || '').toLowerCase();
            if (reconciledStatus === 'filled') {
              px = Number(reconcileNow.record?.fill_price ?? result.fill_price);
              ordersCount += 1;
              slippageBpsSum += calcFillSlippageBps({ midpoint: midpointForTarget, fillPrice: px });
            }
          } else if (CFG.mode === 'shadow') {
            const order = buildShadowOrderFromSignal({
              signal,
              market: current,
              yesPrice,
              noPrice,
              size: qty,
            });
            if (order) {
              px = simulateFillPrice({ midpoint: order.midpoint, side: 'buy', slippageBps: CFG.slippageBps });
              const equityBefore = cash + (position ? mark(position.outcome) * position.qty : 0);
              const simulatedPositionAfter = `${target}:${qty.toFixed(6)}@${px.toFixed(6)}`;
              await appendFile(
                OUT_ORDERS,
                `${ts()},${current.marketId},${order.payload.token_id},${order.payload.side},${order.payload.size.toFixed(6)},${order.payload.price.toFixed(6)},${order.midpoint.toFixed(6)},${px.toFixed(6)},${simulatedPositionAfter},${equityBefore.toFixed(6)}\n`,
                'utf8'
              );
              await event('SHADOW_ORDER_SIMULATED', {
                market_id: current.marketId,
                token_id: order.payload.token_id,
                side: order.payload.side,
                size: order.payload.size,
                price: order.payload.price,
                midpoint: order.midpoint,
                simulated_fill_price: Number(px.toFixed(6)),
              });
              if (CFG.validationMode) {
                validationOrdersSubmitted += 1;
                validationTotalSharesSubmitted += Number(order.payload.size) || 0;
                if (validationTotalSharesSubmitted >= VALIDATION_GUARDRAILS.MAX_TOTAL_SHARES_PER_RUN) {
                  validationStopTrading = true;
                }
              }
              ordersCount += 1;
              slippageBpsSum += calcFillSlippageBps({ midpoint: order.midpoint, fillPrice: px });
            }
          }

            // FOR LIVE MODE: DO NOT update position/cash on submit!
            // Position should only be updated when fills are confirmed via reconciliation.
            // For non-live or liveDryRun paths, keep the existing immediate paper accounting.
            if (!(CFG.mode === 'live' && !CFG.liveDryRun)) {
              const notional = px * qty;
              const fee = notional * CFG.feeRate;
              cash -= (notional + fee);
              realizedPnl -= fee;
              position = { outcome: target, qty, avg: px };
              trades += 1;
              tradeAction = `open_${target}`;
              tradeSize = qty;
            }
        }
      }

      const unrealizedPnl = position ? (mark(position.outcome) - position.avg) * position.qty : 0;
      const equity = cash + (position ? mark(position.outcome) * position.qty : 0);
      peak = Math.max(peak, equity);
      mdd = Math.max(mdd, peak > 0 ? (peak - equity) / peak : 0);
      const posTxt = position ? `${position.outcome}:${position.qty.toFixed(6)}@${position.avg.toFixed(6)}` : 'flat';

      tickCount += 1;
      await appendFile(OUT_LOG, `${ts()},${btc.toFixed(2)},${yesPrice.toFixed(6)},${noPrice.toFixed(6)},${signal},${tradeAction},${tradeSize.toFixed(6)},${posTxt},${cash.toFixed(6)},${equity.toFixed(6)},${realizedPnl.toFixed(6)},${unrealizedPnl.toFixed(6)},${current.marketId}\n`, 'utf8');

      if (Date.now() - lastSummaryMs >= 5 * 60 * 1000) {
        lastSummaryMs = Date.now();
        await event('RUNNER_5MIN_SUMMARY', {
          ticks: tickCount,
          trades_count: trades,
          orders_count: ordersCount,
          win_rate: Number((trades ? wins / trades : 0).toFixed(4)),
          equity: Number(equity.toFixed(6)),
          max_drawdown: Number(mdd.toFixed(6)),
          current_market: current.marketId,
        });
      }

      if (CFG.mode === 'live' && Date.now() - lastCompactMs >= CFG.compactEverySec * 1000) {
        lastCompactMs = Date.now();
        const compactRes = await compactTradeState({
          state: tradeState,
          keepRecentOpen: CFG.keepRecentOpen,
          onEvent: event,
        });
        tradeState = compactRes.state;
        await saveTradeState(tradeState);
      }
    } catch (e) {
      netFailCount += 1;
      const errType = classifyNetworkError(e);
      const backoffMs = nextBackoffMs({
        failCount: netFailCount,
        baseMs: CFG.netBackoffBaseMs,
        maxMs: CFG.netBackoffMaxMs,
      });

      await event('NETWORK_FAILURE', {
        market_id: current?.marketId,
        slug: current?.slug,
        error_type: errType,
        err: String(e?.message || e),
        consecutive_failures: netFailCount,
        backoff_ms: backoffMs,
      });

      if (shouldSafeHaltByNetwork({ consecutiveFailures: netFailCount, threshold: CFG.netFailThreshold })) {
        tradeState.halted = true;
        tradeState.halt_reason = 'network_instability';
        tradeState.last_reconcile_ts = ts();
        await saveTradeState(tradeState);
        await event('SAFE_HALT_TRIGGERED', {
          run_id: runId,
          reason: 'network_instability',
          consecutive_failures: netFailCount,
          threshold: CFG.netFailThreshold,
          market_id: current?.marketId,
        });
        break;
      }

      current = null;
      await sleep(backoffMs);
      continue;
    }

    await sleep(CFG.tickSec * 1000);
  }

  // final close
  if (position && current) {
    try {
      const yesP = await midpoint(current.yesToken);
      const noP = await midpoint(current.noToken);
      const mark = position.outcome === 'yes' ? yesP : noP;
      const px = mark * (1 - slip);
      const notional = px * position.qty;
      const fee = notional * CFG.feeRate;
      const pnl = (px - position.avg) * position.qty - fee;
      cash += notional - fee;
      realizedPnl += pnl;
      trades += 1;
      if (pnl > 0) wins += 1;
      position = null;
    } catch {}
  }

  // === FINALIZATION: Ensure all orders are finalized and exposure is synced ===
  await event('RUNNER_FINALIZATION_START', {});
  
  // === CRITICAL FIX: Query exchange for final state before finalizing ===
  // Fetch latest positions from exchange to capture any late fills
  let exchangePositions = [];
  try {
    const posResult = await liveGateway.getPositions();
    if (posResult?.reason) {
      await event('RUNNER_FINAL_EXCHANGE_QUERY_FAILED', {
        reason: posResult.reason,
        detail: posResult.detail || posResult.reason,
        action: 'SAFE_HALT',
      });
      if (CFG.mode === 'live' && !CFG.liveDryRun) {
        tradeState.halted = true;
        tradeState.halt_reason = 'final_exchange_positions_inconclusive';
        tradeState.last_reconcile_ts = ts();
        await saveTradeState(tradeState);
        throw new Error(`final_exchange_positions_inconclusive:${posResult.reason}`);
      }
    } else if (Array.isArray(posResult?.positions)) {
      exchangePositions = normalizePositionsArray(posResult);
      await event('RUNNER_FINAL_EXCHANGE_QUERY', {
        positions_count: exchangePositions.length,
        source: posResult.source || 'polymarket_data_api_account_positions',
      });
    }
  } catch (e) {
    await event('RUNNER_FINAL_EXCHANGE_QUERY_FAILED', { error: e.message });
    if (CFG.mode === 'live' && !CFG.liveDryRun && String(e?.message || '').startsWith('final_exchange_positions_inconclusive:')) {
      throw e;
    }
  }
  
  // Finalize all orders - use ACTUAL exchange status, don't assume
  for (const [clientOrderId, order] of Object.entries(tradeState.intents || {})) {
    // Query actual order status from exchange if not in terminal state
    let actualStatus = order.status;
    let actualExecutedSize = order.executed_size || 0;
    const orderRec = tradeState.orders?.[clientOrderId] || null;
    if (!order.token_id) order.token_id = orderRec?.asset_id || orderRec?.token_id || parseTokenIdFromClientOrderId(clientOrderId) || order.token_id;
    if (!order.asset_id) order.asset_id = orderRec?.asset_id || orderRec?.token_id || order.asset_id;
    if (!order.market_id) order.market_id = orderRec?.market_id || order.market_id;
    const shouldAuditTerminalAtFinalize = !CFG.liveDryRun && isTerminalLateFillAuditable(order, Date.now());
    
    if ((!isFinalOrderStatus(String(order.status || '').toLowerCase()) || shouldAuditTerminalAtFinalize) && order.order_id) {
      try {
        const queryResult = await liveGateway.queryOrderStatus(order);
        if (queryResult?.status) {
          actualStatus = queryResult.status;
          actualExecutedSize = Number(queryResult.executed_size) || 0;
          order.status = actualStatus;
          order.executed_size = actualExecutedSize;
          if (queryResult?.fill_price != null && Number.isFinite(Number(queryResult.fill_price))) {
            order.fill_price = Number(queryResult.fill_price);
          }
          await event('RUNNER_FINAL_ORDER_QUERY', {
            client_order_id: clientOrderId,
            order_id: order.order_id,
            status: actualStatus,
            executed_size: actualExecutedSize,
          });
        }
      } catch (e) {
        await event('RUNNER_FINAL_ORDER_QUERY_FAILED', { 
          client_order_id: clientOrderId,
          error: e.message 
        });
      }
    }
    
    const status = String(actualStatus || '').toLowerCase();
    
    // Update exposure_ledger based on ACTUAL fill from exchange (incremental accounting)
    if (actualExecutedSize > 0 && (status === 'filled' || status === 'partial_filled')) {
      const tokenId = resolveTokenIdForRecord({ order, clientOrderId, orderRecord: orderRec });
      if (!tokenId && !CFG.liveDryRun) {
        tradeState.halted = true;
        tradeState.halt_reason = 'fill_missing_token_id';
        tradeState.last_reconcile_ts = ts();
        await event('RUNNER_FINAL_EXPOSURE_UPDATE_BLOCKED', {
          client_order_id: clientOrderId,
          order_id: order.order_id,
          reason: 'missing_token_id',
          executed_size: actualExecutedSize,
          status,
        });
        await event('SAFE_HALT_TRIGGERED', {
          run_id: runId,
          reason: 'fill_missing_token_id',
          client_order_id: clientOrderId,
          order_id: order.order_id,
        });
        continue;
      }
      const holdingBefore = tokenId && exposureLedger ? (exposureLedger.holdings[tokenId] || 0) : null;
      updateOrderOnFill(order, actualExecutedSize, Number(order.fill_price || 0), null, isFinalOrderStatus(status));
      const holdingAfter = tokenId && exposureLedger ? (exposureLedger.holdings[tokenId] || 0) : null;
      await event('RUNNER_FINAL_EXPOSURE_UPDATE', {
        client_order_id: clientOrderId,
        token_id: tokenId || null,
        executed_size: actualExecutedSize,
        holding_before: holdingBefore,
        new_holding: holdingAfter,
      });
    }

    if (!CFG.liveDryRun) {
      await markTerminalLateFillAudit({
        record: order,
        onEvent: event,
        runId,
        marketId: order.market_id || current?.marketId,
        nowMs: Date.now(),
      });
    }
    
    // Do NOT force non-terminal orders into expired at run end.
    // Preserve unresolved truth and emit explicit stuck signal.
    if (!isFinalOrderStatus(status)) {
      await event('ORDER_LIFECYCLE_STUCK', {
        client_order_id: clientOrderId,
        order_id: order.order_id,
        status,
        reason: 'run_end_non_terminal_order',
      });
    }
    // Also ensure all terminal orders have lifecycle_finalized_at
    if (isFinalOrderStatus(status) && !order.lifecycle_finalized_at) {
      order.lifecycle_finalized_at = ts();
      order.lifecycle_resolution_reason = 'terminal_state_confirmed';
    }
    
    // Keep order ledger consistent with terminal semantics
    if (tradeState.orders?.[clientOrderId]) {
      const orderRec = tradeState.orders[clientOrderId];
      orderRec.normalized_status = order.status;
      if (isFinalOrderStatus(status)) {
        orderRec.final_state = status;
        orderRec.final_reason = order.lifecycle_resolution_reason || status;
        orderRec.finalized_at = ts();
      }
      orderRec.updated_at = ts();
    }
  }
  
  // CRITICAL: DO NOT clear orders - they must persist for audit/recovery
  // Orders are kept in tradeState.orders for post-run analysis
  
  // Update exposure ledger sync timestamp
  exposureLedger.last_reconcile_ts = ts();
  exposureLedger.synced_at = ts();

  if (CFG.mode === 'live' && !CFG.liveDryRun) {
    try {
      const balResult = liveGateway.getBalance ? await liveGateway.getBalance() : null;
      if (balResult?.balance != null) {
        const parsedBalance = parseExchangeBalance(balResult.balance);
        exchangeCashAfter = parsedBalance;
        if (parsedBalance != null) {
          tradeState.exchange_cash_balance = parsedBalance;
          tradeState.canonical_cash_source = 'exchange';
        }
      }
      await event('RUNNER_FINAL_BALANCE_QUERY', {
        source: balResult?.source || 'py_clob_client_v2_get_balance_allowance',
        balance: exchangeCashAfter,
      });
    } catch (e) {
      await event('RUNNER_FINAL_BALANCE_QUERY_FAILED', {
        error: String(e?.message || e),
      });
    }
  }

  if (CFG.mode === 'live' && !CFG.liveDryRun && typeof liveGateway.getRecentTrades === 'function') {
    try {
      const afterTradesRes = await liveGateway.getRecentTrades(EXCHANGE_TRADES_SNAPSHOT_LIMIT);
      if (!afterTradesRes?.reason) {
        exchangeTradesAfterSnapshot = buildExchangeTradesSnapshot(afterTradesRes.trades);
        exchangeTradesDelta = computeExchangeTradesDelta(exchangeTradesBeforeSnapshot, exchangeTradesAfterSnapshot);
        await event('RUNNER_EXCHANGE_TRADES_AFTER', {
          source: afterTradesRes.source || 'py_clob_client_v2_get_trades',
          trades_count: exchangeTradesAfterSnapshot.count,
          limit: EXCHANGE_TRADES_SNAPSHOT_LIMIT,
          exchange_trades_delta: exchangeTradesDelta,
        });
      } else {
        await event('RUNNER_EXCHANGE_TRADES_AFTER_FAILED', {
          reason: afterTradesRes.reason,
          detail: afterTradesRes.detail,
          source: afterTradesRes.source || 'unknown',
        });
      }
    } catch (e) {
      await event('RUNNER_EXCHANGE_TRADES_AFTER_FAILED', {
        reason: 'exception',
        detail: String(e?.message || e),
      });
    }
  }

  if (Number.isFinite(exchangeCashBefore) && Number.isFinite(exchangeCashAfter)) {
    exchangeCashDelta = Number((exchangeCashAfter - exchangeCashBefore).toFixed(6));
  }

  const localOrdersCount = ordersCount;
  const localTotalTrades = trades;
  const localFillObserved = runtimeFilledOrderIds.size > 0 || localOrdersCount > 0 || localTotalTrades > 0;
  let backfillRequired = false;
  let backfillApplied = false;

  if (
    CFG.mode === 'live' &&
    !CFG.liveDryRun &&
    Number.isFinite(exchangeCashDelta) &&
    exchangeCashDelta < -BACKFILL_BALANCE_DROP_THRESHOLD &&
    !localFillObserved
  ) {
    backfillRequired = true;
    await event('BACKFILL_REQUIRED', {
      run_id: runId,
      reason: 'balance_down_without_local_fill',
      exchange_cash_before: exchangeCashBefore,
      exchange_cash_after: exchangeCashAfter,
      exchange_cash_delta: exchangeCashDelta,
      local_orders_count: localOrdersCount,
      local_total_trades: localTotalTrades,
      runtime_filled_orders: runtimeFilledOrderIds.size,
      exchange_trades_delta: exchangeTradesDelta,
      threshold: BACKFILL_BALANCE_DROP_THRESHOLD,
    });

    let positionsForBackfill = Array.isArray(exchangePositions) ? exchangePositions : [];
    if (positionsForBackfill.length === 0) {
      try {
        const posRetry = await liveGateway.getPositions();
        positionsForBackfill = normalizePositionsArray(posRetry);
      } catch {}
    }

    if (positionsForBackfill.length > 0) {
      const prevHoldingsCount = Object.keys(exposureLedger.holdings || {}).length;
      const backfillRes = backfillExposureLedgerFromPositions(exposureLedger, positionsForBackfill);
      backfillApplied = true;
      await event('BACKFILL_APPLIED', {
        run_id: runId,
        reason: 'balance_down_without_local_fill',
        previous_holdings_count: prevHoldingsCount,
        new_holdings_count: Object.keys(exposureLedger.holdings || {}).length,
        non_zero_holdings: backfillRes.nonZeroCount,
      });
    } else {
      await event('BACKFILL_SKIPPED', {
        run_id: runId,
        reason: 'positions_unavailable',
      });
    }
  }
  
  await saveTradeState(tradeState);
  await event('RUNNER_FINALIZATION_COMPLETE', {
    holdings_count: Object.keys(exposureLedger.holdings || {}).length,
    finalized_orders: Object.keys(tradeState.intents || {}).length,
  });

  const inferredOrdersByExchange = Number(exchangeTradesDelta) > 0 ? 1 : 0;
  const effectiveOrdersCount = Math.max(localOrdersCount, runtimeFilledOrderIds.size, inferredOrdersByExchange);
  const effectiveTrades = Math.max(
    localTotalTrades,
    runtimeFilledOrderIds.size,
    Number.isFinite(exchangeTradesDelta) ? exchangeTradesDelta : 0
  );
  const realFill = effectiveTrades > 0;

  const summary = {
    orders_count: effectiveOrdersCount,
    avg_fill_slippage: Number((localOrdersCount ? slippageBpsSum / localOrdersCount : 0).toFixed(4)),
    final_equity: Number(cash.toFixed(6)),
    total_trades: effectiveTrades,
    win_rate: Number((localTotalTrades ? wins / localTotalTrades : 0).toFixed(4)),
    max_drawdown: Number(mdd.toFixed(6)),
    markets_traded: [...new Set(marketsTraded)],
    local_orders_count: localOrdersCount,
    local_total_trades: localTotalTrades,
    runtime_filled_orders: runtimeFilledOrderIds.size,
    exchange_trades_before: exchangeTradesBeforeSnapshot?.count ?? null,
    exchange_trades_after: exchangeTradesAfterSnapshot?.count ?? null,
    exchange_trades_delta: exchangeTradesDelta,
    exchange_cash_before: exchangeCashBefore,
    exchange_cash_after: exchangeCashAfter,
    exchange_cash_delta: exchangeCashDelta,
    backfill_required: backfillRequired,
    backfill_applied: backfillApplied,
    real_fill: realFill,
  };
  await event('FINAL_RESULT', {
    run_id: runId,
    real_fill: realFill,
    exchange_trades_delta: exchangeTradesDelta,
    orders_count: effectiveOrdersCount,
    total_trades: effectiveTrades,
    backfill_required: backfillRequired,
    backfill_applied: backfillApplied,
  });
  await event('RUNNER_SUMMARY', summary);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(async (e) => {
  await event('RUNNER_FATAL', { err: String(e?.message || e) });
  console.error(e?.message || String(e));
  process.exit(1);
});
