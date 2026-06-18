// e2e/firefox-smoke.spec.js — Firefox (Gecko engine) smoke, single context.
//
// Why this exists: the WebRTC call specs (dm-call, group-call) lean on Chromium's
// fake-capture stack (`--use-fake-device-for-media-stream`) and so run Chromium
// ONLY. That left the client unexercised under Gecko — the engine behind this
// project's recurring browser-specific bugs (contenteditable image delivery in
// composer-paste, the Shift+Enter <br> normalize in composer-richtext, the
// FF-Android video freeze). A Gecko-only regression (a feature Firefox parses but
// won't run, a getUserMedia lead-up that throws) would ship while the suite stays
// green. This is the Gecko sibling of webkit-smoke.spec.js.
//
// This is a boot + helper + liveness probe, not a call test (no connected call,
// no two contexts). Unlike the WebKit smoke — which grants no media because
// WebKit on Linux has no fake capture and rejects (a clean settle) — headless
// Firefox would HANG getUserMedia on an unanswerable permission prompt, so the
// project hands Gecko a fake device (see playwright.config.js) and the probe
// expects a clean RESOLVE. Under the real engine we run:
//   1. full app boot to the logged-in state with ZERO uncaught page errors —
//      this executes every client module (incl. voice.js, the WebRTC engine)
//      under Gecko, catching parse/eval/feature regressions Chromium tolerates;
//   2. the media-environment helpers voice.js exports (preflightMediaError,
//      micErrorMessage) — imported and called in-page, proving they execute under
//      Gecko and that the preflight lets a real call through on a trustworthy
//      origin rather than false-blocking;
//   3. a liveness probe of navigator.mediaDevices.getUserMedia: that it EXISTS
//      and SETTLES rather than hanging. With the fake device + prompt disabled
//      (playwright.config.js) the healthy outcome is "resolved"; "neither within
//      8s" is the stall (e.g. a Gecko pipeline regression) we're hunting.
//
// Run: `npx playwright test --project=firefox` (needs the same server + disposable
// DB as the rest of the suite; see global-setup.js / `make test-e2e`). The project
// is opt-in via E2E_FIREFOX=1 — see playwright.config.js.
import { test, expect } from "@playwright/test";
import { ADMIN, PASSWORD } from "./global-setup.js";

test.describe.configure({ mode: "serial" });

test("Firefox: app boots, media helpers run, getUserMedia settles (no hang)", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Collect uncaught exceptions and error-level console output across the whole
  // flow. A Gecko-specific failure in module init or the call lead-up shows up
  // here as a pageerror even when the visible UI looks fine.
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  // Our handled mic failures surface via alert(); auto-dismiss so nothing blocks.
  page.on("dialog", (d) => d.dismiss().catch(() => {}));

  try {
    // (1) Boot to logged-in state under the real engine.
    await page.goto("/");
    await page.fill("#login-username", ADMIN);
    await page.fill("#login-password", PASSWORD);
    await page.press("#login-password", "Enter");
    await expect(page.locator("#me-name")).toBeVisible();

    // (2) + (3): exercise the media stack + the helpers voice.js exports, in-page.
    // voice.js has zero imports, so dynamic import pulls nothing else and runs no
    // DOM-dependent top-level code.
    const probe = await page.evaluate(async () => {
      const out = {};
      out.isSecureContext = window.isSecureContext;           // localhost ⇒ true
      out.standalone = !!navigator.standalone;                // Gecko: undefined ⇒ false
      out.hasGUM = !!(navigator.mediaDevices &&
                      typeof navigator.mediaDevices.getUserMedia === "function");

      const mod = await import("/static/voice.js");
      // Preflight must let a trustworthy origin with a real mediaDevices through.
      out.preflightHere = mod.preflightMediaError({
        hasMediaDevices: out.hasGUM,
        isSecureContext: out.isSecureContext,
        standalone: out.standalone,
      });
      // ...and must block a stripped (insecure / WebView) context with a message.
      out.preflightStripped = mod.preflightMediaError({
        hasMediaDevices: false, isSecureContext: false, standalone: false,
      });
      // The standalone caveat must render through the message path under Gecko.
      out.standaloneMsg = mod.micErrorMessage({ name: "NotAllowedError" }, { standalone: true });

      // Liveness: getUserMedia must SETTLE, not hang. With the fake device handed
      // to Gecko (playwright.config.js firefoxUserPrefs), the expected, healthy
      // outcome is a resolve; a named reject would settle too. "neither within 8s"
      // is the stall we're hunting.
      out.gumOutcome = await Promise.race([
        navigator.mediaDevices.getUserMedia({ audio: true })
          .then((s) => { s.getTracks().forEach((t) => t.stop()); return "resolved"; })
          .catch((e) => "rejected:" + (e && e.name ? e.name : "unknown")),
        new Promise((r) => setTimeout(() => r("timeout"), 8000)),
      ]);
      return out;
    });

    // Deterministic assertions (engine-real, not media-dependent):
    expect(probe.hasGUM, "navigator.mediaDevices.getUserMedia should exist on a localhost (secure) origin").toBe(true);
    expect(probe.isSecureContext, "localhost must be a secure context").toBe(true);
    expect(probe.preflightHere, "preflight must let a real mediaDevices context through").toBeNull();
    expect(probe.preflightStripped, "preflight must block a stripped context").toBeTruthy();
    expect(probe.standaloneMsg, "standalone caveat must reach the message").toContain("Safari");

    // getUserMedia must not hang. A timeout here IS the bug class this project
    // exists to surface, so fail loudly with the outcome attached.
    expect(probe.gumOutcome, "getUserMedia hung (never settled) under Firefox").not.toBe("timeout");

    // Boot + helper exercise must have produced no uncaught errors.
    expect(pageErrors, `uncaught page errors under Firefox:\n${pageErrors.join("\n")}`).toEqual([]);

    // Surface the observed getUserMedia behavior in the run log (informational).
    console.log(`[firefox-smoke] getUserMedia outcome: ${probe.gumOutcome}; ` +
                `console errors: ${consoleErrors.length}`);
  } finally {
    await ctx.close();
  }
});
