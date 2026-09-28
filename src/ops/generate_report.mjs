#!/usr/bin/env node
/**
 * Post-Run Reconciliation Report Generator
 * Generates a report after live canary run
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = process.env.RUN_ID || `canary_${Date.now()}`;
const RUN_DIR_RAW = process.env.RUN_DIR || `./runs/${RUN_ID}`;
const DATA_DIR = (() => {
  const configured = process.env.DATA_DIR || './data';
  return path.isAbsolute(configured) ? configured : path.resolve(SCRIPT_DIR, configured);
})();
const RUN_DIR = (() => {
  return path.isAbsolute(RUN_DIR_RAW) ? RUN_DIR_RAW : path.resolve(SCRIPT_DIR, RUN_DIR_RAW);
})();
const PYTHON_BIN = process.env.POLY_PYTHON || '.venv-clob/bin/python3';
const BRIDGE_PATH = path.join(SCRIPT_DIR, 'execution/live_gateway_bridge.py');

function warnRunDirIfLikelyDuplicated() {
  if (path.isAbsolute(RUN_DIR_RAW)) return;
  const normalized = RUN_DIR_RAW.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const appPrefix = 'apps/polymarket-bot/';
  if (normalized === 'apps/polymarket-bot' || normalized.startsWith(appPrefix)) {
    console.warn(
      `[generate_report] warning: RUN_DIR="${RUN_DIR_RAW}" is relative and includes "apps/polymarket-bot/". ` +
      `Resolved path is "${RUN_DIR}". Prefer "./runs/..." or an absolute path.`
    );
  }
}

function bridgeCall(action, payload = {}) {
  return new Promise((resolve, reject) => {
    const python = spawn(PYTHON_BIN, [
      BRIDGE_PATH,
      action,
      JSON.stringify(payload)
    ], { cwd: SCRIPT_DIR, env: { ...process.env } });
    
    let stdout = '';
    let stderr = '';
    python.stdout.on('data', d => stdout += d);
    python.stderr.on('data', d => stderr += d);
    python.on('close', () => {
      try { resolve(JSON.parse(stdout)); } catch { resolve({ ok: false, error: stdout || stderr }); }
    });
  });
}

function resolveEventsPath() {
  const pointerPath = path.join(DATA_DIR, 'current_events_path.txt');
  try {
    const target = fs.readFileSync(pointerPath, 'utf-8').trim();
    if (target) {
      if (path.isAbsolute(target) && fs.existsSync(target)) return target;
      const candidateBases = [path.dirname(DATA_DIR), DATA_DIR, SCRIPT_DIR];
      for (const base of candidateBases) {
        const candidate = path.resolve(base, target);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {}

  const fallbacks = [
    path.join(DATA_DIR, 'events.jsonl'),
    path.join(DATA_DIR, 'paper_trading_realtime_events.jsonl'),
    path.join(DATA_DIR, 'live_canary_3m_auto_events.jsonl'),
  ];
  for (const candidate of fallbacks) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return fallbacks[0];
}

async function generateReport() {
  warnRunDirIfLikelyDuplicated();
  const timestamp = new Date().toISOString();
  
  // Get exchange data
  let exchangeBalance = null;
  let exchangePositions = {};
  
  try {
    const bal = await bridgeCall('balance', {});
    if (bal.ok) exchangeBalance = parseFloat(bal.balance) / 1e6;
    
    const pos = await bridgeCall('get_positions', {});
    if (pos.ok) exchangePositions = pos.positions || {};
  } catch (e) {
    console.error('Bridge error:', e.message);
  }
  
  // Get bot state
  let botState = {};
  try {
    botState = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'trader_state.json'), 'utf-8'));
  } catch (e) {}
  
  // Get events
  let events = [];
  try {
    const eventsPath = resolveEventsPath();
    const content = fs.readFileSync(eventsPath, 'utf-8');
    events = content.trim().split('\n').map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch (e) {}
  
  // Analyze events
  const submitEvents = events.filter(e => e.type?.includes('SUBMIT'));
  const fillEvents = events.filter(e => e.type?.includes('FILLED'));
  const cancelEvents = events.filter(e => e.type?.includes('CANCELED'));
  const errorEvents = events.filter(e => e.type?.includes('ERROR') || e.type?.includes('FAILED'));
  
  // Holdings analysis
  const holdings = botState.exposure_ledger?.holdings || {};
  const exchangeHoldings = {};
  for (const [k, v] of Object.entries(exchangePositions)) {
    const net = (v.yes || 0) - (v.no || 0);
    if (Math.abs(net) > 0.001) exchangeHoldings[k] = net;
  }
  
  // Check exposure consistency
  let exposureConsistent = true;
  for (const asset of new Set([...Object.keys(holdings), ...Object.keys(exchangeHoldings)])) {
    const botQty = Math.abs(holdings[asset] || 0);
    const exchQty = Math.abs(exchangeHoldings[asset] || 0);
    if (Math.abs(botQty - exchQty) > 0.001) {
      exposureConsistent = false;
      break;
    }
  }
  
  // Cash consistency (check if balance changed significantly)
  const initialCash = 1000;
  const currentCash = botState.cash || 1000;
  const cashDrift = Math.abs(currentCash - initialCash);
  
  // Unresolved orders
  const intents = botState.intents || {};
  const unresolvedOrders = Object.values(intents).filter(o => {
    const s = String(o.status || '').toLowerCase();
    return !['filled', 'canceled', 'rejected', 'expired'].includes(s);
  }).length;
  
  const report = {
    run_id: RUN_ID,
    timestamp,
    summary: {
      total_orders: submitEvents.length,
      matched_orders: fillEvents.length,
      canceled_orders: cancelEvents.length,
      execution_errors: errorEvents.length,
    },
    execution: {
      avg_slippage: 0, // Would need fill price comparison
      error_rate: submitEvents.length > 0 ? errorEvents.length / submitEvents.length : 0,
    },
    financials: {
      initial_cash: initialCash,
      final_cash: currentCash,
      cash_drift: cashDrift,
      exchange_balance: exchangeBalance,
    },
    consistency: {
      exposure_consistent: exposureConsistent,
      cash_consistent: cashDrift < 1, // Allow 1 USDC drift
      unresolved_orders: unresolvedOrders,
    },
    state: {
      halted: botState.halted || false,
      halt_reason: botState.halt_reason || null,
      holdings_count: Object.keys(holdings).filter(k => Math.abs(holdings[k]) > 0.001).length,
      exchange_holdings_count: Object.keys(exchangeHoldings).length,
    },
    success: !botState.halted && exposureConsistent && cashDrift < 1 && unresolvedOrders === 0,
  };
  
  const reportPath = path.join(RUN_DIR, 'post_run_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  
  console.log(`Report saved to: ${reportPath}`);
  console.log(JSON.stringify(report, null, 2));
  
  return report;
}

generateReport().catch(console.error);
