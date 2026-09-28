#!/usr/bin/env node

import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const API_BASE = 'https://gamma-api.polymarket.com/markets';
const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;

function pad(n) { return String(n).padStart(2, '0'); }
function tsFile(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function tsLog(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseBool(v, fallback) {
  if (v === undefined) return fallback;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`Invalid boolean value: ${v} (use true|false)`);
}

function getArg(argv, key, fallback) {
  const idx = argv.indexOf(key);
  if (idx === -1) return fallback;
  return argv[idx + 1];
}

function parseArgs(argv) {
  const q = getArg(argv, '--q', '').trim();
  const active = parseBool(getArg(argv, '--active'), true);
  const closed = parseBool(getArg(argv, '--closed'), false);
  const limitRaw = getArg(argv, '--limit', '50');
  const limit = Number(limitRaw);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid --limit: ${limitRaw}`);
  }
  return { q, active, closed, limit };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchWithRetry(url) {
  let lastErr;
  for (let i = 1; i <= MAX_RETRIES; i++) {
    const start = performance.now();
    try {
      const res = await fetchWithTimeout(url, TIMEOUT_MS);
      const elapsedMs = Math.round(performance.now() - start);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { httpStatus: res.status, elapsedMs });
      return { res, elapsedMs, attempt: i };
    } catch (err) {
      lastErr = err;
      if (i < MAX_RETRIES) await sleep(500 * (2 ** (i - 1)));
    }
  }
  throw lastErr;
}

async function log(line) {
  await mkdir('logs', { recursive: true });
  await appendFile('logs/polymarket_market_finder.log', line + '\n', 'utf8');
}

function summary(m) {
  return {
    id: m?.id ?? null,
    question: m?.question ?? null,
    slug: m?.slug ?? null,
    endDate: m?.endDate ?? null,
    category: m?.category ?? null,
    liquidity: m?.liquidity ?? m?.liquidityNum ?? null,
    volume: m?.volume ?? m?.volumeNum ?? null,
  };
}

async function main() {
  const started = new Date();
  let status = 'N/A';
  let elapsed = -1;
  let file = 'N/A';
  let total = 0;
  let matched = 0;

  try {
    const args = parseArgs(process.argv.slice(2));
    const url = `${API_BASE}?active=${args.active}&closed=${args.closed}&limit=${args.limit}`;

    const { res, elapsedMs, attempt } = await fetchWithRetry(url);
    status = res.status;
    elapsed = elapsedMs;

    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Response is not a JSON array');
    total = data.length;

    await mkdir('data', { recursive: true });
    file = `data/markets_active_${tsFile()}.json`;
    await writeFile(file, JSON.stringify(data, null, 2), 'utf8');

    const needle = args.q.toLowerCase();
    const filtered = needle
      ? data.filter(m => (`${m?.question ?? ''} ${m?.slug ?? ''}`).toLowerCase().includes(needle))
      : data;
    matched = filtered.length;

    console.log(`http_status: ${status}`);
    console.log(`attempt: ${attempt}`);
    console.log(`request_url: ${url}`);
    console.log(`total_markets: ${total}`);
    console.log(`matched_markets: ${matched}`);
    console.log(`saved_file: ${file}`);
    console.log('--- top candidates (max 10) ---');
    filtered.slice(0, 10).forEach((m, i) => {
      console.log(`${i + 1}. ${JSON.stringify(summary(m))}`);
    });

    await log(`[${tsLog(started)}] status=${status} elapsed_ms=${elapsed} saved_file=${file} total=${total} matched=${matched} q=${JSON.stringify(args.q)} active=${args.active} closed=${args.closed} limit=${args.limit}`);
  } catch (err) {
    const msg = err?.name === 'AbortError' ? `Request timeout after ${TIMEOUT_MS}ms` : (err?.message || String(err));
    console.error(`ERROR: ${msg}`);
    await log(`[${tsLog(started)}] status=${status} elapsed_ms=${elapsed} saved_file=${file} total=${total} matched=${matched} error=${JSON.stringify(msg)}`);
    process.exitCode = 1;
  }
}

main();
