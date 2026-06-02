// ws.js — a small reconnecting websocket client for realtime events.
//
// It speaks the server's {type, payload} envelope and hands parsed events to a
// callback. Reconnection uses capped exponential backoff so a server restart
// doesn't hammer the box.

export function connectRealtime(onEvent, onStatusChange) {
  let ws = null;
  let backoff = 500;
  let closedByUs = false;

  function url() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/api/ws`;
  }

  function open() {
    ws = new WebSocket(url());
    ws.onopen = () => {
      backoff = 500;
      onStatusChange && onStatusChange(true);
    };
    ws.onmessage = (ev) => {
      let parsed;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      onEvent && onEvent(parsed);
    };
    ws.onclose = () => {
      onStatusChange && onStatusChange(false);
      if (closedByUs) return;
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  open();

  return {
    close() {
      closedByUs = true;
      if (ws) ws.close();
    },
  };
}
