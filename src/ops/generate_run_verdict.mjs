#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolveAppRoot();
const DATA_DIR = resolveDataDir();
const SUMMARY_PATH = getArg('--summaryPath') || path.join(DATA_DIR, 'last_run_summary.json');
const VERDICT_PATH = getArg('--verdictPath') || path.join(DATA_DIR, 'run_verdict.json');
const EXIT_CODE = toInt(getArg('--exitCode'), 0);

function getArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1];
}

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveAppRoot() {
  const raw = getArg('--appRoot');
  if (!raw) return SCRIPT_DIR;
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function resolveDataDir() {
  const configured = process.env.DATA_DIR || 'data';
  if (path.isAbsolute(configured)) return configured;
  return path.resolve(APP_ROOT, configured);
}

function readJsonl(filepath) {
  if (!fs.existsSync(filepath)) return [];
  const content = fs.readFileSync(filepath, 'utf-8');
  const lines = content.split('\n').map(line => line.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
    }
  }
  return out;
}

function findLast(events, predicate) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (predicate(event)) return event;
  }
  return null;
}

function findLastIndex(events, predicate) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (predicate(event)) return index;
  }
  return -1;
}

function hasWord(text, keyword) {
  return String(text || '').toLowerCase().includes(String(keyword || '').toLowerCase());
}

function getRunWindow(allEvents) {
  const lastStartIndex = findLastIndex(allEvents, (event) => event?.type === 'RUNNER_START');
  if (lastStartIndex >= 0) {
    const runStart = allEvents[lastStartIndex];
    return {
      runId: runStart?.run_id || null,
      runEvents: allEvents.slice(lastStartIndex),
    };
  }
  return {
    runId: null,
    runEvents: allEvents,
  };
}

function getLatestRecoveryWindow(allRecoveryEvents) {
  const lastRecoveryStartIndex = findLastIndex(allRecoveryEvents, (event) => event?.type === 'RECOVERY_STARTED');
  if (lastRecoveryStartIndex >= 0) {
    return allRecoveryEvents.slice(lastRecoveryStartIndex);
  }
  return allRecoveryEvents;
}

function parseExchangeTradesDelta(runEvents, summaryEvent, finalEvent) {
  const direct = toInt(
    summaryEvent?.exchange_trades_delta ?? finalEvent?.exchange_trades_delta,
    Number.NaN
  );
  if (Number.isFinite(direct)) return direct;

  const afterEvent = findLast(runEvents, (event) => event?.type === 'RUNNER_EXCHANGE_TRADES_AFTER');
  const beforeEvent = findLast(runEvents, (event) => event?.type === 'RUNNER_EXCHANGE_TRADES_BEFORE');
  const directAfter = toInt(afterEvent?.exchange_trades_delta, Number.NaN);
  if (Number.isFinite(directAfter)) return directAfter;

  const afterCount = toInt(afterEvent?.trades_count, Number.NaN);
  const beforeCount = toInt(beforeEvent?.trades_count, Number.NaN);
  if (Number.isFinite(afterCount) && Number.isFinite(beforeCount)) return afterCount - beforeCount;
  return 0;
}

function parseUnconfirmedCount(recoveryWindow, recoveryFailure, recoveryClassification) {
  const unconfirmedEvent = findLast(
    recoveryWindow,
    (event) => event?.type === 'EXPOSURE_SYNC_UNCONFIRMED_HOLDINGS'
  );
  const fromEvent = toInt(unconfirmedEvent?.unconfirmed_count, Number.NaN);
  if (Number.isFinite(fromEvent)) return fromEvent;

  const unmanaged = toInt(recoveryClassification?.unmanaged_historical, Number.NaN);
  const recovered = toInt(recoveryClassification?.recovered_from_exchange, Number.NaN);
  if (Number.isFinite(unmanaged) || Number.isFinite(recovered)) {
    return (Number.isFinite(unmanaged) ? unmanaged : 0) + (Number.isFinite(recovered) ? recovered : 0);
  }

  if (hasWord(recoveryFailure?.reason, 'unconfirmed')) return 1;
  return 0;
}

