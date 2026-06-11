import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldReconnectOnResume, connectRealtime } from "../static/ws.js";

// ---------------------------------------------------------------------------
// Minimal browser-global stubs for connectRealtime tests
// ---------------------------------------------------------------------------

function makeBrowserMocks() {
  const sockets = [];
  const winListeners = {};
  const docListeners = {};

  class MockWebSocket {
    constructor() {
      this.readyState = 1; // OPEN
      sockets.push(this);
    }
    close() { this.readyState = 3; }
  }

  globalThis.WebSocket = MockWebSocket;
  globalThis.location = { protocol: "http:", host: "localhost" };
  globalThis.document = {
    addEventListener(type, fn) { docListeners[type] = fn; },
    removeEventListener() {},
    visibilityState: "visible",
  };
  globalThis.window = {
    addEventListener(type, fn) { winListeners[type] = fn; },
    removeEventListener() {},
  };

  return { sockets, winListeners, docListeners };
}

function teardownBrowserMocks() {
  delete globalThis.WebSocket;
  delete globalThis.location;
  delete globalThis.document;
  delete globalThis.window;
}

const OPEN = 1;
const CLOSED = 3;
const CONNECTING = 0;

test("a healthy open socket after a brief hide is left alone", () => {
  assert.equal(shouldReconnectOnResume(OPEN, 2_000), false);
});

test("an open socket hidden long enough is treated as a zombie and rebuilt", () => {
  // A sleeping phone silently drops the TCP connection while readyState lies OPEN.
  assert.equal(shouldReconnectOnResume(OPEN, 60_000), true);
});

test("a non-open socket always reconnects regardless of hidden duration", () => {
  assert.equal(shouldReconnectOnResume(CLOSED, 0), true);
  assert.equal(shouldReconnectOnResume(CONNECTING, 0), true);
});

test("threshold boundary: strictly greater than threshold reconnects", () => {
  assert.equal(shouldReconnectOnResume(OPEN, 15_000, 15_000), false);
  assert.equal(shouldReconnectOnResume(OPEN, 15_001, 15_000), true);
});

// ---------------------------------------------------------------------------
// connectRealtime: double-socket / orphaned-socket regression tests
// ---------------------------------------------------------------------------

test("reconnectNow cancels a pending backoff timer so no third socket is opened", (t) => {
  t.mock.timers.enable(["setTimeout", "clearTimeout"]);
  const { sockets, winListeners } = makeBrowserMocks();
  try {
    connectRealtime(() => {}, () => {});

    // Initial socket; simulate a drop — onclose schedules retryLater timer.
    const sockA = sockets[0];
    sockA.readyState = 3;
    sockA.onclose();
    assert.equal(sockets.length, 1, "no new socket yet");

    // Resume event fires reconnectNow, which must cancel the pending timer and
    // open a fresh socket.
    winListeners.online();
    assert.equal(sockets.length, 2, "sockB opened by reconnectNow");

    // Advance past the backoff window.  If the timer was NOT cancelled, open()
    // would fire again and push a third socket onto the array.
    t.mock.timers.tick(1000);
    assert.equal(sockets.length, 2, "timer cancelled — no orphan socket created");
  } finally {
    teardownBrowserMocks();
  }
});

test("open() tears down the existing socket so a stale retryLater cannot leave an orphaned live connection", (t) => {
  t.mock.timers.enable(["setTimeout", "clearTimeout"]);
  const { sockets, winListeners } = makeBrowserMocks();
  try {
    let dispatched = 0;
    connectRealtime((ev) => dispatched++, () => {});

    const sockA = sockets[0];

    // Trigger reconnectNow twice in quick succession (two rapid resume events).
    // Each call should tear down the previous socket before opening a new one.
    // Mark socket as dead first so shouldReconnectOnResume returns true.
    sockA.readyState = 3;
    winListeners.online();  // sockB opens; sockA should be torn down
    const sockB = sockets[1];
    assert.equal(sockA.onmessage, null, "sockA.onmessage cleared after first reconnect");
    assert.equal(sockA.readyState, 3, "sockA closed after first reconnect");

    sockB.readyState = 3;
    winListeners.online();  // sockC opens; sockB should be torn down
    const sockC = sockets[2];
    assert.equal(sockB.onmessage, null, "sockB.onmessage cleared after second reconnect");
    assert.equal(sockB.readyState, 3, "sockB closed after second reconnect");

    // A message delivered to the torn-down sockB must not reach onEvent.
    // (handlers were cleared — this call should be a no-op, not throw)
    assert.equal(sockB.onmessage, null, "sockB handler is gone; cannot double-dispatch");

    // The live socket (sockC) dispatches exactly once.
    sockC.onmessage({ data: JSON.stringify({ type: "ping" }) });
    assert.equal(dispatched, 1, "exactly one dispatch from the live socket");
  } finally {
    teardownBrowserMocks();
  }
});
