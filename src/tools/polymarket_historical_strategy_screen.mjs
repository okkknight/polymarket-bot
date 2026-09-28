#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { buildCausalPairs, evaluateHistoricalScreen } from '../core/research/historical_strategy_screen.mjs';

function requiredArg(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? '' : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`require_${name.slice(2)}`);
  return value;
}

export async function generateHistoricalStrategyScreen({ inputPath, outPath, nowMs = Date.now() }) {
  const source = await readFile(resolve(inputPath));
  const input = JSON.parse(source.toString('utf8'));
  const pairs = buildCausalPairs({
    external: input.external,
    polymarket: input.polymarket,
    timestampUnit: input.timestamp_unit,
    horizonMs: input.horizon_ms,
  });
  const evaluation = evaluateHistoricalScreen({
    pairs,
    expectedPairs: input.expected_pairs,
    hasChainlinkSettlementTruth: input.has_chainlink_settlement_truth,
    hasExecutableCosts: input.has_executable_costs,
    minPairs: input.min_pairs,
    minCoverage: input.min_coverage,
  });
  const report = {
    schema_version: 1,
    generated_at: new Date(nowMs).toISOString(),
    input_sha256: createHash('sha256').update(source).digest('hex'),
    timestamp_unit: input.timestamp_unit,
    horizon_ms: input.horizon_ms,
    ...evaluation,
  };
  const destination = resolve(outPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return report;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  generateHistoricalStrategyScreen({ inputPath: requiredArg('--input'), outPath: requiredArg('--out') })
    .then((report) => console.log(JSON.stringify({ verdict: report.verdict, out: resolve(requiredArg('--out')) })))
    .catch((error) => { console.error(`ERROR: ${error?.message || String(error)}`); process.exit(1); });
}
