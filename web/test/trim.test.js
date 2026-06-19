import { test } from "node:test";
import assert from "node:assert/strict";
import { trimMessageContent } from "../static/trim.js";

// Spec: mirror the server's strings.TrimRight(content, " \t\r\n")
// (internal/httpapi/handlers_messages.go). Right side only; the cutset is
// exactly space, tab, CR, LF. Any drift from this orphans an optimistic row
// (see trim.js + the "Message-pane rendering" invariant in CLAUDE.md).

test("trims trailing space, tab, CR, and LF", () => {
  assert.equal(trimMessageContent("hi \t\r\n"), "hi");
  assert.equal(trimMessageContent("hi   "), "hi");
  assert.equal(trimMessageContent("hi\n\n\n"), "hi");
});

test("preserves interior and leading whitespace", () => {
  assert.equal(trimMessageContent("  hi"), "  hi");
  assert.equal(trimMessageContent("a\tb"), "a\tb");
  assert.equal(trimMessageContent("line1\nline2"), "line1\nline2");
  assert.equal(trimMessageContent("  a b  c "), "  a b  c");
});

test("whitespace-only collapses to empty (matches Go TrimRight)", () => {
  assert.equal(trimMessageContent(" \t\r\n"), "");
  assert.equal(trimMessageContent(""), "");
});

test("does not touch whitespace classes the Go cutset omits", () => {
  // Go's cutset is the literal four bytes only — a trailing non-breaking space
  // (U+00A0) or form feed is NOT stripped, so the client must not strip it either.
  assert.equal(trimMessageContent("hi "), "hi ");
  assert.equal(trimMessageContent("hi\f"), "hi\f");
});
