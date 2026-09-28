#!/usr/bin/env node
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { buildRollingSlugCandidates } from '../core/rolling_market_selector.mjs';
import { parseTwapWindowSec } from '../core/research/strategy_evidence.mjs';
import { calculateRollingTwap, createScreenRun } from '../core/research/strategy_screen_storage.mjs';
import { subscribeChainlinkPriceReports } from '../core/research/external_btc_market_data.mjs';

const GAMMA = 'https://gamma-api.polymarket.com/markets';
const CLOB = 'https://clob.polymarket.com';
const OKX = 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT';
const arg = (name, fallback = '') => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return await response.json();
  } finally { clearTimeout(timeout); }
}

function best(levels, direction) {
  const values = (levels || []).map((row) => ({ price: Number(row?.price), size: Number(row?.size) })).filter((row) => row.price > 0 && row.size > 0);
  if (!values.length) return null;
  return values.sort((a, b) => direction === 'max' ? b.price - a.price : a.price - b.price)[0];
}

export function resolveBinaryTokens(market) {
  try {
    const outcomes = JSON.parse(market?.outcomes || '[]').map((value) => String(value).toLowerCase());
    const ids = JSON.parse(market?.clobTokenIds || '[]');
    const yesIndex = outcomes.indexOf('yes') >= 0 ? outcomes.indexOf('yes') : outcomes.indexOf('up');
    const noIndex = outcomes.indexOf('no') >= 0 ? outcomes.indexOf('no') : outcomes.indexOf('down');
    if (yesIndex < 0 || noIndex < 0 || (outcomes.includes('yes') !== outcomes.includes('no')) || (outcomes.includes('up') !== outcomes.includes('down'))) return null;
    const yes = ids[yesIndex];
    const no = ids[noIndex];
    return yes && no ? { yes, no } : null;
  } catch { return null; }
}

export function isFutureBinaryMarket(market, nowMs = Date.now()) {
  const endMs = Date.parse(market?.endDate || '');
  return !market?.closed
    && Number.isFinite(endMs)
    && endMs > Number(nowMs)
    && resolveBinaryTokens(market) !== null;
}

async function selectMarket(nowMs) {
  for (const slug of buildRollingSlugCandidates('btc-updown-5m', nowMs)) {
    const rows = await fetchJson(`${GAMMA}?slug=${encodeURIComponent(slug)}`);
    const market = (rows || []).find((row) => isFutureBinaryMarket(row, nowMs));
    if (market) return market;
  }
  return null;
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function main() {
  const durationSec = Number(arg('--durationSec', '1800'));
  const outputRoot = arg('--outputRoot', 'runs/strategy-screen');
  const runId = arg('--runId', `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-${randomBytes(4).toString('hex')}`);
  if (!(Number.isFinite(durationSec) && durationSec > 0)) throw new Error('invalid_duration_sec');
  const startedAt = new Date().toISOString();
  const run = await createScreenRun({ outputRoot, runId, nowMs: Date.parse(startedAt) });
  const reports = [];
  const streamErrors = [];
  const subscription = subscribeChainlinkPriceReports({
    onReport: (report) => reports.push(report),
    onError: (reason) => streamErrors.push({ ts: new Date().toISOString(), reason }),
  });
  const deadline = Date.now() + durationSec * 1000;
  let validRows = 0;
  let invalidRows = 0;
  let exitReason = 'duration_elapsed';
  try {
    while (Date.now() < deadline) {
      const capturedAt = new Date().toISOString();
      const row = { captured_at: capturedAt, valid: false, errors: [] };
      try {
        const market = await selectMarket(Date.now());
        if (!market) throw new Error('market_unavailable');
        const ids = resolveBinaryTokens(market);
        const twapWindowSec = parseTwapWindowSec(market.description);
        if (!twapWindowSec) row.errors.push('twap_window_unparseable');
        const [yesBook, noBook, okx] = await Promise.all([
          fetchJson(`${CLOB}/book?token_id=${encodeURIComponent(ids.yes)}`),
          fetchJson(`${CLOB}/book?token_id=${encodeURIComponent(ids.no)}`),
          fetchJson(OKX),
        ]);
        const yesBid = best(yesBook?.bids, 'max'); const yesAsk = best(yesBook?.asks, 'min');
        const noBid = best(noBook?.bids, 'max'); const noAsk = best(noBook?.asks, 'min');
        const spot = Number(okx?.data?.[0]?.last);
        const twap = twapWindowSec ? calculateRollingTwap({ reports, nowMs: Date.now(), windowSec: twapWindowSec, maxReportAgeSec: 10 }) : null;
        Object.assign(row, { market_id: market.id, event_start_time: market.eventStartTime, end_time: market.endDate, twap_window_sec: twapWindowSec, chainlink_twap: twap, chainlink_reports: reports.slice(-120), fee_schedule: market.feeSchedule || null, yes: { token_id: ids.yes, bid: yesBid, ask: yesAsk }, no: { token_id: ids.no, bid: noBid, ask: noAsk }, okx_spot: spot, rtds_errors: streamErrors.slice(-3) });
        if (!(yesBid && yesAsk && noBid && noAsk && Number.isFinite(spot) && Number.isFinite(twap))) row.errors.push('incomplete_snapshot');
        row.valid = row.errors.length === 0;
      } catch (error) { row.errors.push(String(error?.message || error)); }
      await appendFile(run.rawPath, `${JSON.stringify(row)}\n`, 'utf8');
      if (row.valid) validRows += 1; else invalidRows += 1;
      await sleep(Math.max(0, 1000 - (Date.now() % 1000)));
    }
  } catch (error) {
    exitReason = `collector_error:${error?.message || String(error)}`;
    throw error;
  } finally {
    subscription.close();
    const manifest = { schema_version: 1, run_id: run.runId, read_only: true, started_at: startedAt, ended_at: new Date().toISOString(), status: 'completed', exit_reason: exitReason, valid_rows: validRows, invalid_rows: invalidRows, raw_sha256: await sha256(run.rawPath) };
    const temp = join(run.runDir, 'manifest.final.json');
    await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await rename(temp, run.manifestPath);
  }
  console.log(JSON.stringify({ run_id: run.runId, run_dir: run.runDir, status: 'completed', valid_rows: validRows, invalid_rows: invalidRows }));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => { console.error(`ERROR: ${error?.message || String(error)}`); process.exit(1); });
}
