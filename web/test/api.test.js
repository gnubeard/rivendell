import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../static/api.js";

// api.js is a thin wrapper over global fetch. node:test has no DOM, but it does
// have a global fetch, so we stub it (the injected-global pattern the
// decomposition doc blesses for localStorage). We assert two things per call:
// the request shape api built (method/path/headers/body), and how req() folds
// the response (parse, empty-body, and error contract). The one-line URL
// builders are deliberately NOT exercised — testing them would just restate them.

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Install a fake fetch. `handler(path, opts)` returns { status?, ok?, statusText?,
// json? , text? }; we synthesize a Response-like with both text() and json().
// Returns the captured call log so a test can assert what api sent.
function mockFetch(handler = () => ({})) {
  const calls = [];
  globalThis.fetch = async (path, opts = {}) => {
    calls.push({ path, opts });
    const r = handler(path, opts) || {};
    const status = r.status ?? 200;
    const ok = r.ok ?? (status >= 200 && status < 300);
    const bodyText = r.text != null
      ? r.text
      : r.json !== undefined ? JSON.stringify(r.json) : "";
    return {
      ok,
      status,
      statusText: r.statusText ?? "",
      async text() { return bodyText; },
      async json() {
        if (r.json !== undefined) return r.json;
        if (r.text != null) return JSON.parse(r.text);
        return null;
      },
    };
  };
  return calls;
}

// --- req(): the shared funnel every JSON call passes through --------------------

test("GET sends no body or Content-Type and returns parsed JSON", async () => {
  const calls = mockFetch(() => ({ json: { version: "1.2.3" } }));
  const out = await api.instance();
  assert.deepEqual(out, { version: "1.2.3" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/instance");
  assert.equal(calls[0].opts.method, "GET");
  assert.equal(calls[0].opts.credentials, "same-origin");
  assert.equal(calls[0].opts.body, undefined);
  assert.equal(calls[0].opts.headers["Content-Type"], undefined);
});

test("a body is JSON-serialized with a Content-Type header", async () => {
  const calls = mockFetch(() => ({ json: { id: 7 } }));
  await api.login("frodo", "secret");
  assert.equal(calls[0].path, "/api/auth/login");
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].opts.body), { username: "frodo", password: "secret" });
});

test("a bodyless POST omits both the body and the Content-Type", async () => {
  const calls = mockFetch(() => ({ text: "" }));
  await api.logout();
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.body, undefined);
  assert.equal(calls[0].opts.headers["Content-Type"], undefined);
});

test("an empty response body parses as null", async () => {
  mockFetch(() => ({ text: "" }));
  assert.equal(await api.logout(), null);
});

test("a non-JSON body falls back to the raw text", async () => {
  mockFetch(() => ({ text: "plain words, not json" }));
  assert.equal(await api.instance(), "plain words, not json");
});

test("a non-OK response throws with the server's error message and status", async () => {
  mockFetch(() => ({ status: 403, json: { error: "forbidden" } }));
  await assert.rejects(api.instance(), (e) => {
    assert.equal(e.message, "forbidden");
    assert.equal(e.status, 403);
    return true;
  });
});

test("a non-OK response with no error field falls back to statusText", async () => {
  mockFetch(() => ({ status: 500, statusText: "Internal Server Error", text: "" }));
  await assert.rejects(api.instance(), (e) => {
    assert.equal(e.message, "Internal Server Error");
    assert.equal(e.status, 500);
    return true;
  });
});

test("a non-OK response with neither error nor statusText uses a generic message", async () => {
  mockFetch(() => ({ status: 400, statusText: "", text: "" }));
  await assert.rejects(api.instance(), (e) => {
    assert.equal(e.message, "request failed");
    return true;
  });
});

// --- messages(): query-string assembly -----------------------------------------

test("messages() with no opts builds a bare path (no ?)", async () => {
  const calls = mockFetch(() => ({ json: [] }));
  await api.messages(42);
  assert.equal(calls[0].path, "/api/channels/42/messages");
});

test("messages() folds each paging option into the query string", async () => {
  const calls = mockFetch(() => ({ json: [] }));
  await api.messages(42, { before: 100, limit: 50 });
  const url = new URL(calls[0].path, "http://x");
  assert.equal(url.pathname, "/api/channels/42/messages");
  assert.equal(url.searchParams.get("before"), "100");
  assert.equal(url.searchParams.get("limit"), "50");
  assert.equal(url.searchParams.get("after"), null);
});

test("messages() supports the around cursor", async () => {
  const calls = mockFetch(() => ({ json: [] }));
  await api.messages(7, { around: 999 });
  assert.match(calls[0].path, /\?around=999$/);
});

// --- search(): query + keyset cursor -------------------------------------------

test("search() encodes the query and appends the before/limit cursor", async () => {
  const calls = mockFetch(() => ({ json: [] }));
  await api.search("a & b", { before: 55, limit: 20 });
  const url = new URL(calls[0].path, "http://x");
  assert.equal(url.pathname, "/api/search");
  assert.equal(url.searchParams.get("q"), "a & b");
  assert.equal(url.searchParams.get("before"), "55");
  assert.equal(url.searchParams.get("limit"), "20");
});

// --- getLinkPreview(): status → shape contract ---------------------------------

test("getLinkPreview returns the JSON body on 200", async () => {
  mockFetch(() => ({ status: 200, json: { title: "Example" } }));
  assert.deepEqual(await api.getLinkPreview("https://x.test"), { title: "Example" });
});

test("getLinkPreview maps a non-200 to a {_status} marker without throwing", async () => {
  mockFetch(() => ({ status: 202 }));
  assert.deepEqual(await api.getLinkPreview("https://x.test"), { _status: 202 });
  mockFetch(() => ({ status: 404 }));
  assert.deepEqual(await api.getLinkPreview("https://x.test"), { _status: 404 });
});

test("getLinkPreview percent-encodes the url argument", async () => {
  const calls = mockFetch(() => ({ status: 404 }));
  await api.getLinkPreview("https://x.test/a b?c=d");
  assert.match(calls[0].path, /\/api\/link-preview\?url=https%3A%2F%2Fx\.test%2Fa%20b%3Fc%3Dd$/);
});

// --- createBotToken(): conditional body shape ----------------------------------

test("createBotToken includes user_id only when one is supplied", async () => {
  let calls = mockFetch(() => ({ json: {} }));
  await api.createBotToken("ci-bot", 12);
  assert.deepEqual(JSON.parse(calls[0].opts.body), { name: "ci-bot", user_id: 12 });

  calls = mockFetch(() => ({ json: {} }));
  await api.createBotToken("ci-bot", null);
  assert.deepEqual(JSON.parse(calls[0].opts.body), { name: "ci-bot" });
});

// --- upload helpers: their own error fallback (separate from req) ---------------

test("uploadBlob posts the raw file with its content type and returns JSON", async () => {
  const calls = mockFetch(() => ({ json: { hash: "abc", size: 3 } }));
  const file = { type: "image/png" };
  const out = await api.uploadBlob(file);
  assert.deepEqual(out, { hash: "abc", size: 3 });
  assert.equal(calls[0].path, "/api/uploads");
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.headers["Content-Type"], "image/png");
  assert.equal(calls[0].opts.body, file);
});

test("uploadBlob surfaces the server error, falling back to a generic message", async () => {
  mockFetch(() => ({ status: 413, json: { error: "too big" } }));
  await assert.rejects(api.uploadBlob({ type: "image/png" }), /too big/);

  mockFetch(() => ({ status: 500, text: "" }));
  await assert.rejects(api.uploadBlob({ type: "image/png" }), /upload failed/);
});
