function isFinitePositive(n) {
  return Number.isFinite(Number(n)) && Number(n) > 0;
}

export function validateRuntimeConfig(cfg = {}) {
  const issues = [];
  const warnings = [];

  const mode = String(cfg.mode || 'paper');
  if (!['paper', 'shadow', 'live'].includes(mode)) issues.push('invalid_mode');

  if (!isFinitePositive(cfg.tickSec)) issues.push('invalid_tick_sec');
  if (!isFinitePositive(cfg.watchSec)) issues.push('invalid_watch_sec');
  if (!Number.isFinite(Number(cfg.durationSec)) || Number(cfg.durationSec) < 0) issues.push('invalid_duration_sec');
  if (!isFinitePositive(cfg.baseSize)) issues.push('invalid_base_size');
  if (!isFinitePositive(cfg.scaleFactor)) issues.push('invalid_scale_factor');
  if (!isFinitePositive(cfg.maxPosition)) issues.push('invalid_max_position');

  if (!Number.isFinite(Number(cfg.minOrderShares)) || Number(cfg.minOrderShares) < 0) issues.push('invalid_min_order_shares');
  if (!Number.isFinite(Number(cfg.minOrderUsd)) || Number(cfg.minOrderUsd) < 0) issues.push('invalid_min_order_usd');
  if (!isFinitePositive(cfg.maxOrderNotional)) issues.push('invalid_max_order_notional');
  if (!isFinitePositive(cfg.maxOrdersPerMinute)) issues.push('invalid_max_orders_per_minute');
  if (!isFinitePositive(cfg.dailyLossLimit)) issues.push('invalid_daily_loss_limit');
  if (!isFinitePositive(cfg.netFailThreshold)) issues.push('invalid_net_fail_threshold');
  if (!isFinitePositive(cfg.unresolvedOrderLimitMs)) issues.push('invalid_unresolved_order_limit_ms');
  if (!isFinitePositive(cfg.cooldownSec)) issues.push('invalid_cooldown_sec');

  // Hard incompatibilities that guarantee no-trade or unsafe behavior.
  if (Number(cfg.minOrderShares) > Number(cfg.maxPosition)) {
    issues.push('conflict_min_order_shares_gt_max_position');
  }

  const minQtyByUsdAtBestPrice = Number(cfg.minOrderUsd) / 0.99; // best-case outcome token price
  if (Number.isFinite(minQtyByUsdAtBestPrice) && minQtyByUsdAtBestPrice > Number(cfg.maxPosition)) {
    issues.push('conflict_min_order_usd_gt_max_position_capacity');
  }

  if (Number(cfg.maxOrderNotional) < Number(cfg.minOrderUsd)) {
    warnings.push('warning_max_order_notional_lt_min_order_usd');
  }

  // Exchange minimum order size validation (for live mode)
  const exchangeMinSize = Number(cfg.exchangeMinSize) || 1;
  const effectiveMinShares = Math.max(Number(cfg.minOrderShares) || 1, exchangeMinSize);
  
  if (effectiveMinShares > Number(cfg.maxPosition)) {
    issues.push('conflict_effective_min_shares_gt_max_position');
  }

  if (mode === 'live' && cfg.liveDryRun !== true && cfg.liveDryRun !== false) {
    issues.push('invalid_live_dry_run_flag');
  }

  return { ok: issues.length === 0, issues, warnings };
}
