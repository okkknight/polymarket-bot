#!/usr/bin/env node
/**
 * Pre-Run Snapshot Generator
 * Generates a snapshot before live canary run
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = (() => {
  const configured = process.env.DATA_DIR || './data';
  return path.isAbsolute(configured) ? configured : path.resolve(SCRIPT_DIR, configured);
})();
const RUN_ID = process.env.RUN_ID || `canary_${Date.now()}`;
const RUN_DIR_RAW = process.env.RUN_DIR || `./runs/${RUN_ID}`;
const RUN_DIR = path.isAbsolute(RUN_DIR_RAW) ? RUN_DIR_RAW : path.resolve(SCRIPT_DIR, RUN_DIR_RAW);
const PYTHON_BIN = process.env.POLY_PYTHON || path.join(SCRIPT_DIR, '.venv-clob/bin/python3');
const BRIDGE_PATH = path.join(SCRIPT_DIR, 'execution/live_gateway_bridge.py');

function warnRunDirIfLikelyDuplicated() {
  if (path.isAbsolute(RUN_DIR_RAW)) return;
  const normalized = RUN_DIR_RAW.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const appPrefix = 'apps/polymarket-bot/';
  if (normalized === 'apps/polymarket-bot' || normalized.startsWith(appPrefix)) {
    console.warn(
      `[generate_snapshot] warning: RUN_DIR="${RUN_DIR_RAW}" is relative and includes "apps/polymarket-bot/". ` +
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

async function generateSnapshot() {
  warnRunDirIfLikelyDuplicated();
  // Create run directory
  fs.mkdirSync(RUN_DIR, { recursive: true });
  
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
  
  // Count holdings
  const holdings = botState.exposure_ledger?.holdings || {};
  const holdingsCount = Object.keys(holdings).filter(k => Math.abs(holdings[k] || 0) > 0.001).length;
  
  // Config hash
  const configHash = crypto.createHash('sha256')
    .update(JSON.stringify({
      max_capital_used: 20,
      max_single_order: 1,
      max_concurrent_positions: 5,
      max_runtime_minutes: 30,
      max_orders: 20,
      max_slippage_bps: 10,
    }))
    .digest('hex').slice(0, 8);
  
  const snapshot = {
    run_id: RUN_ID,
    timestamp,
    exchange: {
      balance: exchangeBalance,
      holdings_count: Object.keys(exchangePositions).filter(k => {
        const p = exchangePositions[k];
        return Math.abs((p.yes || 0) - (p.no || 0)) > 0.001;
      }).length,
    },
    bot: {
      cash: botState.cash || 1000,
      halted: botState.halted || false,
      holdings_count: holdingsCount,
      intents_count: Object.keys(botState.intents || {}).length,
    },
    exposure: {
      holdings_count: holdingsCount,
      confirmed_count: Object.values(botState.exposure_ledger?.source_by_asset || {}).filter(s => s === 'recovered_from_exchange_confirmed').length,
      sync_status: 'pre_run',
    },
    config: {
      max_capital_used: 20,
      max_single_order: 1,
      max_concurrent_positions: 5,
      max_runtime_minutes: 30,
      max_orders: 20,
      max_slippage_bps: 10,
    },
    config_hash: configHash,
    strategy_version: 'micro_canary_v1',
  };
  
  const snapshotPath = path.join(RUN_DIR, 'pre_run_snapshot.json');
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  
  console.log(`Snapshot saved to: ${snapshotPath}`);
  console.log(JSON.stringify(snapshot, null, 2));
  
  return snapshot;
}

generateSnapshot().catch(console.error);
