#!/usr/bin/env node

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';

function getArg(argv, key, fallback = '') {
  const i = argv.indexOf(key);
  return i === -1 ? fallback : argv[i + 1];
}

function ts() {
  return new Date().toISOString();
}

async function log(line) {
  await mkdir('logs', { recursive: true });
  await appendFile('logs/polymarket_pipeline.log', `[${ts()}] ${line}\n`, 'utf8');
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const rows = lines.slice(1).filter(Boolean).map((line) => {
    const cols = line.split(',');
    const obj = {};
    header.forEach((h, idx) => { obj[h] = cols[idx] ?? ''; });
    return obj;
  });
  return { header, rows };
}

function toCsv(rows, header) {
  const lines = [header.join(',')];
  for (const r of rows) lines.push(header.map((h) => r[h] ?? '').join(','));
  return lines.join('\n') + '\n';
}

function floorToWindowMs(iso, windowSec) {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  const w = windowSec * 1000;
  return new Date(Math.floor(ms / w) * w).toISOString();
}

async function main() {
  const argv = process.argv.slice(2);
  const marketId = getArg(argv, '--marketId');
  const endpoint = getArg(argv, '--endpoint', 'midpoint');
  const side = getArg(argv, '--side', 'buy');
  const sourceCombined = getArg(argv, '--sourceCombined', '');
  const windowSec = Number(getArg(argv, '--windowSec', '1'));
  const outTicks = getArg(argv, '--outTicks', marketId ? `data/ticks_${marketId}.csv` : 'data/ticks.csv');
  const outSnapshots = getArg(argv, '--outSnapshots', marketId ? `data/snapshots_${marketId}.csv` : 'data/snapshots.csv');

  if (!marketId) throw new Error('Require --marketId');
  if (!sourceCombined) throw new Error('Require --sourceCombined <combined csv path>');
  if (!Number.isFinite(windowSec) || windowSec <= 0) throw new Error('Invalid --windowSec');

  const raw = await readFile(sourceCombined, 'utf8');
  const { rows } = parseCsv(raw);
  if (!rows.length) throw new Error('sourceCombined has no rows');

  // Unified ticks schema + dedupe (same ts+outcome+token keep last)
  const dedup = new Map();
  for (const r of rows) {
    const timestamp = r.timestamp;
    const outcome = String(r.outcome || '').toLowerCase();
    const tokenId = r.tokenId;
    const price = Number(r.price);
    if (!timestamp || !tokenId || !['yes', 'no'].includes(outcome) || !Number.isFinite(price)) continue;

    const key = `${timestamp}|${outcome}|${tokenId}`;
    dedup.set(key, {
      timestamp,
      marketId: String(marketId),
      outcome,
      tokenId,
      endpoint,
      side,
      price: String(price),
    });
  }

  const ticks = [...dedup.values()].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // Snapshot aggregation
  const bucket = new Map();
  for (const t of ticks) {
    const k = floorToWindowMs(t.timestamp, windowSec);
    if (!k) continue;
    const rec = bucket.get(k) || { snapshot_ts: k, marketId: String(marketId), yes_price: '', no_price: '' };
    if (t.outcome === 'yes') rec.yes_price = t.price;
    if (t.outcome === 'no') rec.no_price = t.price;
    bucket.set(k, rec);
  }

  // carry-forward snapshot aggregation
  const ordered = [...bucket.values()].sort((a, b) => new Date(a.snapshot_ts).getTime() - new Date(b.snapshot_ts).getTime());
  const snapshots = [];
  let lastYes = null;
  let lastNo = null;

  for (const r of ordered) {
    if (r.yes_price !== '') lastYes = Number(r.yes_price);
    if (r.no_price !== '') lastNo = Number(r.no_price);

    if (lastYes !== null && lastNo !== null) {
      snapshots.push({
        snapshot_ts: r.snapshot_ts,
        marketId: r.marketId,
        yes_price: String(lastYes),
        no_price: String(lastNo),
      });
    }
  }

  await mkdir('data', { recursive: true });
  await writeFile(outTicks, toCsv(ticks, ['timestamp', 'marketId', 'outcome', 'tokenId', 'endpoint', 'side', 'price']), 'utf8');
  await writeFile(outSnapshots, toCsv(snapshots, ['snapshot_ts', 'yes_price', 'no_price', 'marketId']), 'utf8');

  console.log(`ticks_rows: ${ticks.length}`);
  console.log(`snapshots_rows: ${snapshots.length}`);
  console.log(`out_ticks: ${outTicks}`);
  console.log(`out_snapshots: ${outSnapshots}`);

  await log(`build_dataset marketId=${marketId} source=${sourceCombined} ticks=${ticks.length} snapshots=${snapshots.length} outTicks=${outTicks} outSnapshots=${outSnapshots}`);
}

main().catch(async (err) => {
  console.error(`ERROR: ${err.message || String(err)}`);
  await log(`build_dataset error=${JSON.stringify(err.message || String(err))}`);
  process.exit(1);
});
