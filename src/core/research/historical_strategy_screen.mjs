function toTimestampMs(value, timestampUnit) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) throw new Error('invalid_timestamp');
  if (timestampUnit === 's') return timestamp * 1_000;
  if (timestampUnit === 'ms') return timestamp;
  throw new Error('timestamp_unit_required');
}

function normalizeSeries(points, timestampUnit) {
  const normalized = (points || []).map((point) => normalizeHistoricalPoint(point, timestampUnit));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].timestamp_ms <= normalized[index - 1].timestamp_ms) {
      throw new Error('timestamps_not_strictly_increasing');
    }
  }
  return normalized;
}

function rounded(value) {
  return Number(value.toFixed(12));
}

export function normalizeHistoricalPoint(point, timestampUnit) {
  const price = Number(point?.p);
  if (!(Number.isFinite(price) && price > 0)) throw new Error('invalid_price');
  return { timestamp_ms: toTimestampMs(point?.t, timestampUnit), price };
}

export function buildCausalPairs({ external, polymarket, timestampUnit, horizonMs }) {
  const horizon = Number(horizonMs);
  if (!(Number.isFinite(horizon) && horizon > 0)) throw new Error('invalid_horizon_ms');
  const externalSeries = normalizeSeries(external, timestampUnit);
  const polymarketSeries = normalizeSeries(polymarket, timestampUnit);
  const externalByTimestamp = new Map(externalSeries.map((point) => [point.timestamp_ms, point.price]));
  const polymarketByTimestamp = new Map(polymarketSeries.map((point) => [point.timestamp_ms, point.price]));
  const pairs = [];

  for (const point of externalSeries) {
    const priorExternal = externalByTimestamp.get(point.timestamp_ms - horizon);
    const currentPolymarket = polymarketByTimestamp.get(point.timestamp_ms);
    const futurePolymarket = polymarketByTimestamp.get(point.timestamp_ms + horizon);
    if (!(Number.isFinite(priorExternal) && Number.isFinite(currentPolymarket) && Number.isFinite(futurePolymarket))) continue;
    pairs.push({
      timestamp_ms: point.timestamp_ms,
      external_return: rounded((point.price - priorExternal) / priorExternal),
      polymarket_forward_change: rounded((futurePolymarket - currentPolymarket) / currentPolymarket),
    });
  }
  return pairs;
}

export function evaluateHistoricalScreen({
  pairs,
  expectedPairs,
  hasChainlinkSettlementTruth,
  hasExecutableCosts,
  minPairs = 100,
  minCoverage = 0.95,
}) {
  const validPairs = (pairs || []).filter((pair) => (
    Number.isFinite(Number(pair?.external_return))
    && Number.isFinite(Number(pair?.polymarket_forward_change))
  ));
  const expected = Number(expectedPairs);
  const coverage = Number.isFinite(expected) && expected > 0 ? validPairs.length / expected : 0;
  const reasons = [];
  if (hasChainlinkSettlementTruth !== true) reasons.push('chainlink_settlement_truth_missing');
  if (hasExecutableCosts !== true) reasons.push('executable_costs_missing');
  if (validPairs.length < Number(minPairs)) reasons.push('lead_lag_sample_too_small');
  if (coverage < Number(minCoverage)) reasons.push('historical_coverage_below_threshold');
  const metrics = { observations: validPairs.length, expected_observations: Number.isFinite(expected) ? expected : null, coverage };
  if (reasons.length) return { verdict: 'DATA_INSUFFICIENT', reasons, metrics };

  const forwardEffect = validPairs.reduce(
    (sum, pair) => sum + Number(pair.external_return) * Number(pair.polymarket_forward_change),
    0,
  ) / validPairs.length;
  metrics.forward_effect = forwardEffect;
  if (forwardEffect <= 0) return { verdict: 'SCREEN_FAIL', reasons: ['non_positive_forward_effect'], metrics };
  return { verdict: 'DATA_INSUFFICIENT', reasons: ['full_oos_cost_adjusted_replay_required'], metrics };
}