function buildVerdict() {
  const eventsPath = path.join(DATA_DIR, 'live_canary_3m_auto_events.jsonl');
  const recoveryPath = path.join(DATA_DIR, 'recovery_events.jsonl');
  const allEvents = readJsonl(eventsPath);
  const allRecoveryEvents = readJsonl(recoveryPath);

  const { runId: startedRunId, runEvents } = getRunWindow(allEvents);
  const recoveryWindow = getLatestRecoveryWindow(allRecoveryEvents);

  const summaryEvent = findLast(runEvents, (event) => event?.type === 'RUNNER_SUMMARY') || {};
  const finalEvent = findLast(runEvents, (event) => event?.type === 'FINAL_RESULT') || {};
  const orderFilledEvent = findLast(runEvents, (event) => event?.type === 'ORDER_FILLED');

  const recoveryFailure = findLast(recoveryWindow, (event) => event?.type === 'RECOVERY_FAILED');
  const recoveryResumed = findLast(recoveryWindow, (event) => event?.type === 'RECOVERY_RESUMED');
  const recoveryClassification = findLast(
    recoveryWindow,
    (event) => event?.type === 'EXPOSURE_SYNC_CLASSIFICATION'
  ) || {};

  const postReconcileOk = !recoveryFailure;
  const failReason = recoveryFailure?.reason || null;
  const unconfirmedCount = parseUnconfirmedCount(recoveryWindow, recoveryFailure, recoveryClassification);

  const localOrdersCount = toInt(summaryEvent?.orders_count ?? finalEvent?.orders_count, 0);
  const localTotalTrades = toInt(summaryEvent?.total_trades, 0);
  const hasOrderFilledEvent = Boolean(orderFilledEvent);

  const exchangeTradesDelta = parseExchangeTradesDelta(runEvents, summaryEvent, finalEvent);
  const exchangeBalanceDelta = toNumber(
    summaryEvent?.exchange_cash_delta ?? summaryEvent?.exchange_balance_delta,
    null
  );
  const exchangeHasConfirmedFill = Boolean(
    finalEvent?.real_fill || summaryEvent?.real_fill || exchangeTradesDelta > 0
  );

  const realFill = hasOrderFilledEvent || exchangeHasConfirmedFill || exchangeTradesDelta > 0;

  let exposureMatchStatus = 'DELAYED';
  if (postReconcileOk && unconfirmedCount === 0) {
    exposureMatchStatus = 'MATCHED';
  } else if (!postReconcileOk || unconfirmedCount > 0 || hasWord(failReason, 'unconfirmed')) {
    exposureMatchStatus = 'MISMATCH';
  } else if (realFill) {
    exposureMatchStatus = 'DELAYED';
  }

  const localHasFill = hasOrderFilledEvent || localTotalTrades > 0;
  const exchangeHasFill = exchangeHasConfirmedFill || exchangeTradesDelta > 0;
  let consistencyStatus = 'CONFLICT';
  if (localHasFill === exchangeHasFill) {
    consistencyStatus = 'CONSISTENT';
  } else if (exchangeHasFill && !localHasFill) {
    consistencyStatus = 'DELAYED_BACKFILL';
  }

  let action = 'CONTINUE';
  if (exposureMatchStatus === 'MISMATCH' || EXIT_CODE !== 0 || (recoveryFailure && !recoveryResumed)) {
    action = 'HALT';
  } else if (exposureMatchStatus === 'DELAYED' || consistencyStatus === 'DELAYED_BACKFILL') {
    action = 'WATCH';
  }

  const nowIso = new Date().toISOString();
  const runId = finalEvent?.run_id || summaryEvent?.run_id || startedRunId || `run_${Date.now()}`;
  const ts = summaryEvent?.ts || finalEvent?.ts || recoveryFailure?.ts || recoveryResumed?.ts || nowIso;

  const summary = {
    run_id: runId,
    ts,
    exit_code: EXIT_CODE,
    orders_count: localOrdersCount,
    total_trades: localTotalTrades,
    markets_traded: summaryEvent?.markets_traded || [],
    real_fill: realFill,
    consistency_status: consistencyStatus,
    action,
    last_fill: orderFilledEvent
      ? {
          ts: orderFilledEvent.ts || null,
          client_order_id: orderFilledEvent.client_order_id || null,
          fill_size: orderFilledEvent.fill_size ?? null,
          fill_price: orderFilledEvent.fill_price ?? null,
        }
      : null,
    post_reconcile_ok: postReconcileOk,
    post_reconcile_fail_reason: failReason,
    unconfirmed_count: unconfirmedCount,
    exchange_trades_delta: exchangeTradesDelta,
    exchange_balance_delta: exchangeBalanceDelta,
  };

  const verdict = {
    run_id: runId,
    ts,
    exit_code: EXIT_CODE,
    local: {
      orders_count: localOrdersCount,
      total_trades: localTotalTrades,
      has_order_filled_event: hasOrderFilledEvent,
    },
    exchange: {
      trades_delta: exchangeTradesDelta,
      balance_delta: exchangeBalanceDelta,
      has_confirmed_fill: exchangeHasConfirmedFill,
    },
    reconcile: {
      post_reconcile_ok: postReconcileOk,
      fail_reason: failReason,
      unconfirmed_count: unconfirmedCount,
    },
    verdict: {
      real_fill: realFill,
      exposure_match_status: exposureMatchStatus,
      consistency_status: consistencyStatus,
      action,
    },
  };

  return { summary, verdict };
}

function saveJson(filepath, value) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify(value, null, 2));
}

function main() {
  const { summary, verdict } = buildVerdict();
  saveJson(SUMMARY_PATH, summary);
  saveJson(VERDICT_PATH, verdict);
  console.log(`FINAL_RESULT ${JSON.stringify(summary)}`);
  console.log(`RUN_VERDICT ${JSON.stringify(verdict)}`);
}

main();
