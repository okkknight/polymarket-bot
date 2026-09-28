#!/usr/bin/env node

import { mkdir, appendFile, writeFile, readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { selectFirstTradableRollingMarket } from '../core/rolling_market_selector.mjs';

const GAMMA_API = 'https://gamma-api.polymarket.com/markets';
const CLOB_BASE = 'https://clob.polymarket.com';
const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const DEFAULT_TICKS = 120;
const DEFAULT_INTERVAL_SEC = 30;
const DEFAULT_ACTIVE_LIMIT = 200;

function pad(n) { return String(n).padStart(2, '0'); }
function tsFile(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function tsLog(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getArg(argv, key, fallback) {
  const idx = argv.indexOf(key);
  if (idx === -1) return fallback;
  return argv[idx + 1];
}

function parseBool(input, fallback = false) {
  if (input === undefined) return fallback;
  const v = String(input).trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`Invalid boolean value: ${input} (use true|false)`);
}

function parseArgs(argv) {
  const tokenId = getArg(argv, '--tokenId', '').trim();
  const marketId = getArg(argv, '--marketId', '').trim();
  const q = getArg(argv, '--q', '').trim();
  const slugPrefix = getArg(argv, '--slugPrefix', '').trim();
  const activeLimitRaw = getArg(argv, '--activeLimit', String(DEFAULT_ACTIVE_LIMIT));
  const ticksRaw = getArg(argv, '--ticks', String(DEFAULT_TICKS));
  const intervalRaw = getArg(argv, '--intervalSec', String(DEFAULT_INTERVAL_SEC));
  const endpoint = getArg(argv, '--endpoint', 'midpoint').trim(); // midpoint | price
  const side = getArg(argv, '--side', 'buy').trim(); // for /price endpoint
  const outcome = getArg(argv, '--outcome', 'both').trim().toLowerCase(); // yes | no | both
  const separateOutcomeColumn = parseBool(getArg(argv, '--separateOutcomeColumn'), false);
  const followRolling = parseBool(getArg(argv, '--followRolling'), false);
  const statsSnapshotSecRaw = getArg(argv, '--statsSnapshotSec', '3600');
  const maxRuntimeSecRaw = getArg(argv, '--maxRuntimeSec', '0');

  const ticks = Number(ticksRaw);
  const intervalSec = Number(intervalRaw);
  const activeLimit = Number(activeLimitRaw);
  const statsSnapshotSec = Number(statsSnapshotSecRaw);
  const maxRuntimeSec = Number(maxRuntimeSecRaw);
  if (!Number.isInteger(ticks) || ticks < 0) throw new Error(`Invalid --ticks: ${ticksRaw} (use 0 for infinite)`);
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) throw new Error(`Invalid --intervalSec: ${intervalRaw}`);
  if (!Number.isInteger(activeLimit) || activeLimit <= 0) throw new Error(`Invalid --activeLimit: ${activeLimitRaw}`);
  if (!Number.isFinite(statsSnapshotSec) || statsSnapshotSec <= 0) throw new Error(`Invalid --statsSnapshotSec: ${statsSnapshotSecRaw}`);
  if (!Number.isFinite(maxRuntimeSec) || maxRuntimeSec < 0) throw new Error(`Invalid --maxRuntimeSec: ${maxRuntimeSecRaw}`);
  if (!['midpoint', 'price'].includes(endpoint)) throw new Error(`Invalid --endpoint: ${endpoint}`);
  if (!['buy', 'sell'].includes(side)) throw new Error(`Invalid --side: ${side}`);
  if (!['yes', 'no', 'both'].includes(outcome)) throw new Error(`Invalid --outcome: ${outcome}`);

  const hasDirect = Boolean(tokenId || marketId);
  const hasDynamic = Boolean(q || slugPrefix);
  if (!hasDirect && !hasDynamic) {
    throw new Error('Require direct mode (--tokenId/--marketId) or rolling mode (--q and/or --slugPrefix)');
  }

  return {
    tokenId,
    marketId,
    q,
    slugPrefix,
    activeLimit,
    ticks,
    intervalSec,
    endpoint,
    side,
    outcome,
    separateOutcomeColumn,
    followRolling,
    statsSnapshotSec,
    maxRuntimeSec,
  };
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchJsonWithRetry(url) {
  let lastErr;
  for (let i = 1; i <= MAX_RETRIES; i++) {
    const start = performance.now();
    try {
      const res = await fetchWithTimeout(url, TIMEOUT_MS);
      const elapsedMs = Math.round(performance.now() - start);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw Object.assign(new Error(`HTTP ${res.status} ${text}`.trim()), { httpStatus: res.status, elapsedMs });
      }
      const data = await res.json();
      return { data, elapsedMs, attempt: i };
    } catch (err) {
      lastErr = err;
      if (i < MAX_RETRIES) await sleep(500 * (2 ** (i - 1)));
    }
  }
  throw lastErr;
}

async function log(line) {
  await mkdir('logs', { recursive: true });
  await appendFile('logs/polymarket_price_tracker.log', line + '\n', 'utf8');
}

function parseJsonMaybe(input, fallback = null) {
  if (input == null) return fallback;
  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch {
      return fallback;
    }
  }
  return input;
}

