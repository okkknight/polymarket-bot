#!/usr/bin/env node

import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const API_URL = 'https://gamma-api.polymarket.com/markets';
const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const DEFAULT_LIMIT = 5;

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatTimestampForFile(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function formatTimestampForLog(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseLimitArg(argv) {
  const idx = argv.indexOf('--limit');
  if (idx === -1) return DEFAULT_LIMIT;

  const raw = argv[idx + 1];
  const val = Number(raw);
  if (!Number.isInteger(val) || val <= 0) {
    throw new Error(`Invalid --limit value: ${raw}`);
  }
  return val;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithRetry(url, timeoutMs, maxRetries) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const start = performance.now();
    try {
      const res = await fetchWithTimeout(url, timeoutMs);
      const elapsedMs = Math.round(performance.now() - start);

      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.httpStatus = res.status;
        err.elapsedMs = elapsedMs;
        throw err;
      }

      return { res, attempt, elapsedMs };
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries) break;

      const backoffMs = 500 * (2 ** (attempt - 1)); // 500, 1000
      await sleep(backoffMs);
    }
  }

  throw lastError;
}

async function logLine(line) {
  await mkdir('logs', { recursive: true });
  await appendFile('logs/polymarket_readonly.log', line + '\n', 'utf8');
}

function pickSummary(m) {
  return {
    id: m?.id ?? null,
    question: m?.question ?? null,
    slug: m?.slug ?? null,
    endDate: m?.endDate ?? null,
    category: m?.category ?? null,
    liquidity: m?.liquidity ?? null,
  };
}

async function main() {
  const startedAt = new Date();
  let statusCode = 'N/A';
  let elapsedMs = -1;
  let outFile = 'N/A';
  let marketCount = 0;

  try {
    const limit = parseLimitArg(process.argv.slice(2));

    await mkdir('data', { recursive: true });

    const { res, attempt, elapsedMs: ms } = await fetchWithRetry(API_URL, TIMEOUT_MS, MAX_RETRIES);
    statusCode = res.status;
    elapsedMs = ms;

    const data = await res.json();
    if (!Array.isArray(data)) {
      throw new Error('Response is not a JSON array');
    }

    marketCount = data.length;

    const stamp = formatTimestampForFile(new Date());
    outFile = `data/markets_${stamp}.json`;
    await writeFile(outFile, JSON.stringify(data, null, 2), 'utf8');

    console.log(`market_count: ${marketCount}`);
    console.log(`http_status: ${statusCode}`);
    console.log(`attempt: ${attempt}`);
    console.log(`saved_file: ${outFile}`);
    console.log('--- markets preview ---');

    const preview = data.slice(0, limit).map(pickSummary);
    preview.forEach((item, idx) => {
      console.log(`${idx + 1}. ${JSON.stringify(item)}`);
    });

    await logLine(
      `[${formatTimestampForLog(startedAt)}] status=${statusCode} elapsed_ms=${elapsedMs} saved_file=${outFile} market_count=${marketCount}`
    );
  } catch (err) {
    const msg = err?.name === 'AbortError'
      ? `Request timeout after ${TIMEOUT_MS}ms`
      : (err?.message || String(err));

    console.error(`ERROR: ${msg}`);

    await logLine(
      `[${formatTimestampForLog(startedAt)}] status=${statusCode} elapsed_ms=${elapsedMs} saved_file=${outFile} market_count=${marketCount} error=${JSON.stringify(msg)}`
    );

    process.exitCode = 1;
  }
}

main();
