// playwright.config.js — e2e suite for rivendell's browser-only paths.
//
// Dev-only tooling: @playwright/test is the repo's single devDependency (the
// frontend itself keeps zero runtime dependencies; Node remains test-runner
// only). Browsers are a separate, large download (`npx playwright install
// chromium`, ~1.5 GB with system deps) — see `make test-e2e`.
//
// The suite runs real Chromium contexts against a real server binary, covering
// the parts unit tests can't reach:
//   - WebRTC call paths (two contexts, fake capture devices): happy-path DM
//     video calls, mid-call renegotiation, and offer glare under Perfect
//     Negotiation.
//   - Composer paste channels (contenteditable composer): synthetic
//     ClipboardEvent/InputEvent/DOM-insertion harvest, channel exclusivity,
//     and byte-identical upload round-trips.
import { defineConfig } from "@playwright/test";

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
    // getUserMedia without prompts or hardware: Chromium's fake capture stack
    // provides a synthetic camera (moving test pattern — frames advance, so
    // videoWidth/currentTime assertions are meaningful) and a tone-generator mic.
    permissions: ["microphone", "camera"],
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
