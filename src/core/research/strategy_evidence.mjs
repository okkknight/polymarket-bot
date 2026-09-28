export function parseTwapWindowSec(description) {
  const text = String(description || '').toLowerCase();
  const matches = [
    ...text.matchAll(/\b(\d+)\s*(?:second|seconds|sec)\s+twap\b/g),
    ...text.matchAll(/\btwap-(\d+)s-streams\b/g),
  ].map((match) => Number(match[1])).filter((value) => Number.isFinite(value) && value > 0);
  const windows = [...new Set(matches)];
  return windows.length === 1 ? windows[0] : null;
}

export function calculateTakerFee({ shares, price, feeRate }) {
  const size = Number(shares);
  const executionPrice = Number(price);
  const rate = Number(feeRate);
  if (!(size >= 0 && executionPrice >= 0 && executionPrice <= 1 && rate >= 0)) return NaN;
  return Number((size * rate * executionPrice * (1 - executionPrice)).toFixed(5));
}

export function evaluateLeadLag({ snapshots }) {
  const pairs = (snapshots || [])
    .map((snapshot) => [Number(snapshot?.external_return), Number(snapshot?.polymarket_forward_change)])
    .filter(([externalReturn, forwardChange]) => Number.isFinite(externalReturn) && Number.isFinite(forwardChange));
  if (pairs.length < 3) return { ok: false, reason: 'lead_lag_sample_too_small', metrics: { observations: pairs.length } };
  const forwardEffect = pairs.reduce((sum, [externalReturn, forwardChange]) => sum + externalReturn * forwardChange, 0) / pairs.length;
  return {
    ok: forwardEffect > 0,
    reason: forwardEffect > 0 ? 'positive_forward_effect' : 'non_positive_forward_effect',
    metrics: { observations: pairs.length, forward_effect: forwardEffect },
  };
}

export function decideTrade({
  yesFairProbability,
  yesAsk,
  yesBid,
  noAsk,
  noBid,
  yesAskSize,
  noAskSize,
  minSize,
  feeRate,
  edgeBuffer,
  secondsRemaining,
}) {
  if (!(Number(secondsRemaining) >= 60)) return { action: 'hold', reason: 'near_settlement' };
  const values = [yesFairProbability, yesAsk, yesBid, noAsk, noBid, yesAskSize, noAskSize, minSize, feeRate, edgeBuffer].map(Number);
  if (!values.every(Number.isFinite)) return { action: 'hold', reason: 'invalid_input' };
  if (!(yesAsk > 0 && yesBid > 0 && noAsk > 0 && noBid > 0 && yesAsk >= yesBid && noAsk >= noBid)) {
    return { action: 'hold', reason: 'incomplete_book' };
  }
  const yesRoundTripCost = (yesAsk - yesBid)
    + calculateTakerFee({ shares: 1, price: yesAsk, feeRate })
    + calculateTakerFee({ shares: 1, price: yesBid, feeRate });
  const noRoundTripCost = (noAsk - noBid)
    + calculateTakerFee({ shares: 1, price: noAsk, feeRate })
    + calculateTakerFee({ shares: 1, price: noBid, feeRate });
  const yesEdge = yesFairProbability - yesAsk - yesRoundTripCost - edgeBuffer;
  const noEdge = (1 - yesFairProbability) - noAsk - noRoundTripCost - edgeBuffer;
  if (yesAskSize >= minSize && yesEdge > 0) return { action: 'buy_yes', reason: 'yes_cost_adjusted_edge' };
  if (noAskSize >= minSize && noEdge > 0) return { action: 'buy_no', reason: 'no_cost_adjusted_edge' };
  return { action: 'hold', reason: 'edge_below_cost_buffer' };
}
