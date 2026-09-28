import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

import {
  buildCausalPairs,
  evaluateHistoricalScreen,
  normalizeHistoricalPoint,
  summarizeRawScreenRows,
} from '../src/core/research/historical_strategy_screen.mjs';

const execFileAsync = promisify(execFile);

function rawRow({ second, marketId = 'market-a', okxSpot, yesBid, yesAsk, valid = true }) {
  return {
    captured_at: new Date(second * 1_000).toISOString(),
    valid,
    market_id: marketId,
    twap_window_sec: 60,
    chainlink_twap: 80_000,
    fee_schedule: { rate: 0.07 },
    okx_spot: okxSpot,
    yes: { bid: yesBid === null ? null : { price: yesBid, size: 10 }, ask: yesAsk === null ? null : { price: yesAsk, size: 10 } },
    no: { bid: { price: 1 - yesAsk, size: 10 }, ask: { price: 1 - yesBid, size: 10 } },
  };
}

test('requires an explicit timestamp unit for historical points', () => {
  assert.throws(
    () => normalizeHistoricalPoint({ t: 1, p: 10 }),
    /timestamp_unit_required/,
  );
});

test('creates only causal exact-timestamp pairs', () => {
  const external = [
    { t: 0, p: 100 },
    { t: 1, p: 110 },
    { t: 2, p: 10_000 },
  ];
  const polymarket = [
    { t: 0, p: 0.40 },
    { t: 1, p: 0.44 },
    { t: 2, p: 0.484 },
  ];

  assert.deepEqual(
    buildCausalPairs({ external, polymarket, timestampUnit: 's', horizonMs: 1_000 }),
    [{ timestamp_ms: 1_000, external_return: 0.1, polymarket_forward_change: 0.1 }],
  );
});

test('rejects duplicate or non-monotonic historical timestamps instead of guessing alignment', () => {
  assert.throws(
    () => buildCausalPairs({
      external: [{ t: 0, p: 100 }, { t: 1, p: 101 }, { t: 1, p: 102 }],
      polymarket: [{ t: 0, p: 0.4 }, { t: 1, p: 0.5 }, { t: 2, p: 0.6 }],
      timestampUnit: 's',
      horizonMs: 1_000,
    }),
    /timestamps_not_strictly_increasing/,
  );
});

test('marks missing settlement truth or executable costs as data insufficient', () => {
  const report = evaluateHistoricalScreen({
    pairs: [
      { external_return: 0.01, polymarket_forward_change: 0.02 },
      { external_return: -0.01, polymarket_forward_change: -0.02 },
      { external_return: 0.02, polymarket_forward_change: 0.03 },
    ],
    expectedPairs: 3,
    hasChainlinkSettlementTruth: false,
    hasExecutableCosts: false,
    minPairs: 3,
    minCoverage: 0.95,
  });
  assert.equal(report.verdict, 'DATA_INSUFFICIENT');
  assert.deepEqual(report.reasons, ['chainlink_settlement_truth_missing', 'executable_costs_missing']);
});

test('rejects an incomplete historical range even when its available points are valid', () => {
  const report = evaluateHistoricalScreen({
    pairs: [
      { external_return: 0.01, polymarket_forward_change: 0.02 },
      { external_return: -0.01, polymarket_forward_change: -0.02 },
      { external_return: 0.02, polymarket_forward_change: 0.03 },
    ],
    expectedPairs: 4,
    hasChainlinkSettlementTruth: true,
    hasExecutableCosts: true,
    minPairs: 3,
    minCoverage: 0.95,
  });
  assert.equal(report.verdict, 'DATA_INSUFFICIENT');
  assert.deepEqual(report.reasons, ['historical_coverage_below_threshold']);
});

test('marks a complete, negative forward-effect sample as screen fail', () => {
  const report = evaluateHistoricalScreen({
    pairs: [
      { external_return: 0.01, polymarket_forward_change: -0.02 },
      { external_return: -0.01, polymarket_forward_change: 0.02 },
      { external_return: 0.02, polymarket_forward_change: -0.03 },
    ],
    expectedPairs: 3,
    hasChainlinkSettlementTruth: true,
    hasExecutableCosts: true,
    minPairs: 3,
    minCoverage: 0.95,
  });
  assert.equal(report.verdict, 'SCREEN_FAIL');
  assert.deepEqual(report.reasons, ['non_positive_forward_effect']);
});

