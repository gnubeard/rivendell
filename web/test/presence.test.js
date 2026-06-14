import { test } from "node:test";
import assert from "node:assert/strict";
import { presenceClass, presenceLabel, presenceDecision } from "../static/presence.js";

// ---- presenceClass ----

test("presenceClass: offline users are grey regardless of status/idle", () => {
  assert.equal(presenceClass({ online: false }), "offline");
  assert.equal(presenceClass({ online: false, idle: true, status: "dnd" }), "offline");
});

test("presenceClass: idle online users share away's amber", () => {
  assert.equal(presenceClass({ online: true, idle: true }), "away");
  // idle wins over a stored "dnd" status (auto-idle reads as away)
  assert.equal(presenceClass({ online: true, idle: true, status: "dnd" }), "away");
});

test("presenceClass: online users get their status color", () => {
  assert.equal(presenceClass({ online: true, status: "away" }), "away");
  assert.equal(presenceClass({ online: true, status: "dnd" }), "dnd");
});

test("presenceClass: online with no special status is online (green)", () => {
  assert.equal(presenceClass({ online: true }), "online");
  assert.equal(presenceClass({ online: true, status: "online" }), "online");
  assert.equal(presenceClass({ online: true, status: "anything-else" }), "online");
});

// ---- presenceLabel ----

test("presenceLabel: offline wins regardless of status/idle", () => {
  assert.equal(presenceLabel({ online: false }), "offline");
  assert.equal(presenceLabel({ online: false, idle: true, status: "dnd" }), "offline");
});

test("presenceLabel: dnd reads as 'do not disturb', ahead of idle", () => {
  assert.equal(presenceLabel({ online: true, status: "dnd" }), "do not disturb");
  // dnd takes precedence over idle (unlike presenceClass, which folds idle to away)
  assert.equal(presenceLabel({ online: true, status: "dnd", idle: true }), "do not disturb");
});

test("presenceLabel: auto-idle reads as 'idle' when not dnd", () => {
  assert.equal(presenceLabel({ online: true, idle: true }), "idle");
  assert.equal(presenceLabel({ online: true, idle: true, status: "online" }), "idle");
});

test("presenceLabel: otherwise the stored status word", () => {
  assert.equal(presenceLabel({ online: true, status: "online" }), "online");
  assert.equal(presenceLabel({ online: true, status: "away" }), "away");
});

// ---- presenceDecision ----

test("presenceDecision: our own user always applies immediately", () => {
  assert.equal(presenceDecision({ isSelf: true, knownUser: true, alreadyMatches: false }), "now");
  // self short-circuits before the unknown/matches checks
  assert.equal(presenceDecision({ isSelf: true, knownUser: false, alreadyMatches: true }), "now");
});

test("presenceDecision: an unknown user is dropped", () => {
  assert.equal(presenceDecision({ isSelf: false, knownUser: false, alreadyMatches: false }), "drop");
});

test("presenceDecision: a value that already matches what's shown is dropped (the flicker case)", () => {
  assert.equal(presenceDecision({ isSelf: false, knownUser: true, alreadyMatches: true }), "drop");
});

test("presenceDecision: a real change for a known peer is scheduled (debounced)", () => {
  assert.equal(presenceDecision({ isSelf: false, knownUser: true, alreadyMatches: false }), "schedule");
});
