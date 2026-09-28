import assert from 'node:assert/strict';
import { validateLiveGatewayConfig } from '../src/core/execution/live_config_guard.mjs';

const base = {
  apiKey: 'api-key',
  apiSecret: 'api-secret',
  apiPassphrase: 'passphrase',
  privateKey: 'private-key',
  baseUrl: 'https://clob.polymarket.com',
  orderPath: '/order',
  orderStatusPath: '/order/{orderId}',
};

assert.deepEqual(validateLiveGatewayConfig(base), {
  ok: false,
  issues: ['missing_account_owner', 'missing_funder'],
});

assert.deepEqual(validateLiveGatewayConfig({
  ...base,
  accountOwner: '0x1111000000000000000000000000000000000000',
  funder: '0x1111000000000000000000000000000000000000',
}), {
  ok: true,
  issues: [],
});

assert.deepEqual(validateLiveGatewayConfig({
  ...base,
  accountOwner: 'not-an-address',
  funder: '0x1111000000000000000000000000000000000000',
}).issues, ['invalid_account_owner']);

assert.deepEqual(validateLiveGatewayConfig({
  ...base,
  accountOwner: '0x1111000000000000000000000000000000000000',
  funder: '0x2222000000000000000000000000000000000000',
}).issues, ['account_owner_funder_mismatch']);

console.log('PASS test_live_config_guard');