function parseTokenIdsFromMarket(market) {
  const raw = market?.clobTokenIds;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    const arr = parseJsonMaybe(raw, []);
    return Array.isArray(arr) ? arr.map(String) : [];
  }
  return [];
}

function resolveYesNoFromMarket(market) {
  const allTokenIds = parseTokenIdsFromMarket(market);
  let yesTokenId = null;
  let noTokenId = null;
  let mappingConfirmed = false;
  let mappingSource = 'none';

  const tokens = parseJsonMaybe(market?.tokens, null);
  if (Array.isArray(tokens)) {
    for (const t of tokens) {
      const label = String(t?.outcome ?? t?.label ?? '').trim().toLowerCase();
      const tid = String(t?.tokenId ?? t?.id ?? '').trim();
      if (!tid) continue;
      if (label === 'yes') yesTokenId = tid;
      if (label === 'no') noTokenId = tid;
    }
    if (yesTokenId || noTokenId) {
      mappingSource = 'tokens';
      mappingConfirmed = Boolean(yesTokenId && noTokenId);
    }
  }

  if (!(yesTokenId && noTokenId)) {
    const outcomes = parseJsonMaybe(market?.outcomes, []);
    if (Array.isArray(outcomes) && outcomes.length && allTokenIds.length >= outcomes.length) {
      const idxYes = outcomes.findIndex(x => String(x).trim().toLowerCase() === 'yes');
      const idxNo = outcomes.findIndex(x => String(x).trim().toLowerCase() === 'no');
      if (idxYes >= 0 && idxYes < allTokenIds.length) yesTokenId = yesTokenId || allTokenIds[idxYes];
      if (idxNo >= 0 && idxNo < allTokenIds.length) noTokenId = noTokenId || allTokenIds[idxNo];
      if (idxYes >= 0 || idxNo >= 0) {
        mappingSource = 'outcomes+clobTokenIds';
        mappingConfirmed = Boolean(yesTokenId && noTokenId);
      }
    }
  }

  if (!(yesTokenId && noTokenId) && allTokenIds.length >= 2) {
    yesTokenId = yesTokenId || allTokenIds[0];
    noTokenId = noTokenId || allTokenIds[1];
    mappingSource = mappingSource === 'none' ? 'clobTokenIds(fallback)' : mappingSource;
    mappingConfirmed = false;
  }

  return {
    yesTokenId: yesTokenId || null,
    noTokenId: noTokenId || null,
    allTokenIds,
    market,
    mappingConfirmed,
    mappingSource,
  };
}

async function resolveTokensByMarketId(marketId) {
  const url = `${GAMMA_API}/${encodeURIComponent(marketId)}`;
  const { data } = await fetchJsonWithRetry(url);
  const market = data;
  if (!market || typeof market !== 'object') throw new Error(`Market not found by id=${marketId}`);

  const resolved = resolveYesNoFromMarket(market);
  if (!resolved.yesTokenId && !resolved.noTokenId) {
    throw new Error(`No token ids found for marketId=${marketId}`);
  }
  return resolved;
}

function toMs(input) {
  if (!input) return null;
  const v = Date.parse(input);
  return Number.isFinite(v) ? v : null;
}

function getLatestActivityMs(market) {
  const candidates = [market?.latestTradeTime, market?.createdAt, market?.updatedAt].map(toMs).filter(v => v !== null);
  if (!candidates.length) return null;
  return Math.max(...candidates);
}

