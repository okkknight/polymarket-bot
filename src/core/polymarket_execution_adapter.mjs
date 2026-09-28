export function roundTo(x, n = 6) {
  const p = 10 ** n;
  return Math.round(Number(x) * p) / p;
}

export function buildOrderPayload({ tokenId, side = 'buy', price, size, expirationSec }) {
  return {
    token_id: String(tokenId),
    side: String(side),
    price: roundTo(price, 6),
    size: roundTo(size, 6),
    expiration: Number(expirationSec),
  };
}

export function simulateFillPrice({ midpoint, side = 'buy', slippageBps = 1 }) {
  const slip = Number(slippageBps) / 10000;
  const px = Number(midpoint);
  if (!Number.isFinite(px)) throw new Error('midpoint_invalid');
  return side === 'buy' ? px * (1 + slip) : px * (1 - slip);
}

export function buildShadowOrderFromSignal({ signal, market, yesPrice, noPrice, size, ttlSec = 120 }) {
  if (signal !== 'buy_yes' && signal !== 'buy_no') return null;
  const outcome = signal === 'buy_yes' ? 'yes' : 'no';
  const tokenId = outcome === 'yes' ? market?.yesToken : market?.noToken;
  const midpoint = outcome === 'yes' ? yesPrice : noPrice;
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = buildOrderPayload({
    tokenId,
    side: 'buy',
    price: midpoint,
    size,
    expirationSec: nowSec + ttlSec,
  });
  return { outcome, tokenId, midpoint, payload };
}

export function calcFillSlippageBps({ midpoint, fillPrice }) {
  const m = Number(midpoint);
  const f = Number(fillPrice);
  if (!Number.isFinite(m) || !Number.isFinite(f) || m === 0) return 0;
  return ((f - m) / m) * 10000;
}
