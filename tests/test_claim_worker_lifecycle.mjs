import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const repoRoot = new URL('..', import.meta.url).pathname;
const fixtureDir = await mkdtemp(join(tmpdir(), 'polymarket-claim-worker-'));
const dataDir = join(fixtureDir, 'data');
const mockBridge = join(fixtureDir, 'mock-python.mjs');
const countPath = join(fixtureDir, 'calls.json');

await mkdir(dataDir, { recursive: true });

await writeFile(mockBridge, `#!/usr/bin/env node
import fs from 'node:fs';
const action = process.argv[3];
const calls = fs.existsSync(process.env.MOCK_CLAIM_CALLS) ? JSON.parse(fs.readFileSync(process.env.MOCK_CLAIM_CALLS, 'utf8')) : [];
calls.push(action); fs.writeFileSync(process.env.MOCK_CLAIM_CALLS, JSON.stringify(calls));
if (action === 'get_claimable_markets') console.log(JSON.stringify({ok:true,claimable_markets:[{market_id:'0x'+'12'.repeat(32),condition_id:'0x'+'12'.repeat(32),asset_id:'asset-1',size:1,outcome:'Yes',outcome_index:0,negative_risk:false}]}));
else if (action === 'claim_submit') console.log(JSON.stringify({ok:true,transaction_id:'tx-1',transaction_hash:'0xhash',state:'STATE_NEW'}));
else if (action === 'claim_status') console.log(JSON.stringify({ok:true,transaction_id:'tx-1',state:'STATE_CONFIRMED',transaction_hash:'0xhash'}));
else console.log(JSON.stringify({ok:false,error:'unexpected_action'}));
`);
await chmod(mockBridge, 0o755);

const env = {
  ...process.env,
  DATA_DIR: dataDir,
  POLY_PYTHON: mockBridge,
  MOCK_CLAIM_CALLS: countPath,
  AUTO_CLAIM_ENABLED: 'true',
  CLAIM_EXECUTION_APPROVED: 'true',
  POLYMARKET_RELAYER_URL: 'https://relayer.example',
  POLYMARKET_RELAYER_API_KEY: 'test-key',
  POLYMARKET_RELAYER_API_KEY_ADDRESS: '0x1111000000000000000000000000000000000000',
};

try {
  let run = spawnSync('node', ['src/ops/auto_claim_worker.mjs', '--once'], { cwd: repoRoot, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  let state = JSON.parse(await readFile(join(dataDir, 'trader_state.json'), 'utf8'));
  assert.equal(state.claims.pending.length, 1);
  assert.equal(state.claims.pending[0].status, 'submitted');
  assert.equal(state.claims.pending[0].transaction_id, 'tx-1');
  assert.deepEqual(JSON.parse(await readFile(countPath, 'utf8')), ['get_claimable_markets', 'claim_submit']);

  run = spawnSync('node', ['src/ops/auto_claim_worker.mjs', '--once'], { cwd: repoRoot, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  state = JSON.parse(await readFile(join(dataDir, 'trader_state.json'), 'utf8'));
  assert.equal(state.claims.pending.length, 0);
  assert.equal(state.claims.completed.length, 1);
  assert.equal(state.claims.completed[0].transaction_id, 'tx-1');
  assert.deepEqual(JSON.parse(await readFile(countPath, 'utf8')), ['get_claimable_markets', 'claim_submit', 'claim_status', 'get_claimable_markets']);
} finally {
  await rm(fixtureDir, { recursive: true, force: true });
}

console.log('PASS test_claim_worker_lifecycle');
