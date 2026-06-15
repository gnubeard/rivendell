// playwright.config.js — e2e suite for rivendell's browser-only paths.
//
// Dev-only tooling: @playwright/test is the repo's single devDependency (the
// frontend itself keeps zero runtime dependencies; Node remains test-runner
// only). Browsers are a separate, large download (`npx playwright install
// chromium`, ~1.5 GB with system deps; +WebKit when E2E_WEBKIT is set) — see
// `make test-e2e`.
//
// The bulk of the suite runs real Chromium contexts against a real server
// binary, covering the parts unit tests can't reach:
//   - WebRTC call paths (two contexts, fake capture devices): happy-path DM
//     video calls, mid-call renegotiation, and offer glare under Perfect
//     Negotiation.
//   - Composer paste channels (contenteditable composer): synthetic
//     ClipboardEvent/InputEvent/DOM-insertion harvest, channel exclusivity,
//     and byte-identical upload round-trips.
// Plus one opt-in WebKit (Safari-engine) smoke, gated behind E2E_WEBKIT — see
// the webkitProjects note below and docs/webkit-e2e.md.
import { defineConfig } from "@playwright/test";

// The WebKit smoke project is opt-in via E2E_WEBKIT=1. WebKit on Linux needs a
// large native stack (gtk4, the GStreamer good/libav plugins, a jpeg8-ABI
// libjpeg, a virtual audio source) that Debian/Ubuntu CI images carry but most
// dev boxes don't — so the DEFAULT `make test-e2e` is Chromium-only and green
// everywhere, and the WebKit project is added only when a host has been
// provisioned for it (see docs/webkit-e2e.md). On this dev box, Makefile.local
// sets E2E_WEBKIT=1 and runs the host-setup hook.
const webkitProjects = process.env.E2E_WEBKIT
  ? [
      {
        // WebKit smoke. WebKit on Linux has NO fake-capture support, so it can't
        // complete a real call — and that's exactly the point: this project runs
        // the join handler under the real Safari engine to catch WebKit-specific
        // exceptions in the synchronous lead-up to getUserMedia (the gap that let
        // a Safari-only bug ship while the Chromium suite stayed green). It does
        // NOT grant media or assert a connected call; see webkit-smoke.spec.js.
        name: "webkit",
        testMatch: /webkit-smoke\.spec\.js/,
        use: { browserName: "webkit" },
      },
    ]
  : [];

export default defineConfig({
  testDir: "./e2e",
  // One worker, serial: the two-user call tests share one server + one DB and
  // step on each other if parallelized.
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  globalSetup: "./e2e/global-setup.js",
  globalTeardown: "./e2e/global-teardown.js",
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:18080",
    trace: "retain-on-failure",
  },
  projects: [
    {
      // Full WebRTC + composer-paste suite. Chromium only: the fake capture
      // stack (a synthetic moving-pattern camera + tone-generator mic) and the
      // no-prompt permission grant are Chromium-specific, and the call specs
      // need real media flowing between two contexts.
      name: "chromium",
      testIgnore: /webkit-smoke\.spec\.js/,
      use: {
        browserName: "chromium",
        // getUserMedia without prompts or hardware: Chromium's fake capture stack
        // provides a synthetic camera (moving test pattern — frames advance, so
        // videoWidth/currentTime assertions are meaningful) and a tone-gen mic.
        permissions: ["microphone", "camera"],
        launchOptions: {
          args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            "--autoplay-policy=no-user-gesture-required",
          ],
        },
      },
    },
    ...webkitProjects,
  ],
});
