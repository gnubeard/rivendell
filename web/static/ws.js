// ws.js — a small reconnecting websocket client for realtime events.
//
// It speaks the server's {type, payload} envelope and hands parsed events to a
// callback. Reconnection uses capped exponential backoff so a server restart
// doesn't hammer the box.
//
// Liveness: a sleeping phone (or backgrounded tab) has its TCP connection torn
// down silently — no close/error fires, and `readyState` keeps reporting OPEN.
// That "zombie" socket would otherwise sit dead until a manual refresh. So we
// proactively rebuild the socket when the page resumes (visibility/online/
// pageshow) if it isn't genuinely open or the page was hidden long enough that
// the connection likely died.

const WS_OPEN = 1; // WebSocket.OPEN — spelled out so this stays Node-testable
const RESUME_THRESHOLD_MS = 15_000; // hidden longer than this ⇒ assume socket died

// shouldReconnectOnResume decides whether a resumed page should rebuild its
// socket: yes if the socket isn't open, or it was hidden long enough that a
// mobile OS has likely killed the connection out from under us. Pure/testable.
export function shouldReconnectOnResume(readyState, hiddenMs, threshold = RESUME_THRESHOLD_MS) {
  if (readyState !== WS_OPEN) return true;
  return hiddenMs > threshold;
}

export function connectRealtime(onEvent, onStatusChange) {
  let ws = null;
  let backoff = 500;
  let closedByUs = false;
  let hiddenAt = 0; // timestamp the page last became hidden (0 = currently visible)

  function url() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/api/ws`;
  }

  function retryLater() {
    if (closedByUs) return;
    setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, 15000);
  }

  function open() {
    if (closedByUs) return;
    let sock;
    try {
      sock = new WebSocket(url());
    } catch (e) {
      // Some browsers (notably Firefox under a CSP that doesn't allow the
      // wss: origin) throw synchronously from the constructor. Treat that like
      // any other failed connection: report disconnected and retry, rather
      // than letting it bubble up and break the caller.
      console.warn("rivendell: websocket connect failed:", e && e.message);
      onStatusChange && onStatusChange(false);
      retryLater();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      backoff = 500;
      onStatusChange && onStatusChange(true);
    };
    sock.onmessage = (ev) => {
      let parsed;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      onEvent && onEvent(parsed);
    };
    sock.onclose = () => {
      if (sock !== ws) return; // superseded by a forced reconnect; ignore
      onStatusChange && onStatusChange(false);
      retryLater();
    };
    sock.onerror = () => {
      try {
        sock.close();
      } catch {}
    };
  }

  // reconnectNow replaces the current socket immediately, detaching the old
  // one's handlers so its (eventual) onclose doesn't also schedule a reconnect.
  function reconnectNow() {
    if (closedByUs) return;
    const dead = ws;
    ws = null;
    if (dead) {
      dead.onopen = dead.onmessage = dead.onclose = dead.onerror = null;
      try {
        dead.close();
      } catch {}
    }
    backoff = 500;
    open();
  }

  function onResume() {
    if (closedByUs) return;
    const hiddenMs = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    const readyState = ws ? ws.readyState : 3; // CLOSED
    if (shouldReconnectOnResume(readyState, hiddenMs)) reconnectNow();
  }

  function onVisibility() {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
    } else {
      onResume();
    }
  }

  open();

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onResume);
  window.addEventListener("pageshow", onResume);

  return {
    close() {
      closedByUs = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onResume);
      window.removeEventListener("pageshow", onResume);
      if (ws) {
        ws.onclose = null; // we're closing deliberately; don't schedule a retry
        try {
          ws.close();
        } catch {}
      }
    },
  };
}
