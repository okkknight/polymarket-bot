#!/usr/bin/env node
import { access, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLiveGatewayConfig } from '../core/execution/live_config_guard.mjs';

const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'data/live_preflight_report.json';
const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(RUNNER_DIR, '..', '..');

async function fileExists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

function mask(v) {
  if (!v) return null;
  if (v.length <= 8) return '***';
  return `${v.slice(0,4)}...${v.slice(-4)}`;
}

async function main() {
  const cfg = {
    apiKey: process.env.POLY_CLOB_API_KEY || '',
    apiSecret: process.env.POLY_CLOB_API_SECRET || '',
    apiPassphrase: process.env.POLY_CLOB_API_PASSPHRASE || '',
    privateKey: process.env.PRIVATE_KEY || '',
    baseUrl: process.env.POLY_CLOB_BASE_URL || 'https://clob.polymarket.com',
    orderPath: process.env.POLY_CLOB_ORDER_PATH || '/order',
    orderStatusPath: process.env.POLY_CLOB_ORDER_STATUS_PATH || '/order/{orderId}',
    accountOwner: process.env.POLY_ACCOUNT_OWNER || process.env.POLY_FUNDER || '',
    funder: process.env.POLY_FUNDER || '',
  };

  const cfgCheck = validateLiveGatewayConfig(cfg);

  const localChecks = {
    recovery_script: await fileExists(resolve(APP_ROOT, 'ops/scripts/start_polymarket_live_recoverable.sh')),
    state_file: await fileExists(resolve(APP_ROOT, 'data/trader_state.json')),
    risk_module: await fileExists(resolve(APP_ROOT, 'src/core/risk/live_guardrails.mjs')),
    gateway_module: await fileExists(resolve(APP_ROOT, 'src/core/execution/live_execution_gateway.mjs')),
  };

  const ready = cfgCheck.ok && Object.values(localChecks).every(Boolean);

  const report = {
    ts: new Date().toISOString(),
    ready,
    summary: ready ? 'live_preflight_pass' : 'live_preflight_blocked',
    config: {
      baseUrl: cfg.baseUrl,
      orderPath: cfg.orderPath,
      orderStatusPath: cfg.orderStatusPath,
      apiKey_present: Boolean(cfg.apiKey),
      apiSecret_present: Boolean(cfg.apiSecret),
      apiPassphrase_present: Boolean(cfg.apiPassphrase),
      privateKey_present: Boolean(cfg.privateKey),
      accountOwner_present: Boolean(cfg.accountOwner),
      accountOwner_masked: mask(cfg.accountOwner),
      funder_present: Boolean(cfg.funder),
      funder_masked: mask(cfg.funder),
      config_issues: cfgCheck.issues,
    },
    localChecks,
    nextActions: ready
      ? ['Run tiny-capital live canary with strict risk guardrails']
      : [
          'Set PRIVATE_KEY + POLY_CLOB_API_KEY + POLY_CLOB_API_SECRET + POLY_CLOB_API_PASSPHRASE',
          'Verify POLY_CLOB_BASE_URL / POLY_CLOB_ORDER_PATH / POLY_CLOB_ORDER_STATUS_PATH',
          'Re-run preflight',
        ],
  };

  await writeFile(out, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
  process.exit(ready ? 0 : 2);
}

main().catch((e) => {
  console.error(e?.message || String(e));
  process.exit(1);
});