test('does not treat a positive historical correlation as strategy eligibility', () => {
  const report = evaluateHistoricalScreen({
    pairs: [
      { external_return: 0.01, polymarket_forward_change: 0.02 },
      { external_return: -0.01, polymarket_forward_change: -0.02 },
      { external_return: 0.02, polymarket_forward_change: 0.03 },
    ],
    expectedPairs: 3,
    hasChainlinkSettlementTruth: true,
    hasExecutableCosts: true,
    minPairs: 3,
    minCoverage: 0.95,
  });
  assert.equal(report.verdict, 'DATA_INSUFFICIENT');
  assert.deepEqual(report.reasons, ['full_oos_cost_adjusted_replay_required']);
});

test('creates a raw-screen pair only within one market and with a later target', () => {
  const summary = summarizeRawScreenRows({
    rows: [
      rawRow({ second: 0, okxSpot: 100, yesBid: 0.39, yesAsk: 0.41 }),
      rawRow({ second: 1, okxSpot: 110, yesBid: 0.43, yesAsk: 0.45 }),
      rawRow({ second: 2, okxSpot: 120, yesBid: 0.473, yesAsk: 0.495 }),
      rawRow({ second: 3, marketId: 'market-b', okxSpot: 130, yesBid: 0.5, yesAsk: 0.52 }),
    ],
    horizonMs: 1_000,
    alignmentToleranceMs: 10,
    maxGapMs: 10_000,
  });
  assert.deepEqual(summary.pairs, [{ timestamp_ms: 1_000, external_return: 0.1, polymarket_forward_change: 0.1 }]);
  assert.equal(summary.expected_pairs, 1);
});

test('counts an incomplete raw snapshot against coverage instead of silently skipping it', () => {
  const summary = summarizeRawScreenRows({
    rows: [
      rawRow({ second: 0, okxSpot: 100, yesBid: 0.39, yesAsk: 0.41 }),
      rawRow({ second: 1, okxSpot: 110, yesBid: null, yesAsk: 0.45, valid: false }),
      rawRow({ second: 2, okxSpot: 120, yesBid: 0.473, yesAsk: 0.495 }),
    ],
    horizonMs: 1_000,
    alignmentToleranceMs: 10,
    maxGapMs: 10_000,
  });
  assert.equal(summary.expected_pairs, 1);
  assert.equal(summary.pairs.length, 0);
  assert.equal(summary.valid_rows, 2);
});

test('offline historical command writes a data-insufficient report when evidence flags are absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'historical-screen-'));
  const inputPath = join(root, 'input.json');
  const outPath = join(root, 'report.json');
  await writeFile(inputPath, JSON.stringify({
    timestamp_unit: 's',
    horizon_ms: 1_000,
    external: [{ t: 0, p: 100 }, { t: 1, p: 101 }, { t: 2, p: 102 }],
    polymarket: [{ t: 0, p: 0.4 }, { t: 1, p: 0.41 }, { t: 2, p: 0.42 }],
    expected_pairs: 1,
    has_chainlink_settlement_truth: false,
    has_executable_costs: false,
    min_pairs: 1,
    min_coverage: 1,
  }));

  await execFileAsync(process.execPath, [
    'src/tools/polymarket_historical_strategy_screen.mjs', '--input', inputPath, '--out', outPath,
  ], { cwd: process.cwd() });

  const report = JSON.parse(await readFile(outPath, 'utf8'));
  assert.equal(report.verdict, 'DATA_INSUFFICIENT');
  assert.deepEqual(report.reasons, ['chainlink_settlement_truth_missing', 'executable_costs_missing']);
});

test('raw-screen command marks a short immutable run as data insufficient', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raw-screen-'));
  const rawPath = join(root, 'raw.jsonl');
  const outPath = join(root, 'report.json');
  await writeFile(rawPath, [
    rawRow({ second: 0, okxSpot: 100, yesBid: 0.39, yesAsk: 0.41 }),
    rawRow({ second: 1, okxSpot: 110, yesBid: 0.43, yesAsk: 0.45 }),
    rawRow({ second: 2, okxSpot: 120, yesBid: 0.473, yesAsk: 0.495 }),
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');

  await execFileAsync(process.execPath, [
    'src/tools/polymarket_raw_strategy_screen_report.mjs', '--raw', rawPath, '--out', outPath,
  ], { cwd: process.cwd() });

  const report = JSON.parse(await readFile(outPath, 'utf8'));
  assert.equal(report.verdict, 'DATA_INSUFFICIENT');
  assert.ok(report.reasons.includes('duration_below_7_days'));
  assert.equal(report.metrics.rows, 3);
});
