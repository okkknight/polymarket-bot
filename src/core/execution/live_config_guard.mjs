export function validateLiveGatewayConfig({ apiKey, apiSecret, apiPassphrase, privateKey, baseUrl, orderPath, orderStatusPath, accountOwner, funder }) {
  const issues = [];
  if (!baseUrl) issues.push('missing_base_url');
  if (!orderPath) issues.push('missing_order_path');
  if (!orderStatusPath) issues.push('missing_order_status_path');
  if (!apiKey) issues.push('missing_api_key');
  if (!apiSecret) issues.push('missing_api_secret');
  if (!apiPassphrase) issues.push('missing_api_passphrase');
  if (!privateKey) issues.push('missing_private_key');
  const normalizedOwner = String(accountOwner || '').trim();
  const normalizedFunder = String(funder || '').trim();
  if (!normalizedOwner) issues.push('missing_account_owner');
  else if (!/^0x[a-fA-F0-9]{40}$/.test(normalizedOwner)) issues.push('invalid_account_owner');
  if (!normalizedFunder) issues.push('missing_funder');
  else if (!/^0x[a-fA-F0-9]{40}$/.test(normalizedFunder)) issues.push('invalid_funder');
  else if (/^0x[a-fA-F0-9]{40}$/.test(normalizedOwner) && normalizedOwner.toLowerCase() !== normalizedFunder.toLowerCase()) issues.push('account_owner_funder_mismatch');
  return { ok: issues.length === 0, issues };
}

export function validateOrderIntentPayload(intent) {
  const issues = [];
  if (!intent?.client_order_id) issues.push('missing_client_order_id');
  if (!intent?.token_id) issues.push('missing_token_id');
  if (!intent?.side) issues.push('missing_side');
  if (!(Number(intent?.size) > 0)) issues.push('invalid_size');
  if (!(Number(intent?.limit_price) > 0)) issues.push('invalid_limit_price');
  if (!Number.isFinite(Number(intent?.expiration))) issues.push('invalid_expiration');
  return { ok: issues.length === 0, issues };
}

export function mapLiveGatewayError(err) {
  const s = String(err?.message || err || '').toLowerCase();
  if (s.includes('401') || s.includes('403') || s.includes('api_key') || s.includes('auth')) return 'auth_error';
  if (s.includes('400') || s.includes('422') || s.includes('invalid_')) return 'request_error';
  if (s.includes('429')) return 'rate_limited';
  if (s.includes('timeout') || s.includes('abort')) return 'timeout';
  if (s.includes('fetch failed') || s.includes('econn') || s.includes('network')) return 'network';
  if (s.includes('500') || s.includes('502') || s.includes('503') || s.includes('504')) return 'server_5xx';
  return 'unknown';
}
