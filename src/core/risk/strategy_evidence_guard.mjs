import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function verifyStrategyEvidenceReport({ reportPath, nowMs = Date.now(), maxAgeMs = 15 * 60_000 }) {
  if (!String(reportPath || '').trim()) return { ok: false, reason: 'strategy_report_required' };
  let report;
  try { report = JSON.parse(await readFile(reportPath, 'utf8')); } catch { return { ok: false, reason: 'strategy_report_unreadable' }; }
  if (report?.verdict !== 'ELIGIBLE_FOR_REVIEW') return { ok: false, reason: 'strategy_report_not_eligible' };
  const generatedAt = Date.parse(report?.generated_at || '');
  if (!(Number.isFinite(generatedAt) && generatedAt <= nowMs && nowMs - generatedAt <= maxAgeMs)) return { ok: false, reason: 'strategy_report_stale' };
  try {
    if (await sha256(join(dirname(reportPath), 'raw.jsonl')) !== report.raw_sha256) return { ok: false, reason: 'strategy_report_raw_hash_mismatch' };
  } catch { return { ok: false, reason: 'strategy_report_raw_unreadable' }; }
  return { ok: true, reason: 'strategy_report_verified' };
}
