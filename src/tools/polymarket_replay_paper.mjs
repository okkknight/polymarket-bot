#!/usr/bin/env node

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';

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

class Strategy {
  // interface
  onSnapshot(_ctx) { return { action: 'hold', size: 0, reason: 'base' }; }
}

class MeanMomentumStrategy extends Strategy {
  constructor({ lookback = 5, threshold = 0.01, size = 1 } = {}) {
    super();
    this.lookback = lookback;
    this.threshold = threshold;
    this.size = size;
  }

  onSnapshot(ctx) {
    const hist = ctx.history;
    if (hist.length < this.lookback) {
      return { action: 'hold', size: 0, reason: `warmup(${hist.length}/${this.lookback})` };
    }

    const recent = hist.slice(-this.lookback);
    const avgYes = recent.reduce((s, x) => s + x.yes, 0) / recent.length;
    const momentum = ctx.current.yes - avgYes;

    if (momentum > this.threshold) {
      return { action: 'buy_no', size: this.size, reason: `mean_reversion_up=${momentum.toFixed(4)} > ${this.threshold}` };
    }
    if (momentum < -this.threshold) {
      return { action: 'buy_yes', size: this.size, reason: `mean_reversion_down=${momentum.toFixed(4)} < -${this.threshold}` };
    }

    return { action: 'hold', size: 0, reason: `flat=${momentum.toFixed(4)}` };
  }
}

class ExternalPriceLeadStrategy extends Strategy {
  constructor({ threshold = 0.0005, size = 1, windowSec = 3, momentumFilter = 0, spreadGate = 0, impulseGate = 0, moveGate = 0, scaleFactor = 0, maxPosition = 0 } = {}) {
    super();
    this.threshold = threshold;
    this.size = size;
    this.windowSec = windowSec;
    this.momentumFilter = momentumFilter;
    this.spreadGate = spreadGate;
    this.impulseGate = impulseGate;
    this.moveGate = moveGate;
    this.scaleFactor = scaleFactor;
    this.maxPosition = maxPosition;
  }

  onSnapshot(ctx) {
    const key = `btc_return_${this.windowSec}s`;
    const r = Number(ctx.current[key]);
    const r1 = Number(ctx.current.btc_return_1s);
    const r10 = Number(ctx.current.btc_return_10s);
    const spreadYes = Number(ctx.current.spread_yes);
    if (!Number.isFinite(r)) {
      return { action: 'hold', size: 0, reason: `warmup_external(${key})` };
    }
    if (this.momentumFilter > 0 && !Number.isFinite(r10)) {
      return { action: 'hold', size: 0, reason: 'warmup_external(btc_return_10s)' };
    }
    if (this.spreadGate > 0 && !Number.isFinite(spreadYes)) {
      return { action: 'hold', size: 0, reason: 'warmup_external(spread_yes)' };
    }
    if (this.impulseGate > 0 && !Number.isFinite(r1)) {
      return { action: 'hold', size: 0, reason: 'warmup_external(btc_return_1s)' };
    }

    const momentumPassUp = this.momentumFilter <= 0 || r10 > this.momentumFilter;
    const momentumPassDown = this.momentumFilter <= 0 || r10 < -this.momentumFilter;
    const spreadPass = this.spreadGate <= 0 || spreadYes < this.spreadGate;
    const impulsePass = this.impulseGate <= 0 || Math.abs(r1) > this.impulseGate;
    const movePass = this.moveGate <= 0 || Math.abs(r) > this.moveGate;

    let dynSize = this.scaleFactor > 0
      ? this.size * (Math.abs(r) / this.scaleFactor)
      : this.size;
    if (this.maxPosition > 0) {
      dynSize = Math.min(dynSize, this.maxPosition);
    }

    if (r > this.threshold && momentumPassUp && spreadPass && impulsePass && movePass) {
      return { action: 'buy_yes', size: dynSize, reason: `external_up=${r.toFixed(6)} r1=${Number.isFinite(r1)?r1.toFixed(6):'na'} th=${this.threshold} ig=${this.impulseGate} mg=${this.moveGate} sf=${this.scaleFactor}` };
    }
    if (r < -this.threshold && momentumPassDown && spreadPass && impulsePass && movePass) {
      return { action: 'buy_no', size: dynSize, reason: `external_down=${r.toFixed(6)} r1=${Number.isFinite(r1)?r1.toFixed(6):'na'} th=${this.threshold} ig=${this.impulseGate} mg=${this.moveGate} sf=${this.scaleFactor}` };
    }
    return { action: 'hold', size: 0, reason: `external_flat=${r.toFixed(6)} r1=${Number.isFinite(r1)?r1.toFixed(6):'na'} mg=${this.moveGate}` };
  }
}

