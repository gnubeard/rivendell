// previews.js — the client-side link/embed preview cache state machine.
//
// Two caches share one lifecycle: same-origin message-permalink embeds and
// external og: link cards. A key is first unrequested, then "loading", then
// resolves to either a payload, a transient retry state ("pending", external
// only — the server returned 202 while it fetches in the background), or
// "failed". Each cache instance owns its Map and the pure state logic, so it's
// unit-testable; app.js creates the two caches and keeps the async fetch (api
// call + setTimeout retry + re-render) as the thin side-effecting adapter, plus
// the DOM card builders.

export const LOADING = "loading";
export const PENDING = "pending";
export const FAILED = "failed";

// previewOutcome decides what a renderer should do with a cached value:
//   "fetch" — nothing requested yet; kick off a fetch and render nothing
//   "wait"  — in flight / retrying / failed; render nothing this pass
//   "ready" — a resolved payload is present; render it
// A resolved preview is always a truthy object, so anything that isn't one of
// the sentinel states (or undefined) is "ready".
export function previewOutcome(cached) {
  if (cached === undefined) return "fetch";
  if (cached === LOADING || cached === PENDING || cached === FAILED) return "wait";
  return "ready";
}

export function createPreviewCache() {
  const m = new Map();
  return {
    // begin claims the key for an in-flight fetch and returns true. If the key
    // was already requested (any state, including resolved), it returns false so
    // callers stay idempotent — a second fetch for the same key is a no-op.
    begin(key) {
      if (m.has(key)) return false;
      m.set(key, LOADING);
      return true;
    },
    resolve(key, value) { m.set(key, value); },
    pending(key) { m.set(key, PENDING); },
    fail(key) { m.set(key, FAILED); },
    forget(key) { m.delete(key); }, // drop a pending key so its retry re-fetches
    get(key) { return m.get(key); },
    // outcome tells a renderer what to do with the key right now.
    outcome(key) { return previewOutcome(m.get(key)); },
  };
}
