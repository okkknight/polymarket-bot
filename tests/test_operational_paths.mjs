import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const acceptance = resolve(repoRoot, 'ops/scripts/run_verdict_center_v1_acceptance.sh');

const result = spawnSync('bash', [acceptance], {
  cwd: repoRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    RUN_VERDICT_ACCEPTANCE_PORT: '4568',
  },
});

assert.equal(
  result.status,
  0,
  `offline operational acceptance must run from the repository root\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
);
assert.match(result.stdout, /\[run-verdict-v1-acceptance\] PASS/);

const preflight = resolve(repoRoot, 'ops/scripts/preflight_strict_live.sh');
const blockedPreflight = spawnSync('bash', [preflight], {
  cwd: repoRoot,
  encoding: 'utf8',
  env: { ...process.env, POLY_PYTHON: '/definitely/missing/python3' },
});
assert.equal(blockedPreflight.status, 2);
assert.match(blockedPreflight.stdout, /POLY_PYTHON is not executable/);

const gatewaySource = await readFile(resolve(repoRoot, 'src/core/execution/live_execution_gateway.mjs'), 'utf8');
assert.match(gatewaySource, /\.\.\/\.\.\/\.\.\/execution\/live_gateway_bridge\.py/);
assert.match(gatewaySource, /\.\.\/\.\.\/\.\.\/\.venv-clob\/bin\/python3/);
assert.doesNotMatch(gatewaySource, /py_clob_client(?!_v2)/);

const regressionGateSource = await readFile(resolve(repoRoot, 'ops/scripts/run_live_canary_regression_gate.sh'), 'utf8');
assert.match(regressionGateSource, /LIVE_DRY_RUN="\$\{LIVE_DRY_RUN:-true\}"/);
assert.match(regressionGateSource, /REGRESSION_ALLOW_LIVE/);

const directCanarySource = await readFile(resolve(repoRoot, 'ops/scripts/run_live_canary_with_proxy.sh'), 'utf8');
assert.match(directCanarySource, /LIVE_DRY_RUN="\$\{LIVE_DRY_RUN:-true\}"/);
assert.match(directCanarySource, /--liveDryRun "\$LIVE_DRY_RUN"/);
assert.match(directCanarySource, /REGRESSION_ALLOW_LIVE/);
assert.match(directCanarySource, /check_polymarket_funds\.sh/);

const recoverableLauncherSource = await readFile(resolve(repoRoot, 'ops/scripts/start_polymarket_live_recoverable.sh'), 'utf8');
assert.match(recoverableLauncherSource, /LIVE_DRY_RUN="\$\{LIVE_DRY_RUN:-true\}"/);
assert.match(recoverableLauncherSource, /REGRESSION_ALLOW_LIVE/);

const strictSyncSource = await readFile(resolve(repoRoot, 'ops/scripts/run_live_canary_strict_sync.sh'), 'utf8');
assert.match(strictSyncSource, /RECOVERY_DRY_RUN="\$\{RECOVERY_DRY_RUN:-true\}"/);
assert.doesNotMatch(strictSyncSource, /polymarket_recovery_control\.mjs --dryRun false/);
assert.match(strictSyncSource, /--readOnly "\$RECOVERY_DRY_RUN"/);

const goNoGoSource = await readFile(resolve(repoRoot, 'ops/scripts/pre_live_go_no_go.sh'), 'utf8');
assert.match(goNoGoSource, /node --test tests\/test_convergence\.mjs/);
assert.match(goNoGoSource, /node --test tests\/test_execution_fix\.mjs/);
assert.match(goNoGoSource, /src\/core\/execution\/recovery_controller\.mjs/);
assert.doesNotMatch(goNoGoSource, /polymarket_recovery_control\.mjs --dryRun false/);
assert.match(goNoGoSource, /polymarket_recovery_control\.mjs --dryRun true --readOnly true/);

const strictPreflightSource = await readFile(resolve(repoRoot, 'ops/scripts/preflight_strict_live.sh'), 'utf8');
assert.match(strictPreflightSource, /polymarket_recovery_control\.mjs --dryRun true --readOnly true/);
assert.match(strictPreflightSource, /check_polymarket_funds\.sh/);
assert.doesNotMatch(strictPreflightSource, /preflight_polymarket_bridge_deposit\.sh/);
const strictRecoveryBlock = strictPreflightSource.split('# 0) Read-only pre-reconcile first.')[1].split('# 1) pUSD funds/allowance gate')[0];
assert.match(strictRecoveryBlock, /POLY_SIGNATURE_TYPE="\$POLY_SIGNATURE_TYPE"/);
assert.match(strictRecoveryBlock, /POLY_FUNDER="\$POLY_FUNDER"/);

for (const script of [
  'ops/scripts/preflight_strict_live.sh',
  'ops/scripts/run_live_canary_strict_sync.sh',
  'ops/scripts/run_live_canary_with_proxy.sh',
  'ops/scripts/run_shadow_with_proxy.sh',
  'ops/scripts/start_polymarket_live_recoverable.sh',
]) {
  const source = await readFile(resolve(repoRoot, script), 'utf8');
  assert.doesNotMatch(source, /:\-http:\/\/127\.0\.0\.1:7890/);
}

const recoverableSource = await readFile(resolve(repoRoot, 'ops/scripts/start_polymarket_live_recoverable.sh'), 'utf8');
assert.match(recoverableSource, /LIVE_DRY_RUN" != "true"/);
assert.match(recoverableSource, /check_polymarket_funds\.sh/);
assert.ok(
  recoverableSource.indexOf('POLY_SIGNATURE_TYPE="${POLY_SIGNATURE_TYPE:-2}"')
    < recoverableSource.indexOf('if [[ "$LIVE_DRY_RUN" != "true" ]]'),
  'recoverable funds gate must receive the default signature type before it runs',
);
assert.ok(
  recoverableSource.indexOf('POLY_FUNDER="${POLY_FUNDER:-}"')
    < recoverableSource.indexOf('if [[ "$LIVE_DRY_RUN" != "true" ]]'),
  'recoverable funds gate must receive the default funder before it runs',
);

const fundsGateSource = await readFile(resolve(repoRoot, 'ops/scripts/check_polymarket_funds.sh'), 'utf8');
assert.match(fundsGateSource, /required_micro_usdc/);
assert.match(fundsGateSource, /insufficient_balance_or_allowance/);
assert.match(fundsGateSource, /live_gateway_bridge\.py balance/);
assert.doesNotMatch(fundsGateSource, /py_clob_client/);

const claimPreflightSource = await readFile(resolve(repoRoot, 'ops/scripts/preflight_claim_relayer.sh'), 'utf8');
assert.match(claimPreflightSource, /claim_preflight/);
assert.doesNotMatch(claimPreflightSource, /claim_submit/);

const claimWorkerLauncherSource = await readFile(resolve(repoRoot, 'ops/scripts/run_auto_claim_worker.sh'), 'utf8');
assert.match(claimWorkerLauncherSource, /preflight_claim_relayer\.sh/);
assert.match(claimWorkerLauncherSource, /AUTO_CLAIM_ENABLED:-false/);

const adoptionLauncher = resolve(repoRoot, 'ops/scripts/adopt_exchange_holdings.sh');
const adoptionLauncherSource = await readFile(adoptionLauncher, 'utf8');
assert.match(adoptionLauncherSource, /ADOPT_EXCHANGE_HOLDINGS_APPROVED/);
assert.match(adoptionLauncherSource, /ADOPT_CURRENT_EXCHANGE_HOLDINGS/);
const blockedAdoption = spawnSync('bash', [adoptionLauncher], {
  cwd: repoRoot,
  encoding: 'utf8',
  env: { ...process.env, ADOPT_EXCHANGE_HOLDINGS_APPROVED: 'false' },
});
assert.equal(blockedAdoption.status, 2);
assert.match(blockedAdoption.stdout, /\[adopt-holdings\] blocked/);

const recoveryControlSource = await readFile(resolve(repoRoot, 'src/runners/polymarket_recovery_control.mjs'), 'utf8');
assert.match(recoveryControlSource, /const readOnly = process\.argv\.includes\('--readOnly'\)[\s\S]*: dryRun;/);
assert.match(recoveryControlSource, /if \(!readOnly\) await saveTradeState\(result\.state\)/);
assert.match(recoveryControlSource, /if \(!dryRun && readOnly\)/);

const recoveryControllerSource = await readFile(resolve(repoRoot, 'src/core/execution/recovery_controller.mjs'), 'utf8');
assert.doesNotMatch(recoveryControllerSource, /py_clob_client(?!_v2)/);

const canaryPreparationSource = await readFile(resolve(repoRoot, 'src/runners/polymarket_state_reset_for_canary.mjs'), 'utf8');
assert.doesNotMatch(canaryPreparationSource, /saveTradeState\(/);

const readOnlyFixtureDir = await mkdtemp(join(tmpdir(), 'polymarket-recovery-readonly-'));
try {
  const fixtureDataDir = join(readOnlyFixtureDir, 'data');
  const fixtureStatePath = join(fixtureDataDir, 'trader_state.json');
  const fixtureEventsPath = join(fixtureDataDir, 'recovery_events.jsonl');
  const fixtureState = '{"halted":false,"intents":{}}\n';
  const fixtureEvents = '{"type":"EXISTING"}\n';
  await mkdir(fixtureDataDir, { recursive: true });
  await writeFile(fixtureStatePath, fixtureState);
  await writeFile(fixtureEventsPath, fixtureEvents);

  const recoveryControl = resolve(repoRoot, 'src/runners/polymarket_recovery_control.mjs');
  const readOnlyRecovery = spawnSync('node', [recoveryControl, '--dryRun', 'true', '--readOnly', 'true'], {
    cwd: readOnlyFixtureDir,
    encoding: 'utf8',
    env: { ...process.env, RUN_VIA_SH: '1' },
  });
  assert.notEqual(readOnlyRecovery.status, null, 'read-only recovery process should exit');
  assert.equal(await readFile(fixtureStatePath, 'utf8'), fixtureState);
  assert.equal(await readFile(fixtureEventsPath, 'utf8'), fixtureEvents);
} finally {
  await rm(readOnlyFixtureDir, { recursive: true, force: true });
}

const dashboardPort = '4569';
const dashboardSource = await readFile(resolve(repoRoot, 'src/web/dashboard_api.mjs'), 'utf8');
assert.match(dashboardSource, /server\.listen\(PORT, '127\.0\.0\.1'/);
assert.doesNotMatch(dashboardSource, /\/api\/adopt/);
assert.doesNotMatch(dashboardSource, /Access-Control-Allow-Origin/);
const dashboard = spawn('node', ['src/web/dashboard_api.mjs'], {
  cwd: repoRoot,
  env: { ...process.env, DASHBOARD_PORT: dashboardPort, DATA_DIR: resolve(repoRoot, 'data') },
  stdio: 'ignore',
});
try {
  let response;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      response = await fetch(`http://127.0.0.1:${dashboardPort}/dashboard.html`);
      if (response.ok) break;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  assert.ok(response?.ok, 'dashboard.html should be served from the repository root');
  assert.match(await response.text(), /Polymarket/i);
  const mutation = await fetch(`http://127.0.0.1:${dashboardPort}/api/adopt`, { method: 'POST' });
  assert.equal(mutation.status, 405);
} finally {
  dashboard.kill('SIGTERM');
}

