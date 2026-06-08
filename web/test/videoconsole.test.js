// videoconsole.test.js — pure helpers for the admin video debugging console.
// The DOM controller (initVideoConsole) is browser-only and not exercised here;
// these cover the constraint-building and readout-formatting logic.

import test from "node:test";
import assert from "node:assert/strict";

import {
  constraintField,
  buildVideoConstraints,
  parseConstraintsText,
  fmtNum,
  describeResolution,
  summarizeSettings,
  summarizeCapabilities,
  RESOLUTION_PRESETS,
  ASPECT_RATIOS,
} from "../static/videoconsole.js";

test("constraintField builds a single clause or undefined", () => {
  assert.deepEqual(constraintField("ideal", 640), { ideal: 640 });
  assert.deepEqual(constraintField("exact", "1280"), { exact: 1280 });
  assert.deepEqual(constraintField("min", 24), { min: 24 });
  assert.equal(constraintField("off", 640), undefined);
  assert.equal(constraintField("", 640), undefined);
  assert.equal(constraintField("ideal", ""), undefined);
  assert.equal(constraintField("ideal", null), undefined);
  assert.equal(constraintField("ideal", "abc"), undefined);
});

test("buildVideoConstraints maps fields with the per-dimension mode", () => {
  const c = buildVideoConstraints({
    widthMode: "exact", width: 1280,
    heightMode: "exact", height: 720,
    fpsMode: "ideal", fps: 30,
    arMode: "ideal", aspectRatio: 1.7778,
    facingMode: "user",
    deviceId: "cam-1",
  });
  assert.deepEqual(c, {
    width: { exact: 1280 },
    height: { exact: 720 },
    frameRate: { ideal: 30 },
    aspectRatio: { ideal: 1.7778 },
    facingMode: { ideal: "user" },
    deviceId: { exact: "cam-1" },
  });
});

test("buildVideoConstraints omits unset fields and returns {} when empty", () => {
  assert.deepEqual(buildVideoConstraints({}), {});
  assert.deepEqual(buildVideoConstraints({ widthMode: "off", width: 640 }), {});
  assert.deepEqual(buildVideoConstraints({ widthMode: "ideal", width: 640 }), { width: { ideal: 640 } });
  // facingMode "off" is dropped, never sent as exact.
  assert.deepEqual(buildVideoConstraints({ facingMode: "off" }), {});
});

test("parseConstraintsText: empty -> null, object -> parsed, else throws", () => {
  assert.equal(parseConstraintsText(""), null);
  assert.equal(parseConstraintsText("   "), null);
  assert.deepEqual(parseConstraintsText('{"width":{"exact":1280}}'), { width: { exact: 1280 } });
  assert.throws(() => parseConstraintsText("not json"));
  assert.throws(() => parseConstraintsText("[1,2,3]"), /JSON object/);
  assert.throws(() => parseConstraintsText("42"), /JSON object/);
});

test("fmtNum trims numbers for display", () => {
  assert.equal(fmtNum(640), "640");
  assert.equal(fmtNum(1.77777), "1.778");
  assert.equal(fmtNum(24.0), "24");
  assert.equal(fmtNum(null), "?");
  assert.equal(fmtNum("user"), "user");
});

test("describeResolution headlines a getSettings object", () => {
  assert.equal(describeResolution({ width: 1280, height: 720, frameRate: 30 }), "1280 × 720 @ 30fps  (0.92 MP, 16:9)");
  assert.equal(describeResolution({ width: 640, height: 480 }), "640 × 480  (0.31 MP, 4:3)");
  assert.equal(describeResolution({ width: 360, height: 360 }), "360 × 360  (0.13 MP, 1:1)");
  assert.equal(describeResolution(null), "—");
  assert.equal(describeResolution({ width: 0, height: 0 }), "—");
});

test("summarizeSettings selects + formats known keys in order", () => {
  const pairs = summarizeSettings({
    width: 640, height: 360, frameRate: 23.976, aspectRatio: 1.7777,
    facingMode: "user", deviceId: "abc", noise: "ignored",
  });
  assert.deepEqual(pairs, [
    ["width", "640"],
    ["height", "360"],
    ["frameRate", "23.976"],
    ["aspectRatio", "1.778"],
    ["facingMode", "user"],
    ["deviceId", "abc"],
  ]);
  assert.deepEqual(summarizeSettings(null), []);
});

test("summarizeCapabilities renders ranges and arrays", () => {
  const pairs = summarizeCapabilities({
    width: { min: 1, max: 1920 },
    height: { min: 1, max: 1080 },
    frameRate: { min: 0, max: 30 },
    facingMode: ["user", "environment"],
    resizeMode: [],
  });
  assert.deepEqual(pairs, [
    ["width", "1 – 1920"],
    ["height", "1 – 1080"],
    ["frameRate", "0 – 30"],
    ["facingMode", "user, environment"],
  ]);
  assert.deepEqual(summarizeCapabilities(null), []);
});

test("preset/aspect tables are sane", () => {
  assert.ok(RESOLUTION_PRESETS.some((p) => p.label === "1080p" && p.width === 1920));
  assert.ok(ASPECT_RATIOS.some((a) => a.label === "16:9"));
});
