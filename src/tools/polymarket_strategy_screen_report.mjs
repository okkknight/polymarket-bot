#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const DAY_MS = 86_400_000;

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function generateStrategyScreenReport({ runDir, nowMs = Date.now() }) {
  const dir = resolve(runDir);
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  if (manifest?.status !== 'completed') throw new Error('manifest_not_completed');
  const rawPath = join(dir, 'raw.jsonl');
  const rawSha256 = await sha256(rawPath);
  if (rawSha256 !== manifest?.raw_sha256) throw new Error('raw_sha256_mismatch');
  const rows = (await readFile(rawPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const validRows = rows.filter((row) => row?.valid === true);
  const timestamps = rows.map((row) => Date.parse(row?.captured_at || '')).filter(Number.isFinite);
  const durationMs = timestamps.length ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
  const validRatio = rows.length ? validRows.length / rows.length : 0;
  const reasons = [];
  if (durationMs < 14 * DAY_MS) reasons.push('duration_below_14_days');
  if (validRatio < 0.95) reasons.push('valid_ratio_below_95_percent');
  if (!rows.length) reasons.push('no_snapshots');
  const report = {
    schema_version: 1,
    run_id: manifest.run_id,
    raw_sha256: rawSha256,
    generated_at: new Date(nowMs).toISOString(),
    verdict: reasons.length ? 'DATA_INSUFFICIENT' : 'SCREEN_FAIL',
    reasons: reasons.length ? reasons : ['lead_lag_and_cost_evaluation_not_yet_implemented'],
    metrics: { rows: rows.length, valid_rows: validRows.length, valid_ratio: validRatio, duration_ms: durationMs },
  };
  const reportPath = join(dir, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return report;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const i = process.argv.indexOf('--runDir');
  if (i === -1 || !process.argv[i + 1]) throw new Error('require_run_dir');
  generateStrategyScreenReport({ runDir: process.argv[i + 1] })
    .then((report) => console.log(JSON.stringify(report)))
    .catch((error) => { console.error(`ERROR: ${error?.message || String(error)}`); process.exit(1); });
}
