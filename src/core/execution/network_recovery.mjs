export function nextBackoffMs({ failCount, baseMs = 1000, maxMs = 15000 }) {
  const n = Math.max(1, Number(failCount || 1));
  const raw = baseMs * (2 ** (n - 1));
  return Math.min(maxMs, raw);
}

export function classifyNetworkError(err) {
  const s = String(err?.message || err || '').toLowerCase();
  if (s.includes('timeout') || s.includes('abort')) return 'timeout';
  if (s.includes('fetch failed') || s.includes('econn') || s.includes('network')) return 'network';
  if (s.includes('http 5')) return 'server_5xx';
  if (s.includes('http 4')) return 'client_4xx';
  return 'unknown';
}

export function shouldSafeHaltByNetwork({ consecutiveFailures, threshold = 3 }) {
  return Number(consecutiveFailures || 0) >= Number(threshold || 3);
}
