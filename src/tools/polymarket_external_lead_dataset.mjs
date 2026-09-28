#!/usr/bin/env node

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

function getArg(argv, key, fallback = '') {
  const i = argv.indexOf(key);
  return i === -1 ? fallback : argv[i + 1];
}

function nowIso() { return new Date().toISOString(); }

async function log(line) {
  await mkdir('logs', { recursive: true });
  await appendFile('logs/polymarket_pipeline.log', `[${nowIso()}] ${line}\n`, 'utf8');
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length <= 1) return [];
  const header = lines[0].split(',');
  return lines.slice(1).filter(Boolean).map((line) => {
    const cols = line.split(',');
    const o = {};
    header.forEach((h, i) => { o[h] = cols[i] ?? ''; });
    return o;
  });
}

function toCsv(rows, header) {
  const lines = [header.join(',')];
  for (const r of rows) lines.push(header.map((h) => r[h] ?? '').join(','));
  return lines.join('\n') + '\n';
}

function floorSecIso(iso) {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

function okxHistoryCandles({ instId, limit = 300, after = '' }) {
  const base = `https://www.okx.com/api/v5/market/history-candles?instId=${encodeURIComponent(instId)}&bar=1s&limit=${limit}`;
  const url = after ? `${base}&after=${after}` : base;
  const out = execFileSync('curl', ['-s', url], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const obj = JSON.parse(out);
  if (obj.code !== '0') throw new Error(`OKX error code=${obj.code} msg=${obj.msg}`);
  return obj.data || [];
}

function computeReturn(curr, prev) {
  if (!Number.isFinite(curr) || !Number.isFinite(prev) || prev === 0) return '';
  return ((curr - prev) / prev).toFixed(8);
}

async function main() {
  const argv = process.argv.slice(2);
  const snapshots = getArg(argv, '--snapshots');
  const out = getArg(argv, '--out', 'data/snapshots_external_lead.csv');
  const instId = getArg(argv, '--instId', 'BTC-USDT');

  if (!snapshots) throw new Error('Require --snapshots <csv>');

  const rows = parseCsv(await readFile(snapshots, 'utf8'))
    .map((r) => ({
      snapshot_ts: r.snapshot_ts,
      marketId: r.marketId,
      yes_price: Number(r.yes_price),
      no_price: Number(r.no_price),
    }))
    .filter((r) => r.snapshot_ts && Number.isFinite(r.yes_price) && Number.isFinite(r.no_price))
    .sort((a, b) => new Date(a.snapshot_ts) - new Date(b.snapshot_ts));

  if (!rows.length) throw new Error('No valid snapshot rows');

  const startMs = new Date(rows[0].snapshot_ts).getTime() - 6000;
  const endMs = new Date(rows[rows.length - 1].snapshot_ts).getTime() + 1000;

  const secMap = new Map(); // iso->price

  let after = '';
  let guard = 0;
  while (guard < 500) {
    guard += 1;
    const batch = okxHistoryCandles({ instId, limit: 300, after });
    if (!batch.length) break;

    // batch descending by timestamp
    for (const c of batch) {
      const tsMs = Number(c[0]);
      const close = Number(c[4]);
      if (!Number.isFinite(tsMs) || !Number.isFinite(close)) continue;
      if (tsMs >= startMs && tsMs <= endMs) {
        secMap.set(new Date(tsMs).toISOString(), close);
      }
    }

    const oldestMs = Number(batch[batch.length - 1][0]);
    if (!Number.isFinite(oldestMs)) break;
    if (oldestMs < startMs) break;
    after = String(oldestMs);
  }

  if (!secMap.size) throw new Error('No external BTC candles fetched for range');

  // Build continuous sec timeline with carry-forward
  const timeline = new Map();
  let last = null;
  for (let t = Math.floor(startMs / 1000) * 1000; t <= endMs; t += 1000) {
    const iso = new Date(t).toISOString();
    const v = secMap.has(iso) ? secMap.get(iso) : last;
    if (Number.isFinite(v)) {
      timeline.set(iso, v);
      last = v;
    }
  }

  const aligned = [];
  for (const r of rows) {
    const ts = floorSecIso(r.snapshot_ts);
    if (!ts) continue;
    const btc = timeline.get(ts);
    if (!Number.isFinite(btc)) continue;

    const p1 = timeline.get(new Date(new Date(ts).getTime() - 1000).toISOString());
    const p2 = timeline.get(new Date(new Date(ts).getTime() - 2000).toISOString());
    const p3 = timeline.get(new Date(new Date(ts).getTime() - 3000).toISOString());
    const p4 = timeline.get(new Date(new Date(ts).getTime() - 4000).toISOString());
    const p5 = timeline.get(new Date(new Date(ts).getTime() - 5000).toISOString());
    const p10 = timeline.get(new Date(new Date(ts).getTime() - 10000).toISOString());

    const spreadYesProxy = Math.abs(1 - (r.yes_price + r.no_price));

    aligned.push({
      snapshot_ts: ts,
      marketId: r.marketId,
      yes_price: r.yes_price,
      no_price: r.no_price,
      spread_yes: spreadYesProxy.toFixed(6),
      btc_price: btc.toFixed(2),
      btc_return_1s: computeReturn(btc, p1),
      btc_return_2s: computeReturn(btc, p2),
      btc_return_3s: computeReturn(btc, p3),
      btc_return_4s: computeReturn(btc, p4),
      btc_return_5s: computeReturn(btc, p5),
      btc_return_10s: computeReturn(btc, p10),
    });
  }

  await mkdir('data', { recursive: true });
  await writeFile(out, toCsv(aligned, ['snapshot_ts', 'marketId', 'yes_price', 'no_price', 'spread_yes', 'btc_price', 'btc_return_1s', 'btc_return_2s', 'btc_return_3s', 'btc_return_4s', 'btc_return_5s', 'btc_return_10s']), 'utf8');

  console.log(`input_snapshots: ${rows.length}`);
  console.log(`okx_points_raw: ${secMap.size}`);
  console.log(`aligned_rows: ${aligned.length}`);
  console.log(`out: ${out}`);

  await log(`external_lead_dataset instId=${instId} snapshots=${rows.length} okxPoints=${secMap.size} aligned=${aligned.length} out=${out}`);
}

main().catch(async (err) => {
  console.error(`ERROR: ${err.message || String(err)}`);
  await log(`external_lead_dataset error=${JSON.stringify(err.message || String(err))}`);
  process.exit(1);
});
