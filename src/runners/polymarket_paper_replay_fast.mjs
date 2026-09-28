#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';

function getArg(key, fallback = '') {
  const i = process.argv.indexOf(key);
  return i === -1 ? fallback : process.argv[i + 1];
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

function mark(snapshot, outcome) {
  return outcome === 'yes' ? snapshot.yes : snapshot.no;
}

async function main() {
  const snapshotsPath = getArg('--snapshots');
  const ticks = Number(getArg('--ticks', '7200'));
  const windowSec = Number(getArg('--window', '3'));
  const entryTh = Number(getArg('--entryTh', '0.0003'));
  const gate = Number(getArg('--gate', '0.00015'));
  const baseSize = Number(getArg('--baseSize', '1'));
  const scaleFactor = Number(getArg('--scaleFactor', '0.0003'));
  const maxPosition = Number(getArg('--maxPosition', '4'));
  const feeRate = Number(getArg('--feeRate', '0.001'));
  const slippageBps = Number(getArg('--slippageBps', '1'));
  const outLog = getArg('--outLog', 'data/paper_trading_log.csv');
  const outSummary = getArg('--outSummary', 'data/paper_trading_summary.json');

  if (!snapshotsPath) throw new Error('Require --snapshots');
  if (![1,2,3,4,5].includes(windowSec)) throw new Error('window must be 1..5');

  const rows = parseCsv(await readFile(snapshotsPath, 'utf8')).map((r) => ({
    ts: r.snapshot_ts,
    btc: Number(r.btc_price),
    yes: Number(r.yes_price),
    no: Number(r.no_price),
    r1: Number(r.btc_return_1s),
    rk: Number(r[`btc_return_${windowSec}s`]),
  })).filter((r) => r.ts && Number.isFinite(r.yes) && Number.isFinite(r.no));

  if (!rows.length) throw new Error('No valid snapshot rows');

  let cash = 1000;
  let realizedPnl = 0;
  let position = null; // {outcome, qty, avgPrice}
  let peakEquity = 1000;
  let maxDrawdown = 0;
  let tradesCount = 0;
  let winCount = 0;

  const slip = slippageBps / 10000;
  const outRows = [];

  function calcUnrealized(s) {
    if (!position) return 0;
    return (mark(s, position.outcome) - position.avgPrice) * position.qty;
  }
  function calcEquity(s) {
    return cash + (position ? mark(s, position.outcome) * position.qty : 0);
  }

  for (let i = 0; i < ticks; i++) {
    const s = rows[i % rows.length];

    let signal = 'hold';
    if (Number.isFinite(s.rk) && Number.isFinite(s.r1)) {
      if (s.rk > entryTh && Math.abs(s.r1) > gate) signal = 'buy_yes';
      else if (s.rk < -entryTh && Math.abs(s.r1) > gate) signal = 'buy_no';
    }

    let tradeAction = 'none';
    let tradeSize = 0;

    const closePosition = (reason = 'close') => {
      if (!position) return;
      const px = mark(s, position.outcome) * (1 - slip);
      const notional = px * position.qty;
      const fee = notional * feeRate;
      const pnl = (px - position.avgPrice) * position.qty - fee;
      cash += notional - fee;
      realizedPnl += pnl;
      tradesCount += 1;
      if (pnl > 0) winCount += 1;
      tradeAction = reason;
      tradeSize = position.qty;
      position = null;
    };

    if (signal !== 'hold') {
      const target = signal === 'buy_yes' ? 'yes' : 'no';

      if (position && position.outcome !== target) {
        // flip = close_only
        closePosition('close_flip');
      } else if (!position) {
        // noPyramid + singleTradePerTick
        let qty = baseSize * (Math.abs(s.rk) / scaleFactor);
        qty = Math.min(qty, maxPosition);

        const px = mark(s, target) * (1 + slip);
        const notional = px * qty;
        const fee = notional * feeRate;

        cash -= (notional + fee);
        realizedPnl -= fee;
        position = { outcome: target, qty, avgPrice: px };
        tradesCount += 1;
        tradeAction = `open_${target}`;
        tradeSize = qty;
      }
    }

    const unrealizedPnl = calcUnrealized(s);
    const equity = calcEquity(s);
    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;

    const posTxt = position ? `${position.outcome}:${position.qty.toFixed(6)}@${position.avgPrice.toFixed(6)}` : 'flat';

    outRows.push({
      ts: s.ts,
      btc_price: Number.isFinite(s.btc) ? s.btc.toFixed(2) : '',
      yes_price: s.yes.toFixed(6),
      no_price: s.no.toFixed(6),
      signal,
      trade_action: tradeAction,
      trade_size: tradeSize ? tradeSize.toFixed(6) : '0',
      position: posTxt,
      cash: cash.toFixed(6),
      equity: equity.toFixed(6),
      realizedPnl: realizedPnl.toFixed(6),
      unrealizedPnl: unrealizedPnl.toFixed(6),
    });
  }

  // force close at end
  if (position) {
    const s = rows[(ticks - 1) % rows.length];
    const px = mark(s, position.outcome) * (1 - slip);
    const notional = px * position.qty;
    const fee = notional * feeRate;
    const pnl = (px - position.avgPrice) * position.qty - fee;
    cash += notional - fee;
    realizedPnl += pnl;
    tradesCount += 1;
    if (pnl > 0) winCount += 1;
    position = null;
  }

  await mkdir('data', { recursive: true });
  await writeFile(outLog, toCsv(outRows, ['ts','btc_price','yes_price','no_price','signal','trade_action','trade_size','position','cash','equity','realizedPnl','unrealizedPnl']), 'utf8');

  const summary = {
    ticks,
    trades_count: tradesCount,
    win_rate: Number((tradesCount ? (winCount / tradesCount) : 0).toFixed(4)),
    final_equity: Number(cash.toFixed(6)),
    max_drawdown: Number(maxDrawdown.toFixed(6)),
  };
  await writeFile(outSummary, JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(`ERROR: ${e.message || String(e)}`); process.exit(1); });
