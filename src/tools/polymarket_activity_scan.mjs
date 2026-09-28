#!/usr/bin/env node

import { mkdir, appendFile } from 'node:fs/promises';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';
const TIMEOUT_MS = 10_000;

function getArg(argv, key, fallback = '') {
  const i = argv.indexOf(key);
  return i === -1 ? fallback : argv[i + 1];
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchWithTimeout(url, timeoutMs = TIMEOUT_MS) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchJsonRetry(url, retries = 3) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${txt}`.trim());
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(300 * (2 ** (i - 1)));
    }
  }
  throw lastErr;
}

function parseJsonMaybe(v, fallback = null) {
  if (v == null) return fallback;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return fallback; }
  }
  return v;
}

function parseTokenIdsFromMarket(market) {
  const raw = market?.clobTokenIds;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  const arr = parseJsonMaybe(raw, []);
  return Array.isArray(arr) ? arr.map(String) : [];
}

function resolveYesNo(market) {
  const allTokenIds = parseTokenIdsFromMarket(market);
  let yesTokenId = null;
  let noTokenId = null;

  const tokens = parseJsonMaybe(market?.tokens, null);
  if (Array.isArray(tokens)) {
    for (const t of tokens) {
      const label = String(t?.outcome ?? t?.label ?? '').trim().toLowerCase();
      const tid = String(t?.tokenId ?? t?.id ?? '').trim();
      if (!tid) continue;
      if (label === 'yes') yesTokenId = tid;
      if (label === 'no') noTokenId = tid;
    }
  }

  if (!(yesTokenId && noTokenId)) {
    const outcomes = parseJsonMaybe(market?.outcomes, []);
    if (Array.isArray(outcomes) && outcomes.length && allTokenIds.length >= outcomes.length) {
      const yi = outcomes.findIndex((x) => String(x).trim().toLowerCase() === 'yes');
      const ni = outcomes.findIndex((x) => String(x).trim().toLowerCase() === 'no');
      if (yi >= 0) yesTokenId = yesTokenId || allTokenIds[yi];
      if (ni >= 0) noTokenId = noTokenId || allTokenIds[ni];
    }
  }

  if (!(yesTokenId && noTokenId) && allTokenIds.length >= 2) {
    yesTokenId = yesTokenId || allTokenIds[0];
    noTokenId = noTokenId || allTokenIds[1];
  }

  return { yesTokenId, noTokenId };
}

function calcTokenMetrics(samples) {
  if (samples.length < 2) return { change_count: 0, nonzero_ratio: 0, max_abs_change: 0 };
  let changeCount = 0;
  let maxAbs = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i] - samples[i - 1];
    if (d !== 0) changeCount += 1;
    const a = Math.abs(d);
    if (a > maxAbs) maxAbs = a;
  }
  return {
    change_count: changeCount,
    nonzero_ratio: changeCount / (samples.length - 1),
    max_abs_change: maxAbs,
  };
}

async function sampleMidpoint(tokenId, sampleSec, intervalSec) {
  const samples = [];
  const ticks = Math.max(1, Math.floor(sampleSec / intervalSec));

  for (let i = 0; i < ticks; i++) {
    try {
      const data = await fetchJsonRetry(`${CLOB_BASE}/midpoint?token_id=${encodeURIComponent(tokenId)}`);
      const v = Number(data?.midpoint ?? data?.price ?? data?.mid ?? data?.value);
      if (Number.isFinite(v)) samples.push(v);
    } catch {
      // skip failed tick
    }
    if (i < ticks - 1) await sleep(intervalSec * 1000);
  }
  return samples;
}

async function runPool(items, concurrency, fn) {
  const ret = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      ret[cur] = await fn(items[cur], cur);
    }
  });
  await Promise.all(workers);
  return ret;
}

async function log(line) {
  await mkdir('logs', { recursive: true });
  await appendFile('logs/polymarket_activity_scan.log', line + '\n', 'utf8');
}

function fmt(n, d = 4) { return Number.isFinite(n) ? n.toFixed(d) : '0'; }

async function main() {
  const argv = process.argv.slice(2);
  const topN = Number(getArg(argv, '--topN', '30'));
  const sampleSec = Number(getArg(argv, '--sampleSec', '30'));
  const intervalSec = Number(getArg(argv, '--intervalSec', '1'));
  const concurrency = Number(getArg(argv, '--concurrency', '10'));
  const sortBy = getArg(argv, '--sortBy', 'volume').toLowerCase(); // volume|liquidity

  const startedMs = Date.now();

  const markets = await fetchJsonRetry(`${GAMMA_BASE}/markets?active=true&closed=false&limit=200`);
  if (!Array.isArray(markets)) throw new Error('Invalid /markets response');

  const ranked = [...markets].sort((a, b) => {
    const av = Number(sortBy === 'liquidity' ? (a?.liquidity ?? 0) : (a?.volume ?? 0));
    const bv = Number(sortBy === 'liquidity' ? (b?.liquidity ?? 0) : (b?.volume ?? 0));
    return bv - av;
  }).slice(0, topN);

  const scanned = await runPool(ranked, concurrency, async (m) => {
    try {
      const detail = await fetchJsonRetry(`${GAMMA_BASE}/markets/${encodeURIComponent(String(m.id))}`);
      const { yesTokenId, noTokenId } = resolveYesNo(detail);
      if (!yesTokenId || !noTokenId) return null;

      const [yesSamples, noSamples] = await Promise.all([
        sampleMidpoint(yesTokenId, sampleSec, intervalSec),
        sampleMidpoint(noTokenId, sampleSec, intervalSec),
      ]);

      const ym = calcTokenMetrics(yesSamples);
      const nm = calcTokenMetrics(noSamples);

      const totalSteps = Math.max(0, yesSamples.length - 1) + Math.max(0, noSamples.length - 1);
      const totalChanges = ym.change_count + nm.change_count;
      const nonzeroRatio = totalSteps > 0 ? totalChanges / totalSteps : 0;

      return {
        marketId: String(m.id),
        question: m.question,
        endDate: m.endDate,
        liquidity: Number(m.liquidity ?? 0),
        volume: Number(m.volume ?? 0),
        yes_change_count: ym.change_count,
        no_change_count: nm.change_count,
        total_change_count: totalChanges,
        nonzero_ratio: nonzeroRatio,
        max_abs_change: Math.max(ym.max_abs_change, nm.max_abs_change),
      };
    } catch {
      return null;
    }
  });

  const rows = scanned.filter(Boolean).sort((a, b) => {
    if (b.total_change_count !== a.total_change_count) return b.total_change_count - a.total_change_count;
    if (b.nonzero_ratio !== a.nonzero_ratio) return b.nonzero_ratio - a.nonzero_ratio;
    return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
  });

  const top10 = rows.slice(0, 10);

  console.log('--- TOP 10 active markets (by total_change_count) ---');
  top10.forEach((r, i) => {
    console.log(`${i + 1}. marketId=${r.marketId} total_change_count=${r.total_change_count} nonzero_ratio=${fmt(r.nonzero_ratio)} max_abs_change=${fmt(r.max_abs_change,6)} endDate=${r.endDate} liquidity=${r.liquidity} volume=${r.volume} question=${r.question}`);
    console.log(`   yes_change_count=${r.yes_change_count} no_change_count=${r.no_change_count}`);
  });

  const recommended = [...rows]
    .sort((a, b) => {
      // priority: total_change_count high, nonzero high, endDate near
      const scoreA = a.total_change_count * 1000 + a.nonzero_ratio * 100;
      const scoreB = b.total_change_count * 1000 + b.nonzero_ratio * 100;
      if (scoreB !== scoreA) return scoreB - scoreA;
      return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
    })
    .slice(0, 3);

  console.log('--- RECOMMENDED 3 ---');
  recommended.forEach((r, i) => {
    console.log(`${i + 1}. ${r.marketId} total_change_count=${r.total_change_count} nonzero_ratio=${fmt(r.nonzero_ratio)} endDate=${r.endDate}`);
  });

  const elapsed = (Date.now() - startedMs) / 1000;
  console.log(`elapsed_sec: ${elapsed.toFixed(2)}`);

  await log(`${new Date().toISOString()} topN=${topN} sampleSec=${sampleSec} intervalSec=${intervalSec} concurrency=${concurrency} scanned=${rows.length} elapsedSec=${elapsed.toFixed(2)} recommended=${recommended.map(x => x.marketId).join(',')}`);
}

main().catch(async (err) => {
  console.error(`ERROR: ${err.message || String(err)}`);
  await log(`${new Date().toISOString()} error=${JSON.stringify(err.message || String(err))}`);
  process.exit(1);
});