function marketSummary(m) {
  return {
    marketId: m?.id ?? null,
    question: m?.question ?? null,
    slug: m?.slug ?? null,
    endDate: m?.endDate ?? null,
    latestTradeTime: m?.latestTradeTime ?? null,
    createdAt: m?.createdAt ?? null,
  };
}

function filterRollingMarkets(markets, q, slugPrefix) {
  const qNorm = q.trim().toLowerCase();
  const slugNorm = slugPrefix.trim().toLowerCase();

  return markets.filter(m => {
    const question = String(m?.question ?? '').toLowerCase();
    const slug = String(m?.slug ?? '').toLowerCase();

    const qMatch = qNorm ? (question.includes(qNorm) || slug.includes(qNorm)) : true;
    const slugMatch = slugNorm ? slug.startsWith(slugNorm) : true;
    return qMatch && slugMatch;
  });
}

function rankRollingCandidates(markets, nowMs) {
  return [...markets].sort((a, b) => {
    const aEnd = toMs(a?.endDate);
    const bEnd = toMs(b?.endDate);
    const aFuture = aEnd !== null && aEnd > nowMs;
    const bFuture = bEnd !== null && bEnd > nowMs;

    if (aFuture !== bFuture) return aFuture ? -1 : 1;

    if (aFuture && bFuture) {
      const da = aEnd - nowMs;
      const db = bEnd - nowMs;
      if (da !== db) return da - db;
    }

    const aLatest = getLatestActivityMs(a) ?? -Infinity;
    const bLatest = getLatestActivityMs(b) ?? -Infinity;
    if (aLatest !== bLatest) return bLatest - aLatest;

    const aEndSafe = aEnd ?? -Infinity;
    const bEndSafe = bEnd ?? -Infinity;
    return bEndSafe - aEndSafe;
  });
}

function buildPriceUrl(base, tokenId, endpoint, side) {
  if (endpoint === 'midpoint') return `${base}/midpoint?token_id=${encodeURIComponent(tokenId)}`;
  return `${base}/price?token_id=${encodeURIComponent(tokenId)}&side=${encodeURIComponent(side)}`;
}