function rawSnapshot(row) {
  const timestampMs = Date.parse(row?.captured_at || '');
  const yesBid = Number(row?.yes?.bid?.price);
  const yesAsk = Number(row?.yes?.ask?.price);
  const noBid = Number(row?.no?.bid?.price);
  const noAsk = Number(row?.no?.ask?.price);
  const chainlinkTwap = Number(row?.chainlink_twap);
  const feeRate = Number(row?.fee_schedule?.rate);
  const okxSpot = Number(row?.okx_spot);
  const hasCompleteBook = [yesBid, yesAsk, noBid, noAsk].every((price) => Number.isFinite(price) && price > 0 && price < 1)
    && yesBid <= yesAsk && noBid <= noAsk;
  const usable = row?.valid === true
    && Number.isFinite(timestampMs)
    && Boolean(row?.market_id)
    && Number.isFinite(chainlinkTwap) && chainlinkTwap > 0
    && Number.isFinite(feeRate) && feeRate >= 0
    && Number.isFinite(okxSpot) && okxSpot > 0
    && hasCompleteBook;
  return {
    timestamp_ms: timestampMs,
    market_id: String(row?.market_id || ''),
    okx_spot: okxSpot,
    yes_mid: hasCompleteBook ? (yesBid + yesAsk) / 2 : NaN,
    usable,
  };
}

function withinTolerance(actual, expected, tolerance) {
  return Math.abs(actual - expected) <= tolerance;
}

function validateRawScreenTiming({ horizonMs, alignmentToleranceMs, maxGapMs }) {
  const horizon = Number(horizonMs);
  const tolerance = Number(alignmentToleranceMs);
  const maxGap = Number(maxGapMs);
  if (!(Number.isFinite(horizon) && horizon > 0 && Number.isFinite(tolerance) && tolerance >= 0 && Number.isFinite(maxGap) && maxGap > 0)) {
    throw new Error('invalid_raw_screen_timing');
  }
  return { horizon, tolerance, maxGap };
}

export function createRawScreenAccumulator({ horizonMs, alignmentToleranceMs = 250, maxGapMs = 10_000 }) {
  const { horizon, tolerance, maxGap } = validateRawScreenTiming({ horizonMs, alignmentToleranceMs, maxGapMs });
  const snapshots = [];
  const pairs = [];
  let totalRows = 0;
  let validRows = 0;
  let maxGapObserved = 0;
  let gapsOverMaximum = 0;
  let nonMonotonicRows = 0;
  let expectedPairs = 0;

  function add(row) {
    const snapshot = rawSnapshot(row);
    totalRows += 1;
    if (snapshot.usable) validRows += 1;
    const previous = snapshots.at(-1);
    if (previous) {
      const gap = snapshot.timestamp_ms - previous.timestamp_ms;
      if (gap <= 0) nonMonotonicRows += 1;
      if (Number.isFinite(gap)) {
        maxGapObserved = Math.max(maxGapObserved, gap);
        if (gap > maxGap) gapsOverMaximum += 1;
      }
    }
    snapshots.push(snapshot);
    if (snapshots.length < 3) return;
    const [prior, current, future] = snapshots;
    if (prior.market_id && prior.market_id === current.market_id && current.market_id === future.market_id
      && withinTolerance(current.timestamp_ms - prior.timestamp_ms, horizon, tolerance)
      && withinTolerance(future.timestamp_ms - current.timestamp_ms, horizon, tolerance)) {
      expectedPairs += 1;
      if (prior.usable && current.usable && future.usable) {
        pairs.push({
          timestamp_ms: current.timestamp_ms,
          external_return: rounded((current.okx_spot - prior.okx_spot) / prior.okx_spot),
          polymarket_forward_change: rounded((future.yes_mid - current.yes_mid) / current.yes_mid),
        });
      }
    }
    snapshots.shift();
  }

  function finish() {
    return {
      pairs,
      expected_pairs: expectedPairs,
      total_rows: totalRows,
      valid_rows: validRows,
      max_gap_ms: maxGapObserved,
      gaps_over_maximum: gapsOverMaximum,
      non_monotonic_rows: nonMonotonicRows,
    };
  }
  return { add, finish };
}

export function summarizeRawScreenRows({ rows, horizonMs, alignmentToleranceMs = 250, maxGapMs = 10_000 }) {
  const accumulator = createRawScreenAccumulator({ horizonMs, alignmentToleranceMs, maxGapMs });
  for (const row of rows || []) accumulator.add(row);
  return accumulator.finish();
}
