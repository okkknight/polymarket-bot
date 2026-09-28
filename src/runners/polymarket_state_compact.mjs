#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import { loadTradeState, saveTradeState } from '../core/state/trade_state_store.mjs';
import { compactTradeState } from '../core/state/state_compaction.mjs';

const keepRecentOpen = Number(process.argv.includes('--keepRecentOpen') ? process.argv[process.argv.indexOf('--keepRecentOpen') + 1] : 200);
const archivePath = process.argv.includes('--archivePath') ? process.argv[process.argv.indexOf('--archivePath') + 1] : 'data/trader_state_archive.jsonl';
const outEvents = process.argv.includes('--outEvents') ? process.argv[process.argv.indexOf('--outEvents') + 1] : 'data/recovery_events.jsonl';

const ts = () => new Date().toISOString();
const event = async (type, payload = {}) => {
  await appendFile(outEvents, JSON.stringify({ ts: ts(), type, ...payload }) + '\n', 'utf8');
};

async function main() {
  const state = await loadTradeState();
  const res = await compactTradeState({ state, archivePath, keepRecentOpen, onEvent: event });
  await saveTradeState(res.state);
  console.log(JSON.stringify({ ok: true, archived_count: res.archivedCount, kept_open_count: res.keptOpenCount, archive_path: archivePath }, null, 2));
}

main().catch((e) => {
  console.error(e?.message || String(e));
  process.exit(1);
});
