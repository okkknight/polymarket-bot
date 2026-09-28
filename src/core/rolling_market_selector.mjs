export function floorTo5mEpochSec(nowSec) {
  return Math.floor(nowSec / 300) * 300;
}

export function buildRollingSlugCandidates(slugPrefix, nowMs = Date.now()) {
  const nowSec = Math.floor(nowMs / 1000);
  const t = floorTo5mEpochSec(nowSec);
  return [`${slugPrefix}-${t - 300}`, `${slugPrefix}-${t}`, `${slugPrefix}-${t + 300}`];
}

export async function selectFirstTradableRollingMarket({
  slugPrefix = 'btc-updown-5m',
  nowMs = Date.now(),
  fetchMarketsBySlug,
  resolveYesNoFromMarket,
  probeMidpoint,
  isClosed,
  onLog,
}) {
  const slugs = buildRollingSlugCandidates(slugPrefix, nowMs);

  for (const slug of slugs) {
    let markets = [];
    try {
      markets = await fetchMarketsBySlug(slug);
    } catch (err) {
      await onLog?.(`SELECTOR_FETCH_SLUG_ERROR slug=${slug} err=${JSON.stringify(err?.message || String(err))}`);
      continue;
    }

    for (const m of markets || []) {
      try {
        if (isClosed?.(m)) continue;
        const r = resolveYesNoFromMarket(m);
        if (!r?.yesTokenId || !r?.noTokenId) continue;

        const yesMid = await probeMidpoint(r.yesTokenId);
        const noMid = await probeMidpoint(r.noTokenId);
        if (!Number.isFinite(yesMid) || !Number.isFinite(noMid)) continue;

        return {
          market: m,
          slug,
          yesTokenId: r.yesTokenId,
          noTokenId: r.noTokenId,
          yesMid,
          noMid,
          slugs,
        };
      } catch (err) {
        await onLog?.(`SELECTOR_SKIP_MARKET marketId=${m?.id ?? 'N/A'} slug=${slug} err=${JSON.stringify(err?.message || String(err))}`);
      }
    }
  }

  return null;
}
