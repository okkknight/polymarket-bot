import assert from 'node:assert/strict';
import { claimExecutionReadiness, claimKeyFor, isDefinitiveSubmitRejection, builderCredentialFingerprint } from '../src/ops/auto_claim_worker.mjs';
import { readFile } from 'node:fs/promises';

assert.deepEqual(claimExecutionReadiness({}), {
  ok: false,
  missing: ['POLYMARKET_RELAYER_URL', 'POLYMARKET_RELAYER_API_KEY', 'POLYMARKET_RELAYER_API_KEY_ADDRESS'],
  approval_present: false,
});

assert.equal(
  claimKeyFor({ condition_id: '0xcondition', asset_id: 'asset-1' }),
  '0xcondition:asset-1',
);
assert.equal(isDefinitiveSubmitRejection('RelayerApiException[status_code=401, error_message=invalid authorization]'), true);
assert.equal(isDefinitiveSubmitRejection('HTTP Error 403: Forbidden'), true);
assert.equal(isDefinitiveSubmitRejection('network timeout'), false);
assert.equal(builderCredentialFingerprint({}), null);
assert.equal(builderCredentialFingerprint({ POLYMARKET_RELAYER_API_KEY: 'test-key' }).length, 16);

const workerSource = await readFile(new URL('../src/ops/auto_claim_worker.mjs', import.meta.url), 'utf8');
assert.match(workerSource, /CLAIM_MAX_SUBMITS_PER_RUN \|\| 1/);
assert.match(workerSource, /CLAIM_SUBMISSION_STOPPED/);
assert.match(workerSource, /--reconcile-only/);
assert.match(workerSource, /CLAIM_REJECTED_CREDENTIAL_ROTATED/);

console.log('PASS test_claim_worker_safety');