function markPriceForOutcome(snapshot, outcome) {
  return outcome === 'yes' ? snapshot.yes : snapshot.no;
}

function calcPositionMarketValue(position, snapshot) {
  if (!position) return 0;
  const mark = markPriceForOutcome(snapshot, position.outcome);
  return mark * position.qty;
}

function calcUnrealized(position, snapshot) {
  if (!position) return 0;
  const mark = markPriceForOutcome(snapshot, position.outcome);
  return (mark - position.avgPrice) * position.qty;
}

function calcEquity(state, snapshot) {
  return state.cash + calcPositionMarketValue(state.position, snapshot);
}

function computeMomentum(history, current, lookback) {
  if (history.length < lookback) return null;
  const recent = history.slice(-lookback);
  const avgYes = recent.reduce((s, x) => s + x.yes, 0) / recent.length;
  return current.yes - avgYes;
}

function formatPosition(position) {
  if (!position) return 'flat';
  return `${position.outcome}:${position.qty}@${Number(position.avgPrice).toFixed(6)}`;
}

function executeIntent(state, intent, snapshot, costs, constraints = {}) {
  // state: {cash, position|null, realizedPnL}
  const trades = [];
  const ts = snapshot.ts;
  const slip = (costs?.slippageBps || 0) / 10000;
  const feeRate = costs?.feeRate || 0;
  const singleTradePerTick = constraints?.singleTradePerTick === true;
  const noPyramid = constraints?.noPyramid === true;
  const flipMode = constraints?.flip || 'close_open'; // close_open | close_only

  function closePosition(reason = 'switch') {
    if (!state.position) return false;
    const mark = markPriceForOutcome(snapshot, state.position.outcome);
    const px = mark * (1 - slip);
    const notional = px * state.position.qty;
    const fee = notional * feeRate;
    const pnl = (px - state.position.avgPrice) * state.position.qty - fee;
    state.cash += notional - fee;
    state.realizedPnL += pnl;
    trades.push({ ts, action: 'close', outcome: state.position.outcome, size: state.position.qty, price: px, fee, reason });
    state.position = null;
    return true;
  }

  if (intent.action === 'hold' || intent.size <= 0) return trades;

  const targetOutcome = intent.action === 'buy_yes' ? 'yes' : intent.action === 'buy_no' ? 'no' : null;
  if (!targetOutcome) return trades;

  // flip handling
  if (state.position && state.position.outcome !== targetOutcome) {
    const closed = closePosition('flip_outcome');
    if (closed && (singleTradePerTick || flipMode === 'close_only')) {
      return trades; // stop here this tick
    }
  }

  // no pyramid: if same direction position exists, skip opening more
  if (noPyramid && state.position && state.position.outcome === targetOutcome) {
    return trades;
  }

  const mark = markPriceForOutcome(snapshot, targetOutcome);
  const px = mark * (1 + slip);
  const qty = intent.size;
  const notional = px * qty;
  const fee = notional * feeRate;

  if (!state.position) {
    state.position = { outcome: targetOutcome, qty, avgPrice: px };
  } else {
    const newQty = state.position.qty + qty;
    const newAvg = (state.position.avgPrice * state.position.qty + px * qty) / newQty;
    state.position.qty = newQty;
    state.position.avgPrice = newAvg;
  }

  state.cash -= (notional + fee);
  state.realizedPnL -= fee;
  trades.push({ ts, action: 'open', outcome: targetOutcome, size: qty, price: px, fee, reason: intent.reason });

  return trades;
}

