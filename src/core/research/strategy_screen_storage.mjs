import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export function calculateRollingTwap({ reports, nowMs, windowSec, maxReportAgeSec = Infinity }) {
  const now = Number(nowMs);
  const windowMs = Number(windowSec) * 1000;
  const maxReportAgeMs = Number(maxReportAgeSec) * 1000;
  if (!(Number.isFinite(now) && Number.isFinite(windowMs) && windowMs > 0 && (maxReportAgeSec === Infinity || (Number.isFinite(maxReportAgeMs) && maxReportAgeMs > 0)))) return null;
  const windowStart = now - windowMs;
  const ordered = (reports || [])
    .map((report, index) => ({ timestamp: Number(report?.timestamp), value: Number(report?.value), index }))
    .filter((report) => Number.isFinite(report.timestamp) && Number.isFinite(report.value) && report.value > 0 && report.timestamp <= now)
    .sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);
  if (!ordered.length) return null;

  const deduplicated = [];
  for (const report of ordered) {
    if (deduplicated.at(-1)?.timestamp === report.timestamp) deduplicated[deduplicated.length - 1] = report;
    else deduplicated.push(report);
  }
  if (maxReportAgeSec !== Infinity && now - deduplicated.at(-1).timestamp > maxReportAgeMs) return null;
  const anchorIndex = deduplicated.findLastIndex((report) => report.timestamp <= windowStart);
  if (anchorIndex < 0) return null;

  let cursor = windowStart;
  let value = deduplicated[anchorIndex].value;
  let weightedSum = 0;
  for (const report of deduplicated.slice(anchorIndex + 1)) {
    if (report.timestamp >= now) break;
    const duration = report.timestamp - cursor;
    if (duration > 0) weightedSum += value * duration;
    cursor = report.timestamp;
    value = report.value;
  }
  const finalDuration = now - cursor;
  if (finalDuration > 0) weightedSum += value * finalDuration;
  return weightedSum / windowMs;
}

export async function createScreenRun({ outputRoot = 'runs/strategy-screen', runId, nowMs = Date.now() }) {
  const id = String(runId || '').trim();
  if (!/^\d{8}T\d{6}Z-[a-z0-9_-]+$/i.test(id)) throw new Error('invalid_run_id');
  const root = resolve(outputRoot);
  const runDir = join(root, id);
  await mkdir(root, { recursive: true });
  try {
    await mkdir(runDir, { recursive: false });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('run_directory_exists');
    throw error;
  }
  const manifestPath = join(runDir, 'manifest.json');
  const rawPath = join(runDir, 'raw.jsonl');
  await writeFile(manifestPath, `${JSON.stringify({
    schema_version: 1,
    run_id: id,
    started_at: new Date(nowMs).toISOString(),
    status: 'running',
    read_only: true,
  })}\n`, { flag: 'wx' });
  await writeFile(rawPath, '', { flag: 'wx' });
  return { runId: id, runDir, manifestPath, rawPath };
}