const liveRunnerSource = await readFile(resolve(repoRoot, 'src/runners/polymarket_paper_trading_realtime.mjs'), 'utf8');
assert.match(liveRunnerSource, /final_exchange_positions_inconclusive/);
assert.match(liveRunnerSource, /startsWith\('final_exchange_positions_inconclusive:'\)/);
assert.doesNotMatch(liveRunnerSource, /py_clob_client(?!_v2)/);

const claimWorkerSource = await readFile(resolve(repoRoot, 'src/ops/auto_claim_worker.mjs'), 'utf8');
assert.match(claimWorkerSource, /AUTO_CLAIM_ENABLED.*'false'/);
assert.match(claimWorkerSource, /CLAIM_EXECUTION_BLOCKED/);
assert.match(claimWorkerSource, /claim_key/);
assert.match(claimWorkerSource, /POLYMARKET_RELAYER_URL/);
assert.match(claimWorkerSource, /POLYMARKET_RELAYER_API_KEY/);
assert.match(claimWorkerSource, /CLAIM_EXECUTION_APPROVED/);

const bridgeDepositPreflight = resolve(repoRoot, 'ops/scripts/preflight_polymarket_bridge_deposit.sh');
const bridgeDepositSource = await readFile(bridgeDepositPreflight, 'utf8');
assert.match(bridgeDepositSource, /bridge\.polymarket\.com\/deposit/);
assert.match(bridgeDepositSource, /POLY_FUNDER/);
assert.doesNotMatch(bridgeDepositSource, /wrap\(|transfer\(|approve\(/);

const livePreflightSource = await readFile(resolve(repoRoot, 'src/runners/polymarket_live_preflight.mjs'), 'utf8');
assert.doesNotMatch(livePreflightSource, /apiKey_masked|apiSecret_masked|apiPassphrase_masked/);

console.log('PASS test_operational_paths');
