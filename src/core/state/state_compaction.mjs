import { mkdir, appendFile } from 'node:fs/promises';

function isFinalStatus(status) {
  return ['filled', 'canceled', 'expired', 'rejected', 'partially_filled_canceled'].includes(String(status || '').toLowerCase());
}

function shouldKeepTerminalForLateFillAudit(rec, nowMs = Date.now()) {
  const status = String(rec?.status || '').toLowerCase();
  if (!isFinalStatus(status)) return false;
  if (!['canceled', 'expired', 'rejected'].includes(status)) return false;
  if (rec?.late_fill_audit_done_at) return false;
  const executedSize = Number(rec?.executed_size || 0);
  if (executedSize > 0) return false;

  const maxQueries = Number(process.env.TERMINAL_LATE_FILL_MAX_QUERIES || 12);
  const currentQueries = Number(rec?.late_fill_audit_count || 0);
  if (currentQueries >= maxQueries) return false;

  const windowMs = Number(process.env.TERMINAL_LATE_FILL_AUDIT_WINDOW_MS || 180000);
  const refTs = Date.parse(rec?.ack_ts || rec?.status_ts || rec?.ts || 0);
  if (!Number.isFinite(refTs)) return true;
  const ageMs = Math.max(0, nowMs - refTs);
  return ageMs <= windowMs;
}

export async function compactTradeState({
  state,
  archivePath = 'data/trader_state_archive.jsonl',
  keepRecentOpen = 200,
  onEvent = async () => {},
}) {
  const intents = state?.intents || {};
  const entries = Object.entries(intents);
  const nowMs = Date.now();
  const finalEntries = entries.filter(([, rec]) => isFinalStatus(rec?.status) && !shouldKeepTerminalForLateFillAudit(rec, nowMs));
  const openEntries = entries.filter(([, rec]) => !isFinalStatus(rec?.status) || shouldKeepTerminalForLateFillAudit(rec, nowMs));
  const keptTerminalAuditCount = openEntries.reduce((acc, [, rec]) => acc + (shouldKeepTerminalForLateFillAudit(rec, nowMs) ? 1 : 0), 0);

  await mkdir('data', { recursive: true });

  for (const [k, rec] of finalEntries) {
    await appendFile(archivePath, JSON.stringify({ archived_at: new Date().toISOString(), key: k, ...rec }) + '\n', 'utf8');
  }

  // keep open orders only, and cap size defensively
  const keptOpen = openEntries.slice(-keepRecentOpen);
  const nextIntents = Object.fromEntries(keptOpen);
  const nextIndex = {};
  for (const [k, rec] of keptOpen) nextIndex[k] = rec?.status || 'acknowledged';

  state.intents = nextIntents;
  state.intent_index = nextIndex;
  state.last_compaction_ts = new Date().toISOString();

  await onEvent('STATE_COMPACTED', {
    archived_count: finalEntries.length,
    kept_open_count: keptOpen.length,
    kept_terminal_late_fill_audit_count: keptTerminalAuditCount,
    archive_path: archivePath,
  });

  return {
    archivedCount: finalEntries.length,
    keptOpenCount: keptOpen.length,
    state,
  };
}