async function main() {
  const argv = process.argv.slice(2);
  const snapshotsPath = getArg(argv, '--snapshots');
  const marketId = getArg(argv, '--marketId', 'unknown');
  const strategyName = getArg(argv, '--strategy', 'mean_reversion');
  const lookback = Number(getArg(argv, '--lookback', '5'));
  const externalWindowSec = Number(getArg(argv, '--externalWindowSec', '3'));
  const momentumFilter = Number(getArg(argv, '--momentumFilter', '0'));
  const spreadGate = Number(getArg(argv, '--spreadGate', '0'));
  const impulseGate = Number(getArg(argv, '--impulseGate', '0'));
  const moveGate = Number(getArg(argv, '--moveGate', '0'));
  const scaleFactor = Number(getArg(argv, '--scaleFactor', '0'));
  const maxPosition = Number(getArg(argv, '--maxPosition', '0'));
  const threshold = Number(getArg(argv, '--threshold', '0.01'));
  const size = Number(getArg(argv, '--size', '1'));
  const initialCash = Number(getArg(argv, '--initialCash', '1000'));
  const cooldownSec = Number(getArg(argv, '--cooldownSec', '0'));
  const closeOnEnd = getArg(argv, '--closeOnEnd', 'true').toLowerCase() !== 'false';
  const feeRate = Number(getArg(argv, '--feeRate', '0'));
  const slippageBps = Number(getArg(argv, '--slippageBps', '0'));
  const singleTradePerTick = getArg(argv, '--singleTradePerTick', 'false').toLowerCase() === 'true';
  const noPyramid = getArg(argv, '--noPyramid', 'false').toLowerCase() === 'true';
  const flip = getArg(argv, '--flip', 'close_open');
  const outTrades = getArg(argv, '--outTrades', `data/trades_paper_${marketId}.csv`);
  const outPosition = getArg(argv, '--outPosition', `data/position_${marketId}.json`);
  const outIntents = getArg(argv, '--outIntents', `data/intents_${marketId}.csv`);

  if (!snapshotsPath) throw new Error('Require --snapshots <csv>');
  if (!['mean_reversion', 'external_price_lead'].includes(strategyName)) throw new Error('Invalid --strategy (mean_reversion|external_price_lead)');
  if (!Number.isFinite(cooldownSec) || cooldownSec < 0) throw new Error('Invalid --cooldownSec');
  if (!Number.isFinite(feeRate) || feeRate < 0) throw new Error('Invalid --feeRate');
  if (!Number.isFinite(slippageBps) || slippageBps < 0) throw new Error('Invalid --slippageBps');
  if (!['close_open', 'close_only'].includes(flip)) throw new Error('Invalid --flip (close_open|close_only)');
  if (![1, 2, 3, 4, 5].includes(externalWindowSec)) throw new Error('Invalid --externalWindowSec (1|2|3|4|5)');

  const rows = parseCsv(await readFile(snapshotsPath, 'utf8'))
    .map((r) => ({
      ts: r.snapshot_ts,
      marketId: r.marketId || marketId,
      yes: Number(r.yes_price),
      no: Number(r.no_price),
      btc_price: Number(r.btc_price),
      spread_yes: Number(r.spread_yes),
      btc_return_1s: Number(r.btc_return_1s),
      btc_return_2s: Number(r.btc_return_2s),
      btc_return_3s: Number(r.btc_return_3s),
      btc_return_4s: Number(r.btc_return_4s),
      btc_return_5s: Number(r.btc_return_5s),
      btc_return_10s: Number(r.btc_return_10s),
    }))
    .filter((r) => r.ts && Number.isFinite(r.yes) && Number.isFinite(r.no))
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));

  if (!rows.length) throw new Error('No valid snapshot rows');

  // Pre-scan signal distribution for explainability / threshold suggestion
  const signalSeries = [];
  const preHistory = [];
  for (const snap of rows) {
    let s = null;
    if (strategyName === 'mean_reversion') {
      s = computeMomentum(preHistory, snap, lookback);
      preHistory.push(snap);
    } else {
      s = snap[`btc_return_${externalWindowSec}s`];
    }
    if (s !== null && Number.isFinite(s)) signalSeries.push(Math.abs(s));
  }

  const sortedAbs = [...signalSeries].sort((a, b) => a - b);
  const maxAbsSignal = sortedAbs.length ? sortedAbs[sortedAbs.length - 1] : 0;
  const p99AbsSignal = sortedAbs.length
    ? sortedAbs[Math.min(sortedAbs.length - 1, Math.floor(sortedAbs.length * 0.99))]
    : 0;
  const nonzeroRatio = sortedAbs.length
    ? (sortedAbs.filter((x) => x > 0).length / sortedAbs.length)
    : 0;
  const suggestedThreshold = p99AbsSignal * 0.8;

  const strategy = strategyName === 'external_price_lead'
    ? new ExternalPriceLeadStrategy({ threshold, size, windowSec: externalWindowSec, momentumFilter, spreadGate, impulseGate, moveGate, scaleFactor, maxPosition })
    : new MeanMomentumStrategy({ lookback, threshold, size });
  const state = { cash: initialCash, position: null, realizedPnL: 0, cooldownUntilMs: 0 };
  const history = [];
  const tradeRows = [];
  const intentRows = [];

  for (const snap of rows) {
    const positionBefore = formatPosition(state.position);
    const signalValue = strategyName === 'mean_reversion'
      ? computeMomentum(history, snap, lookback)
      : snap[`btc_return_${externalWindowSec}s`];

    const rawIntent = strategy.onSnapshot({ current: snap, history, position: state.position });
    const snapMs = new Date(snap.ts).getTime();
    const inCooldown = cooldownSec > 0 && snapMs < state.cooldownUntilMs;

    const intent = inCooldown && rawIntent.action !== 'hold'
      ? { action: 'hold', size: 0, reason: `cooldown_active_until=${new Date(state.cooldownUntilMs).toISOString()}` }
      : rawIntent;

    const trades = executeIntent(
      state,
      intent,
      snap,
      { feeRate, slippageBps },
      { singleTradePerTick, noPyramid, flip }
    );
    if (trades.length > 0 && cooldownSec > 0) {
      state.cooldownUntilMs = snapMs + cooldownSec * 1000;
    }

    const positionAfter = formatPosition(state.position);
    const unrealized = calcUnrealized(state.position, snap);
    const positionMarketValue = calcPositionMarketValue(state.position, snap);
    const equity = calcEquity(state, snap);

    intentRows.push({
      ts: snap.ts,
      yes_price: String(snap.yes),
      no_price: String(snap.no),
      btc_price: Number.isFinite(snap.btc_price) ? String(snap.btc_price) : '',
      spread_yes: Number.isFinite(snap.spread_yes) ? Number(snap.spread_yes).toFixed(6) : '',
      btc_return_1s: Number.isFinite(snap.btc_return_1s) ? Number(snap.btc_return_1s).toFixed(6) : '',
      btc_return_2s: Number.isFinite(snap.btc_return_2s) ? Number(snap.btc_return_2s).toFixed(6) : '',
      btc_return_3s: Number.isFinite(snap.btc_return_3s) ? Number(snap.btc_return_3s).toFixed(6) : '',
      btc_return_4s: Number.isFinite(snap.btc_return_4s) ? Number(snap.btc_return_4s).toFixed(6) : '',
      btc_return_5s: Number.isFinite(snap.btc_return_5s) ? Number(snap.btc_return_5s).toFixed(6) : '',
      btc_return_10s: Number.isFinite(snap.btc_return_10s) ? Number(snap.btc_return_10s).toFixed(6) : '',
      signal: signalValue === null || !Number.isFinite(signalValue) ? '' : Number(signalValue).toFixed(6),
      action: intent.action,
      size: String(intent.size),
      reason: intent.reason,
      position_before: positionBefore,
      position_after: positionAfter,
      equity: equity.toFixed(6),
      cash: state.cash.toFixed(6),
      realizedPnl: state.realizedPnL.toFixed(6),
      unrealizedPnl: unrealized.toFixed(6),
      positionMarketValue: positionMarketValue.toFixed(6),
    });

    for (const t of trades) {
      tradeRows.push({
        ts: t.ts,
        marketId: snap.marketId,
        action: t.action,
        outcome: t.outcome,
        size: String(t.size),
        price: String(t.price),
        reason: t.reason,
        fee: Number(t.fee || 0).toFixed(6),
        cash: state.cash.toFixed(6),
        realizedPnl: state.realizedPnL.toFixed(6),
        unrealizedPnl: unrealized.toFixed(6),
        equity: equity.toFixed(6),
      });
    }

    history.push(snap);
  }

  const last = rows[rows.length - 1];

  if (closeOnEnd && state.position) {
    const mark = markPriceForOutcome(last, state.position.outcome);
    const px = mark * (1 - slippageBps / 10000);
    const notional = px * state.position.qty;
    const fee = notional * feeRate;
    const pnl = (px - state.position.avgPrice) * state.position.qty - fee;
    state.cash += notional - fee;
    state.realizedPnL += pnl;

    tradeRows.push({
      ts: last.ts,
      marketId,
      action: 'close',
      outcome: state.position.outcome,
      size: String(state.position.qty),
      price: String(px),
      fee: String(fee),
      reason: 'close_on_end',
      cash: state.cash.toFixed(6),
      realizedPnl: state.realizedPnL.toFixed(6),
      unrealizedPnl: '0.000000',
      equity: state.cash.toFixed(6),
    });

    state.position = null;
  }

  const finalUnrealized = calcUnrealized(state.position, last);
  const finalEquity = calcEquity(state, last);

  const positionPayload = {
    ts: last.ts,
    marketId,
    snapshots: rows.length,
    strategy: strategyName === 'external_price_lead'
      ? { type: 'ExternalPriceLeadStrategy', externalWindowSec, threshold, momentumFilter, spreadGate, impulseGate, moveGate, scaleFactor, maxPosition, size }
      : { type: 'MeanMomentumStrategy', lookback, threshold, size },
    cash: Number(state.cash.toFixed(6)),
    realizedPnl: Number(state.realizedPnL.toFixed(6)),
    unrealizedPnl: Number(finalUnrealized.toFixed(6)),
    equity: Number(finalEquity.toFixed(6)),
    position: state.position,
  };

  await mkdir('data', { recursive: true });
  await writeFile(outTrades, toCsv(tradeRows, ['ts', 'marketId', 'action', 'outcome', 'size', 'price', 'reason', 'fee', 'cash', 'realizedPnl', 'unrealizedPnl', 'equity']), 'utf8');
  await writeFile(outIntents, toCsv(intentRows, ['ts', 'yes_price', 'no_price', 'btc_price', 'spread_yes', 'btc_return_1s', 'btc_return_2s', 'btc_return_3s', 'btc_return_4s', 'btc_return_5s', 'btc_return_10s', 'signal', 'action', 'size', 'reason', 'position_before', 'position_after', 'equity', 'cash', 'realizedPnl', 'unrealizedPnl', 'positionMarketValue']), 'utf8');
  await writeFile(outPosition, JSON.stringify(positionPayload, null, 2), 'utf8');

  console.log(`snapshots_used: ${rows.length}`);
  console.log(`cooldown_sec: ${cooldownSec}`);
  console.log(`close_on_end: ${closeOnEnd}`);
  console.log(`fee_rate: ${feeRate}`);
  console.log(`slippage_bps: ${slippageBps}`);
  console.log(`single_trade_per_tick: ${singleTradePerTick}`);
  console.log(`no_pyramid: ${noPyramid}`);
  console.log(`flip_mode: ${flip}`);
  console.log(`strategy: ${strategyName}`);
  console.log(`external_window_sec: ${externalWindowSec}`);
  console.log(`momentum_filter: ${momentumFilter}`);
  console.log(`spread_gate: ${spreadGate}`);
  console.log(`impulse_gate: ${impulseGate}`);
  console.log(`move_gate: ${moveGate}`);
  console.log(`scale_factor: ${scaleFactor}`);
  console.log(`max_position: ${maxPosition}`);
  console.log(`max_abs_signal: ${maxAbsSignal.toFixed(6)}`);
  console.log(`p99_abs_signal: ${p99AbsSignal.toFixed(6)}`);
  console.log(`nonzero_ratio: ${nonzeroRatio.toFixed(4)}`);
  console.log(`suggested_threshold: ${suggestedThreshold.toFixed(6)}`);
  console.log(`trades_count: ${tradeRows.length}`);
  console.log(`out_trades: ${outTrades}`);
  console.log(`out_intents: ${outIntents}`);
  console.log(`out_position: ${outPosition}`);
  console.log(`final_equity: ${positionPayload.equity}`);
  console.log(`final_realized_pnl: ${positionPayload.realizedPnl}`);
  console.log(`final_unrealized_pnl: ${positionPayload.unrealizedPnl}`);

  await log(`replay marketId=${marketId} strategy=${strategyName} externalWindowSec=${externalWindowSec} momentumFilter=${momentumFilter} spreadGate=${spreadGate} impulseGate=${impulseGate} moveGate=${moveGate} scaleFactor=${scaleFactor} maxPosition=${maxPosition} snapshots=${rows.length} cooldownSec=${cooldownSec} closeOnEnd=${closeOnEnd} feeRate=${feeRate} slippageBps=${slippageBps} singleTradePerTick=${singleTradePerTick} noPyramid=${noPyramid} flip=${flip} maxAbsSignal=${maxAbsSignal.toFixed(6)} p99AbsSignal=${p99AbsSignal.toFixed(6)} nonzeroRatio=${nonzeroRatio.toFixed(4)} suggestedThreshold=${suggestedThreshold.toFixed(6)} trades=${tradeRows.length} intents=${intentRows.length} equity=${positionPayload.equity} outTrades=${outTrades} outIntents=${outIntents} outPosition=${outPosition}`);
}

main().catch(async (err) => {
  console.error(`ERROR: ${err.message || String(err)}`);
  await log(`replay error=${JSON.stringify(err.message || String(err))}`);
  process.exit(1);
});
