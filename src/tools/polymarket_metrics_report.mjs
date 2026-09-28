#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'node:fs/promises';

function getArg(argv, key, fallback = '') {
  const i = argv.indexOf(key);
  return i === -1 ? fallback : argv[i + 1];
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

function maxDrawdown(equitySeries) {
  let peak = -Infinity;
  let mdd = 0;
  for (const x of equitySeries) {
    if (x > peak) peak = x;
    const dd = peak > 0 ? (peak - x) / peak : 0;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}

async function main() {
  const argv = process.argv.slice(2);
  const intentsPath = getArg(argv, '--intents');
  const tradesPath = getArg(argv, '--trades');
  const outEquity = getArg(argv, '--outEquity', 'data/equity_curve.csv');

  if (!intentsPath || !tradesPath) {
    throw new Error('Require --intents <csv> and --trades <csv>');
  }

  const intents = parseCsv(await readFile(intentsPath, 'utf8'));
  const trades = parseCsv(await readFile(tradesPath, 'utf8'));

  const equitySeries = intents
    .map((r) => Number(r.equity))
    .filter((x) => Number.isFinite(x));

  const closePnls = [];
  let prevRealized = 0;
  for (const t of trades) {
    const realized = Number(t.realizedPnl);
    if (!Number.isFinite(realized)) continue;
    if (t.action === 'close') {
      closePnls.push(realized - prevRealized);
    }
    prevRealized = realized;
  }

  const closedCount = closePnls.length;
  const winCount = closePnls.filter((x) => x > 0).length;
  const winRate = closedCount ? winCount / closedCount : 0;
  const avgPnlPerTrade = closedCount ? closePnls.reduce((a, b) => a + b, 0) / closedCount : 0;

  // avg hold time: open -> close duration (seconds)
  let currentOpenTs = null;
  const holdSecs = [];
  for (const t of trades) {
    if (t.action === 'open' && !currentOpenTs) currentOpenTs = new Date(t.ts).getTime();
    if (t.action === 'close' && currentOpenTs) {
      const endTs = new Date(t.ts).getTime();
      if (Number.isFinite(endTs) && endTs >= currentOpenTs) {
        holdSecs.push((endTs - currentOpenTs) / 1000);
      }
      currentOpenTs = null;
    }
  }
  const avgHoldTime = holdSecs.length ? holdSecs.reduce((a, b) => a + b, 0) / holdSecs.length : 0;

  const turnover = trades.reduce((sum, t) => {
    const size = Number(t.size);
    const price = Number(t.price);
    if (!Number.isFinite(size) || !Number.isFinite(price)) return sum;
    return sum + Math.abs(size * price);
  }, 0);

  const mdd = equitySeries.length ? maxDrawdown(equitySeries) : 0;

  // equity curve csv (per snapshot)
  const equityCurveRows = [];
  let peak = -Infinity;
  for (const r of intents) {
    const eq = Number(r.equity);
    if (!Number.isFinite(eq)) continue;
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    equityCurveRows.push({ ts: r.ts, equity: eq.toFixed(6), drawdown: dd.toFixed(6) });
  }
  await mkdir('data', { recursive: true });
  await writeFile(outEquity, toCsv(equityCurveRows, ['ts', 'equity', 'drawdown']), 'utf8');

  console.log(`trades_count: ${trades.length}`);
  console.log(`closed_trades_count: ${closedCount}`);
  console.log(`win_rate: ${winRate.toFixed(4)}`);
  console.log(`avg_pnl_per_trade: ${avgPnlPerTrade.toFixed(6)}`);
  console.log(`max_drawdown: ${mdd.toFixed(6)}`);
  console.log(`avg_hold_time_sec: ${avgHoldTime.toFixed(2)}`);
  console.log(`turnover: ${turnover.toFixed(6)}`);
  console.log(`out_equity_curve: ${outEquity}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message || String(err)}`);
  process.exit(1);
});