function extractPrice(payload) {
  if (payload == null) return null;
  if (typeof payload === 'number') return payload;
  if (typeof payload === 'string') {
    const n = Number(payload);
    return Number.isFinite(n) ? n : null;
  }
  const keys = ['price', 'midpoint', 'mid', 'value'];
  for (const k of keys) {
    const v = payload[k];
    if (v !== undefined && v !== null) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

async function ensureCsvHeader(path, header = 'timestamp,price') {
  try {
    const content = await readFile(path, 'utf8');
    if (content.length > 0) return;
  } catch {}
  await writeFile(path, `${header}\n`, 'utf8');
}

async function probeMidpointOrThrow(tokenId) {
  const url = `${CLOB_BASE}/midpoint?token_id=${encodeURIComponent(tokenId)}`;
  const { data } = await fetchJsonWithRetry(url);
  const price = extractPrice(data);
  if (price === null) {
    throw new Error(`MIDPOINT_EMPTY tokenId=${tokenId} payload=${JSON.stringify(data)}`);
  }
  return { tokenId, midpoint: price, endpoint: 'midpoint' };
}

async function saveSelectionSnapshot(payload) {
  await mkdir('data', { recursive: true });
  const file = `data/selection_${tsFile()}.json`;
  await writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

async function probeFirstTradableToken(resolved) {
  const candidates = [resolved?.yesTokenId, resolved?.noTokenId].filter(Boolean);
  let lastErr = null;
  for (const tokenId of candidates) {
    try {
      const probeResult = await probeMidpointOrThrow(tokenId);
      return { probeTokenId: tokenId, probeResult };
    } catch (err) {
      lastErr = err;
      continue;
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('NO_PROBE_TOKEN');
}

function floorTo5mEpochSec(nowSec) {
  return Math.floor(nowSec / 300) * 300;
}

function buildSlugWindowCandidates(slugPrefix, span = 6) {
  const nowSec = Math.floor(Date.now() / 1000);
  const base = floorTo5mEpochSec(nowSec);
  const slugs = [];
  for (let k = -span; k <= span; k++) {
    slugs.push(`${slugPrefix}-${base + k * 300}`);
  }
  return slugs;
}

async function fetchMarketsBySlug(slug) {
  const url = `${GAMMA_API}?slug=${encodeURIComponent(slug)}`;
  const { data } = await fetchJsonWithRetry(url);
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return [data];
  return [];
}

function shouldUseDirectSlugProbe(args) {
  return Boolean(args.slugPrefix && /^btc-updown-5m$/i.test(args.slugPrefix.trim()));
}

async function resolveRollingLatestMarket(args) {
  const nowMs = Date.now();
  let ranked = [];
  let selectionReason = 'PRIMARY(endDate nearest future) then FALLBACK(latestTradeTime/createdAt)';

  if (shouldUseDirectSlugProbe(args)) {
    const selected = await selectFirstTradableRollingMarket({
      slugPrefix: args.slugPrefix,
      nowMs,
      fetchMarketsBySlug,
      resolveYesNoFromMarket,
      probeMidpoint: async (tokenId) => {
        const r = await probeMidpointOrThrow(tokenId);
        return Number(r.midpoint);
      },
      isClosed: (m) => {
        const end = toMs(m?.endDate);
        return Boolean(m?.closed) || (end !== null && end < Date.now());
      },
      onLog: async (line) => log(`[${tsLog()}] ${line}`),
    });

    if (!selected) {
      const selectionFile = await saveSelectionSnapshot({
        timestamp: new Date().toISOString(),
        filters: { q: args.q, slugPrefix: args.slugPrefix, activeLimit: args.activeLimit },
        matched: [],
        pickedMarket: null,
        selectionReason: 'NO_MATCHED_MARKET_BY_DIRECT_SELECTOR',
        probeResult: null,
      });
      throw new Error(`No tradable market matched direct selector. slugPrefix=${JSON.stringify(args.slugPrefix)} selectionFile=${selectionFile}`);
    }

    const resolved = resolveYesNoFromMarket(selected.market);
    const selectionFile = await saveSelectionSnapshot({
      timestamp: new Date().toISOString(),
      filters: { q: args.q, slugPrefix: args.slugPrefix, activeLimit: args.activeLimit },
      matched: [marketSummary(selected.market)],
      pickedMarket: {
        ...marketSummary(selected.market),
        yesTokenId: resolved.yesTokenId,
        noTokenId: resolved.noTokenId,
        mappingSource: resolved.mappingSource,
        mappingConfirmed: resolved.mappingConfirmed,
      },
      selectionReason: 'DIRECT_SELECTOR(t-300,t,t+300)+MIDPOINT_PROBE',
      probeResult: { tokenId: selected.yesTokenId, midpoint: selected.yesMid, endpoint: 'midpoint' },
    });

    return {
      resolved,
      selectedMarket: selected.market,
      probeTokenId: selected.yesTokenId,
      probeResult: { tokenId: selected.yesTokenId, midpoint: selected.yesMid, endpoint: 'midpoint' },
      selectionReason: 'DIRECT_SELECTOR(t-300,t,t+300)+MIDPOINT_PROBE',
      totalCandidates: 1,
      selectionFile,
    };
  } else {
    const listUrl = `${GAMMA_API}?active=true&closed=false&limit=${args.activeLimit}`;
    const { data: markets } = await fetchJsonWithRetry(listUrl);
    if (!Array.isArray(markets)) throw new Error('Gamma /markets response is not an array');

    const filtered = filterRollingMarkets(markets, args.q, args.slugPrefix);
    if (!filtered.length) {
      const selectionFile = await saveSelectionSnapshot({
        timestamp: new Date().toISOString(),
        filters: { q: args.q, slugPrefix: args.slugPrefix, activeLimit: args.activeLimit },
        matched: [],
        pickedMarket: null,
        selectionReason: 'NO_MATCHED_MARKET',
        probeResult: null,
      });
      throw new Error(`No active market matched filters. q=${JSON.stringify(args.q)} slugPrefix=${JSON.stringify(args.slugPrefix)} selectionFile=${selectionFile}`);
    }

    ranked = rankRollingCandidates(filtered, nowMs);
  }

  const matchedList = ranked.map(marketSummary);

  for (const m of ranked) {
    try {
      const resolved = resolveYesNoFromMarket(m);
      if (!resolved.yesTokenId && !resolved.noTokenId) {
        await log(`[${tsLog()}] rolling_skip marketId=${m?.id ?? 'N/A'} reason=NO_TOKEN`);
        continue;
      }

      const { probeTokenId, probeResult } = await probeFirstTradableToken(resolved);

      const selectionFile = await saveSelectionSnapshot({
        timestamp: new Date().toISOString(),
        filters: { q: args.q, slugPrefix: args.slugPrefix, activeLimit: args.activeLimit },
        matched: matchedList,
        pickedMarket: {
          ...marketSummary(m),
          yesTokenId: resolved.yesTokenId,
          noTokenId: resolved.noTokenId,
          mappingSource: resolved.mappingSource,
          mappingConfirmed: resolved.mappingConfirmed,
        },
        selectionReason,
        probeResult,
      });

      return {
        resolved,
        selectedMarket: m,
        probeTokenId,
        probeResult,
        selectionReason,
        totalCandidates: ranked.length,
        selectionFile,
      };
    } catch (err) {
      if (err?.httpStatus === 404) {
        const msg = `[${tsLog()}] rolling_skip marketId=${m?.id ?? 'N/A'} reason=NO_ORDERBOOK_404`;
        console.error(msg);
        await log(msg);
        continue;
      }
      const msg = err?.message || String(err);
      const logLine = `[${tsLog()}] rolling_skip marketId=${m?.id ?? 'N/A'} reason=${JSON.stringify(msg)}`;
      console.error(logLine);
      await log(logLine);
      continue;
    }
  }

  const selectionFile = await saveSelectionSnapshot({
    timestamp: new Date().toISOString(),
    filters: { q: args.q, slugPrefix: args.slugPrefix, activeLimit: args.activeLimit },
    matched: matchedList,
    pickedMarket: null,
    selectionReason: 'ALL_CANDIDATES_UNAVAILABLE',
    probeResult: null,
  });
  throw new Error(`All ${ranked.length} matched candidates unavailable (no usable orderbook), selectionFile=${selectionFile}`);
}

function buildTrackers(args, yesTokenId, noTokenId) {
  if (args.outcome === 'yes' && !yesTokenId) throw new Error('Requested outcome=yes but yesTokenId is missing');
  if (args.outcome === 'no' && !noTokenId) throw new Error('Requested outcome=no but noTokenId is missing');

  const trackers = [];
  if (args.outcome === 'yes' || args.outcome === 'both') trackers.push({ outcome: 'yes', tokenId: yesTokenId });
  if (args.outcome === 'no' || args.outcome === 'both') trackers.push({ outcome: 'no', tokenId: noTokenId });

  const dedup = new Map();
  for (const t of trackers) {
    if (!t.tokenId) continue;
    dedup.set(`${t.outcome}:${t.tokenId}`, t);
  }
  const finalTrackers = [...dedup.values()];
  if (finalTrackers.length === 0) throw new Error('No valid token selected for tracking');

  return finalTrackers;
}

function createStatsState() {
  return {
    sample_count: 0,
    change_count: 0,
    nonzero_change_count: 0,
    nonzero_ratio: 0,
    max_abs_change: 0,
    last_price_by_outcome: {},
    market_ids: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function updateStats(stats, outcome, price, marketId) {
  const prev = stats.last_price_by_outcome[outcome];
  if (typeof prev === 'number') {
    const delta = price - prev;
    stats.change_count += 1;
    if (delta !== 0) stats.nonzero_change_count += 1;
    const absDelta = Math.abs(delta);
    if (absDelta > stats.max_abs_change) stats.max_abs_change = absDelta;
  }

  stats.last_price_by_outcome[outcome] = price;
  stats.sample_count += 1;
  stats.nonzero_ratio = stats.change_count > 0 ? stats.nonzero_change_count / stats.change_count : 0;
  stats.updated_at = new Date().toISOString();
  if (marketId && !stats.market_ids.includes(String(marketId))) stats.market_ids.push(String(marketId));
}

async function writeStatsFile(marketId, stats, args) {
  if (!marketId) return null;
  await mkdir('data', { recursive: true });
  const file = `data/stats_${marketId}.json`;
  const payload = {
    marketId: String(marketId),
    q: args.q,
    slugPrefix: args.slugPrefix,
    followRolling: args.followRolling,
    endpoint: args.endpoint,
    side: args.side,
    outcome: args.outcome,
    ticks: args.ticks,
    intervalSec: args.intervalSec,
    ...stats,
  };
  await writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

async function main() {
  const started = new Date();
  try {
    const args = parseArgs(process.argv.slice(2));

    let stopRequested = false;
    const stopHandler = async (sig) => {
      stopRequested = true;
      console.log(`Received ${sig}, will stop after current tick...`);
      await log(`[${tsLog()}] signal=${sig} stop_requested=true`);
    };
    process.once('SIGINT', () => { void stopHandler('SIGINT'); });
    process.once('SIGTERM', () => { void stopHandler('SIGTERM'); });

    let yesTokenId = null;
    let noTokenId = null;
    let allTokenIds = [];
    let market = null;
    let mappingConfirmed = true;
    let mappingSource = 'tokenId-direct';
    let selectionFile = null;

    if (args.tokenId) {
      if (args.outcome === 'yes' || args.outcome === 'both') yesTokenId = args.tokenId;
      if (args.outcome === 'no' || args.outcome === 'both') noTokenId = args.tokenId;
      allTokenIds = [args.tokenId];
      mappingConfirmed = false;
      mappingSource = 'tokenId-direct(no yes/no semantic guarantee)';
    } else if (args.marketId) {
      const resolved = await resolveTokensByMarketId(args.marketId);
      yesTokenId = resolved.yesTokenId;
      noTokenId = resolved.noTokenId;
      allTokenIds = resolved.allTokenIds;
      market = resolved.market;
      mappingConfirmed = resolved.mappingConfirmed;
      mappingSource = resolved.mappingSource;
    } else {
      const rolling = await resolveRollingLatestMarket(args);
      const resolved = rolling.resolved;
      yesTokenId = resolved.yesTokenId;
      noTokenId = resolved.noTokenId;
      allTokenIds = resolved.allTokenIds;
      market = rolling.selectedMarket;
      mappingConfirmed = resolved.mappingConfirmed;
      mappingSource = `${resolved.mappingSource}+rolling-latest`;
      selectionFile = rolling.selectionFile;

      console.log(`rollingSelection: matched=${rolling.totalCandidates} picked_marketId=${market?.id ?? 'N/A'} probeTokenId=${rolling.probeTokenId}`);
      console.log(`selectionFile: ${selectionFile}`);
    }

    let finalTrackers = buildTrackers(args, yesTokenId, noTokenId);

    await mkdir('data', { recursive: true });

    let combinedCsvFile = null;
    if (args.separateOutcomeColumn) {
      const base = market?.id ? `market_${market.id}` : `token_${(args.tokenId || 'unknown')}`;
      combinedCsvFile = `data/price_${base}_combined.csv`;
      await ensureCsvHeader(combinedCsvFile, 'timestamp,outcome,tokenId,price');
    }

    for (const t of finalTrackers) {
      t.csvFile = `data/price_${t.tokenId}.csv`;
      await ensureCsvHeader(t.csvFile, 'timestamp,price');
    }

    if (market) {
      console.log(`marketId: ${market.id}`);
      console.log(`question: ${market.question}`);
      console.log(`endDate: ${market.endDate ?? 'N/A'}`);
    } else {
      console.log('marketId: N/A (direct token mode)');
      console.log('question: N/A (direct token mode)');
      console.log('endDate: N/A (direct token mode)');
    }

    console.log(`yesTokenId: ${yesTokenId ?? 'N/A'}`);
    console.log(`noTokenId: ${noTokenId ?? 'N/A'}`);
    console.log(`allTokenIds: ${JSON.stringify(allTokenIds)}`);
    console.log(`mappingSource: ${mappingSource}`);
    if (!mappingConfirmed) {
      console.log('mappingWarning: 未能确认 yes/no 映射（使用了 fallback 或 direct token 模式）');
    }

    console.log(`endpoint: ${args.endpoint}, side: ${args.side}, ticks: ${args.ticks === 0 ? 'infinite' : args.ticks}, intervalSec: ${args.intervalSec}, outcome: ${args.outcome}`);
    console.log(`separateOutcomeColumn: ${args.separateOutcomeColumn}`);
    console.log(`followRolling: ${args.followRolling}`);
    console.log(`statsSnapshotSec: ${args.statsSnapshotSec}`);
    if (args.maxRuntimeSec > 0) console.log(`maxRuntimeSec: ${args.maxRuntimeSec}`);
    for (const t of finalTrackers) {
      console.log(`csv_${t.outcome}: ${t.csvFile}`);
    }
    if (combinedCsvFile) {
      console.log(`csv_combined: ${combinedCsvFile}`);
    }

    await log(`[${tsLog(started)}] start marketId=${market?.id || args.marketId || 'N/A'} yesTokenId=${yesTokenId || 'N/A'} noTokenId=${noTokenId || 'N/A'} endpoint=${args.endpoint} side=${args.side} ticks=${args.ticks === 0 ? 'infinite' : args.ticks} intervalSec=${args.intervalSec} outcome=${args.outcome} separateOutcomeColumn=${args.separateOutcomeColumn} followRolling=${args.followRolling} statsSnapshotSec=${args.statsSnapshotSec} maxRuntimeSec=${args.maxRuntimeSec} mappingSource=${mappingSource} mappingConfirmed=${mappingConfirmed} q=${JSON.stringify(args.q)} slugPrefix=${JSON.stringify(args.slugPrefix)} selectionFile=${selectionFile || 'N/A'}`);

    const stats = createStatsState();
    const visitedMarketIds = new Set();
    const runtimeStartedAt = Date.now();
    let nextStatsSnapshotAt = runtimeStartedAt + Math.round(args.statsSnapshotSec * 1000);
    let tick = 1;

    const shouldContinue = () => (args.ticks === 0 ? true : tick <= args.ticks);
    const tickLabel = () => `${tick}/${args.ticks === 0 ? '∞' : args.ticks}`;

    while (shouldContinue()) {
      if (stopRequested) {
        await log(`[${tsLog()}] stop reason=signal_requested`);
        break;
      }

      if (args.maxRuntimeSec > 0 && (Date.now() - runtimeStartedAt) >= Math.round(args.maxRuntimeSec * 1000)) {
        console.log(`[tick ${tickLabel()}] maxRuntimeSec reached, stopping.`);
        await log(`[${tsLog()}] stop reason=maxRuntimeSec_reached maxRuntimeSec=${args.maxRuntimeSec}`);
        break;
      }

      if (market?.id) visitedMarketIds.add(String(market.id));

      if (args.followRolling && !args.marketId && !args.tokenId) {
        const marketEndMs = toMs(market?.endDate);
        if (marketEndMs !== null && Date.now() >= marketEndMs) {
          console.log(`[tick ${tickLabel()}] followRolling: market ${market?.id} endDate passed, reselection...`);
          await log(`[${tsLog()}] followRolling_reselect reason=endDate_passed oldMarketId=${market?.id ?? 'N/A'}`);

          const rolling = await resolveRollingLatestMarket(args);
          const resolved = rolling.resolved;
          yesTokenId = resolved.yesTokenId;
          noTokenId = resolved.noTokenId;
          allTokenIds = resolved.allTokenIds;
          market = rolling.selectedMarket;
          mappingSource = `${resolved.mappingSource}+rolling-latest`;
          selectionFile = rolling.selectionFile;

          finalTrackers = buildTrackers(args, yesTokenId, noTokenId);
          for (const t of finalTrackers) {
            t.csvFile = `data/price_${t.tokenId}.csv`;
            await ensureCsvHeader(t.csvFile, 'timestamp,price');
          }

          console.log(`followRolling picked marketId=${market?.id ?? 'N/A'} endDate=${market?.endDate ?? 'N/A'} selectionFile=${selectionFile}`);
          await log(`[${tsLog()}] followRolling_picked marketId=${market?.id ?? 'N/A'} selectionFile=${selectionFile}`);
        }
      }

      let reselectTriggered = false;
      for (const t of finalTrackers) {
        const url = buildPriceUrl(CLOB_BASE, t.tokenId, args.endpoint, args.side);
        const tickStart = performance.now();
        try {
          const { data, attempt } = await fetchJsonWithRetry(url);
          const price = extractPrice(data);
          const iso = new Date().toISOString();
          if (price === null) throw new Error(`No price field in response: ${JSON.stringify(data)}`);

          await appendFile(t.csvFile, `${iso},${price}\n`, 'utf8');
          if (combinedCsvFile) {
            await appendFile(combinedCsvFile, `${iso},${t.outcome},${t.tokenId},${price}\n`, 'utf8');
          }

          updateStats(stats, t.outcome, price, market?.id);

          const elapsed = Math.round(performance.now() - tickStart);
          console.log(`[tick ${tickLabel()}] outcome=${t.outcome} price=${price} attempt=${attempt} elapsed_ms=${elapsed}`);
          console.log(`[stats] change_count=${stats.change_count} nonzero_ratio=${stats.nonzero_ratio.toFixed(4)} max_abs_change=${stats.max_abs_change}`);
          await log(`[${tsLog()}] tick=${tickLabel()} outcome=${t.outcome} tokenId=${t.tokenId} marketId=${market?.id ?? 'N/A'} status=ok price=${price} elapsed_ms=${elapsed} attempt=${attempt} change_count=${stats.change_count} nonzero_ratio=${stats.nonzero_ratio} max_abs_change=${stats.max_abs_change}`);
        } catch (err) {
          const msg = err?.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : (err?.message || String(err));
          console.error(`[tick ${tickLabel()}] outcome=${t.outcome} ERROR: ${msg}`);
          await log(`[${tsLog()}] tick=${tickLabel()} outcome=${t.outcome} tokenId=${t.tokenId} marketId=${market?.id ?? 'N/A'} status=error error=${JSON.stringify(msg)}`);

          if (args.followRolling && !args.marketId && !args.tokenId && err?.httpStatus === 404) {
            reselectTriggered = true;
            await log(`[${tsLog()}] followRolling_reselect reason=midpoint_404 oldMarketId=${market?.id ?? 'N/A'} tokenId=${t.tokenId}`);
            break;
          }
        }
      }

      if (reselectTriggered) {
        const rolling = await resolveRollingLatestMarket(args);
        const resolved = rolling.resolved;
        yesTokenId = resolved.yesTokenId;
        noTokenId = resolved.noTokenId;
        allTokenIds = resolved.allTokenIds;
        market = rolling.selectedMarket;
        mappingSource = `${resolved.mappingSource}+rolling-latest`;
        selectionFile = rolling.selectionFile;

        finalTrackers = buildTrackers(args, yesTokenId, noTokenId);
        for (const t of finalTrackers) {
          t.csvFile = `data/price_${t.tokenId}.csv`;
          await ensureCsvHeader(t.csvFile, 'timestamp,price');
        }

        console.log(`[tick ${tickLabel()}] followRolling: reselected marketId=${market?.id ?? 'N/A'} selectionFile=${selectionFile}`);
        await log(`[${tsLog()}] followRolling_picked marketId=${market?.id ?? 'N/A'} selectionFile=${selectionFile}`);
        continue;
      }

      if (Date.now() >= nextStatsSnapshotAt) {
        const snapshotTargets = new Set(visitedMarketIds);
        if (market?.id) snapshotTargets.add(String(market.id));
        for (const mid of snapshotTargets) {
          await writeStatsFile(mid, stats, args);
        }
        console.log(`[stats] snapshot_written markets=${snapshotTargets.size}`);
        await log(`[${tsLog()}] stats_snapshot markets=${snapshotTargets.size} change_count=${stats.change_count} nonzero_ratio=${stats.nonzero_ratio} max_abs_change=${stats.max_abs_change}`);
        nextStatsSnapshotAt = Date.now() + Math.round(args.statsSnapshotSec * 1000);
      }

      tick += 1;
      if (shouldContinue()) await sleep(Math.round(args.intervalSec * 1000));
    }

    stats.completed_at = new Date().toISOString();
    const statsFiles = [];
    for (const mid of visitedMarketIds) {
      const f = await writeStatsFile(mid, stats, args);
      if (f) statsFiles.push(f);
    }
    if (market?.id && !visitedMarketIds.has(String(market.id))) {
      const f = await writeStatsFile(market.id, stats, args);
      if (f) statsFiles.push(f);
    }

    if (statsFiles.length) {
      console.log(`statsFiles: ${JSON.stringify(statsFiles)}`);
    }

    await log(`[${tsLog()}] done marketId=${market?.id || args.marketId || 'N/A'} yesTokenId=${yesTokenId || 'N/A'} noTokenId=${noTokenId || 'N/A'} ticks=${args.ticks === 0 ? 'infinite' : args.ticks} change_count=${stats.change_count} nonzero_ratio=${stats.nonzero_ratio} max_abs_change=${stats.max_abs_change} statsFiles=${JSON.stringify(statsFiles)}`);
  } catch (err) {
    const msg = err?.message || String(err);
    console.error(`ERROR: ${msg}`);
    await log(`[${tsLog(started)}] fatal error=${JSON.stringify(msg)}`);
    process.exitCode = 1;
  }
}

main();
