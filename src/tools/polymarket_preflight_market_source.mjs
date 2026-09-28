#!/usr/bin/env node

const GAMMA = 'https://gamma-api.polymarket.com/markets';

const slugPrefix = process.argv.includes('--slugPrefix') ? process.argv[process.argv.indexOf('--slugPrefix') + 1] : 'btc-updown-5m';
const timeoutMs = Number(process.argv.includes('--timeoutMs') ? process.argv[process.argv.indexOf('--timeoutMs') + 1] : 10000);

function floorTo5mEpochSec(nowSec) { return Math.floor(nowSec / 300) * 300; }
function candidateSlugs(nowMs = Date.now()) {
  const t = floorTo5mEpochSec(Math.floor(nowMs / 1000));
  return [`${slugPrefix}-${t-300}`, `${slugPrefix}-${t}`, `${slugPrefix}-${t+300}`];
}

async function fetchJson(url, timeout = timeoutMs) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(url, { signal: c.signal });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { j = null; }
    return { ok: r.ok, status: r.status, json: j, text };
  } finally { clearTimeout(t); }
}

async function main() {
  const slugs = candidateSlugs();
  const checks = [];

  for (const slug of slugs) {
    const direct = await fetchJson(`${GAMMA}?slug=${encodeURIComponent(slug)}`);
    const directCount = Array.isArray(direct.json) ? direct.json.length : 0;

    const broad = await fetchJson(`${GAMMA}?limit=200&active=true`);
    const broadList = Array.isArray(broad.json) ? broad.json : [];
    const broadCount = broadList.filter((m) => String(m?.slug || '') === slug).length;

    checks.push({
      slug,
      direct_ok: direct.ok,
      direct_status: direct.status,
      direct_count: directCount,
      broad_ok: broad.ok,
      broad_status: broad.status,
      broad_match_count: broadCount,
    });
  }

  const anyUsable = checks.some((c) => c.direct_count > 0 || c.broad_match_count > 0);
  const summary = {
    ts: new Date().toISOString(),
    usable: anyUsable,
    slugs,
    checks,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(anyUsable ? 0 : 2);
}

main().catch((e) => {
  console.error(e?.message || String(e));
  process.exit(1);
});
