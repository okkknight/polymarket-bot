#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';

import { createRawScreenAccumulator, evaluateHistoricalScreen } from '../core/research/historical_strategy_screen.mjs';

const DAY_MS = 86_400_000;

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function requiredArg(name) {
  const value = arg(name);
  if (!value || value.startsWith('--')) throw new Error(`require_${name.slice(2)}`);
  return value;
}

function positiveNumber(value, reason) {
  const number = Number(value);
  if (!(Number.isFinite(number) && number > 0)) throw new Error(reason);
  return number;
}

export async function generateRawStrategyScreenReport({
  rawPath,
  outPath,
  horizonMs = 1_000,
  minDurationMs = 7 * DAY_MS,
  minValidRatio = 0.95,
  maxGapMs = 10_000,
  minPairs = 100,
  minCoverage = 0.95,
  nowMs = Date.now(),
}) {
  const source = resolve(rawPath);
  const input = createReadStream(source);
  const sha256 = createHash('sha256');
  input.on('data', (chunk) => sha256.update(chunk));
  const reader = createInterface({ input, crlfDelay: Infinity });
  const accumulator = createRawScreenAccumulator({ horizonMs, maxGapMs });
  let parseErrors = 0;
  let firstTimestampMs = null;
  let lastTimestampMs = null;
  for await (const line of reader) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { parseErrors += 1; continue; }
    const timestampMs = Date.parse(row?.captured_at || '');
    if (Number.isFinite(timestampMs)) {
      firstTimestampMs ??= timestampMs;
      lastTimestampMs = timestampMs;
    }
    accumulator.add(row);
  }
  const summary = accumulator.finish();
  const durationMs = firstTimestampMs === null || lastTimestampMs === null ? 0 : lastTimestampMs - firstTimestampMs;
  const validRatio = summary.total_rows ? summary.valid_rows / summary.total_rows : 0;
  const qualityReasons = [];
  if (durationMs < positiveNumber(minDurationMs, 'invalid_min_duration_ms')) qualityReasons.push('duration_below_7_days');
  if (validRatio < positiveNumber(minValidRatio, 'invalid_min_valid_ratio')) qualityReasons.push('valid_ratio_below_95_percent');
  if (summary.gaps_over_maximum > 0) qualityReasons.push('raw_gap_exceeds_10_seconds');
  if (summary.non_monotonic_rows > 0) qualityReasons.push('raw_timestamps_not_strictly_increasing');
  if (parseErrors > 0) qualityReasons.push('raw_json_parse_error');
  const evaluation = evaluateHistoricalScreen({
    pairs: summary.pairs,
    expectedPairs: summary.expected_pairs,
    hasChainlinkSettlementTruth: true,
    hasExecutableCosts: true,
    minPairs,
    minCoverage,
  });
  const verdict = qualityReasons.length ? 'DATA_INSUFFICIENT' : evaluation.verdict;
  const report = {
    schema_version: 1,
    generated_at: new Date(nowMs).toISOString(),
    raw_sha256: sha256.digest('hex'),
    verdict,
    reasons: [...qualityReasons, ...evaluation.reasons],
    metrics: {
      rows: summary.total_rows,
      valid_rows: summary.valid_rows,
      valid_ratio: validRatio,
      duration_ms: durationMs,
      max_gap_ms: summary.max_gap_ms,
      gaps_over_10_seconds: summary.gaps_over_maximum,
      non_monotonic_rows: summary.non_monotonic_rows,
      expected_pairs: summary.expected_pairs,
      valid_pairs: summary.pairs.length,
      pair_coverage: summary.expected_pairs ? summary.pairs.length / summary.expected_pairs : 0,
      parse_errors: parseErrors,
      ...evaluation.metrics,
    },
  };
  const destination = resolve(outPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return report;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  generateRawStrategyScreenReport({
    rawPath: requiredArg('--raw'),
    outPath: requiredArg('--out'),
    horizonMs: positiveNumber(arg('--horizonSec', '1'), 'invalid_horizon_sec') * 1_000,
  }).then((report) => console.log(JSON.stringify({ verdict: report.verdict, out: resolve(requiredArg('--out')) })))
    .catch((error) => { console.error(`ERROR: ${error?.message || String(error)}`); process.exit(1); });
}
