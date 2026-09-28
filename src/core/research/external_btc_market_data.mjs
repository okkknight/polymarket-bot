const RTDS_URL = 'wss://ws-live-data.polymarket.com';

export function parseChainlinkRtdsMessage(raw) {
  let message;
  try {
    message = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (message?.topic !== 'crypto_prices_chainlink' || message?.type !== 'update') return null;
  const payload = message?.payload || {};
  if (String(payload.symbol || '').toLowerCase() !== 'btc/usd') return null;
  const timestamp = Number(payload.timestamp);
  const value = Number(payload.value);
  if (!(Number.isFinite(timestamp) && timestamp > 0 && Number.isFinite(value) && value > 0)) return null;
  return { timestamp, value };
}

export function subscribeChainlinkPriceReports({
  onReport,
  onError,
  WebSocketImpl = WebSocket,
  url = RTDS_URL,
  reconnectBaseMs = 1_000,
  reconnectMaxMs = 10_000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  let closed = false;
  let socket = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  const reportError = (reason) => {
    if (!closed) onError?.(reason);
  };
  const reconnect = () => {
    if (closed || reconnectTimer !== null) return;
    const delayMs = Math.min(Number(reconnectMaxMs), Number(reconnectBaseMs) * (2 ** reconnectAttempt));
    reconnectAttempt += 1;
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
  };
  const connect = () => {
    if (closed) return;
    socket = new WebSocketImpl(url);
    socket.onopen = () => {
      reconnectAttempt = 0;
      try {
        socket.send(JSON.stringify({
          action: 'subscribe',
          subscriptions: [{
            topic: 'crypto_prices_chainlink',
            type: '*',
            filters: JSON.stringify({ symbol: 'btc/usd' }),
          }],
        }));
      } catch (error) {
        reportError(`chainlink_subscribe_failed:${error?.message || String(error)}`);
        reconnect();
      }
    };
    socket.onmessage = (event) => {
      const report = parseChainlinkRtdsMessage(event?.data);
      if (report) onReport?.(report);
    };
    socket.onerror = () => reportError('chainlink_rtds_error');
    socket.onclose = () => {
      reportError('chainlink_rtds_closed');
      reconnect();
    };
  };
  connect();
  return {
    close() {
      closed = true;
      if (reconnectTimer !== null) clearTimeoutImpl(reconnectTimer);
      socket?.close();
    },
  };
}
