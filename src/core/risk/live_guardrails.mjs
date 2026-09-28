export function createLiveRiskTracker() {
  return {
    minuteBucket: null,
    minuteOrders: 0,
  };
}

export function checkLiveRiskGuard({
  intent,
  cfg,
  tracker,
  realizedPnl,
}) {
  const notional = Number(intent?.size || 0) * Number(intent?.limit_price || 0);
  if (notional > Number(cfg.maxOrderNotional || 20)) {
    return { ok: false, reason: 'risk_max_order_notional_exceeded', notional };
  }

  const now = new Date();
  const bucket = `${now.getUTCFullYear()}-${now.getUTCMonth()+1}-${now.getUTCDate()}-${now.getUTCHours()}-${now.getUTCMinutes()}`;
  if (tracker.minuteBucket !== bucket) {
    tracker.minuteBucket = bucket;
    tracker.minuteOrders = 0;
  }
  if (tracker.minuteOrders >= Number(cfg.maxOrdersPerMinute || 6)) {
    return { ok: false, reason: 'risk_rate_limit_exceeded', minute_orders: tracker.minuteOrders };
  }

  const loss = Math.max(0, -Number(realizedPnl || 0));
  if (loss >= Number(cfg.dailyLossLimit || 20)) {
    return { ok: false, reason: 'risk_daily_loss_limit_exceeded', daily_loss: loss };
  }

  return { ok: true, notional };
}

export function markLiveOrderSent(tracker) {
  tracker.minuteOrders += 1;
}
