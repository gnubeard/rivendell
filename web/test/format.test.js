import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMessage, escapeHtml, mentionsUser, atQuery, permalinkHash, parsePermalink } from "../static/format.js";

test("escapes HTML to prevent XSS", () => {
  const out = formatMessage('<script>alert("x")</script>');
  assert.ok(!out.includes("<script>"), "raw script tag must not survive");
  assert.ok(out.includes("&lt;script&gt;"), "angle brackets escaped");
});

test("escapeHtml handles all dangerous chars", () => {
  assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
});

test("bold and italic", () => {
  assert.equal(formatMessage("**hi**"), "<strong>hi</strong>");
  assert.equal(formatMessage("*hi*"), "<em>hi</em>");
  assert.equal(formatMessage("_hi_"), "<em>hi</em>");
});

test("strikethrough", () => {
  assert.equal(formatMessage("~~nope~~"), "<del>nope</del>");
});

test("inline code is not further formatted", () => {
  const out = formatMessage("use `**not bold**` here");
  assert.ok(out.includes("<code>**not bold**</code>"));
  assert.ok(!out.includes("<strong>"));
});

test("fenced code block preserved verbatim", () => {
  const out = formatMessage("```\nline1\nline2\n```");
  assert.ok(out.includes("<pre class=\"code-block\"><code>line1\nline2</code></pre>"));
});

test("fenced code block strips language hint", () => {
  const out = formatMessage("```go\nx := 1\n```");
  assert.ok(out.includes("<code>x := 1</code>"));
  assert.ok(!out.includes("go\n"));
});

test("autolinks http and https only", () => {
  const out = formatMessage("see https://example.com/x?a=1");
  assert.ok(out.includes('href="https://example.com/x?a=1"'));
  assert.ok(out.includes('rel="noopener noreferrer"'));
});

test("does not autolink javascript scheme", () => {
  const out = formatMessage("javascript:alert(1)");
  assert.ok(!out.includes("<a "), "non-http schemes must not become links");
});

test("newlines become breaks", () => {
  assert.equal(formatMessage("a\nb"), "a<br>b");
});

test("blockquote", () => {
  const out = formatMessage("> quoted");
  assert.ok(out.includes("<blockquote>quoted</blockquote>"));
});

test("a link inside escaped text keeps entities intact", () => {
  const out = formatMessage("https://x.com/?a=1&b=2");
  // & was escaped to &amp; before linking; the href should contain it.
  assert.ok(out.includes("a=1&amp;b=2"));
});

test("empty and null input", () => {
  assert.equal(formatMessage(""), "");
  assert.equal(formatMessage(null), "");
});

test("mentionsUser matches whole-token, case-insensitively, with boundaries", () => {
  assert.ok(mentionsUser("hey @alice ping", "alice"));
  assert.ok(mentionsUser("@Alice at the start", "alice"));
  assert.ok(mentionsUser("(@alice)", "alice"));
  assert.ok(!mentionsUser("hey @alicexyz", "alice"), "must not match a longer token");
  assert.ok(!mentionsUser("email bob@alice.com", "alice"), "email local@ must not match");
  assert.ok(!mentionsUser("see http://x.com/@alice", "alice"), "URL path @ must not match");
  assert.ok(!mentionsUser("no mention here", "alice"));
  assert.ok(!mentionsUser("@alice", ""), "empty username never matches");
});

test("formatMessage styles mentions and flags the current user", () => {
  const out = formatMessage("hi @bob and @alice", "alice");
  assert.ok(out.includes('<span class="mention">@bob</span>'), "other mention styled");
  assert.ok(out.includes('<span class="mention mention-me">@alice</span>'), "my mention flagged");
});

test("atQuery finds the @token immediately before the caret", () => {
  assert.deepEqual(atQuery("@alice", 6), { start: 0, partial: "alice" });
  assert.deepEqual(atQuery("hey @bob", 8), { start: 4, partial: "bob" });
  assert.deepEqual(atQuery("hey @bo", 7), { start: 4, partial: "bo" });
  assert.deepEqual(atQuery("hey @", 5), { start: 4, partial: "" });
  // caret mid-token: only chars before caret form the partial
  assert.deepEqual(atQuery("@alice", 3), { start: 0, partial: "al" });
});

test("atQuery returns null when there is no valid trigger", () => {
  assert.equal(atQuery("hello world", 11), null, "no @ present");
  assert.equal(atQuery("foo@bar.com", 11), null, "email: word char before @");
  assert.equal(atQuery("https://x.com/@alice", 20), null, "URL path: / before @");
  assert.equal(atQuery("@alice", 0), null, "caret before @");
  assert.equal(atQuery("text @alice", 5), null, "caret lands on @, not past it");
});

test("mention styling stays XSS-safe and never enters an href", () => {
  // A display-name-looking payload is escaped; mention spans are not injected
  // into the autolinked href (the @ after / is excluded).
  const out = formatMessage('@alice <img src=x onerror=1> http://x.com/@alice', "alice");
  assert.ok(!out.includes("<img"), "raw tag stays escaped");
  assert.ok(out.includes('href="http://x.com/@alice"'), "URL with @ links intact, no span inside href");
});

test("permalinkHash builds the canonical no-slash hash", () => {
  assert.equal(permalinkHash(5, 123), "#c5/m123");
});

test("parsePermalink round-trips permalinkHash", () => {
  assert.deepEqual(parsePermalink(permalinkHash(5, 123)), { channelId: 5, messageId: 123 });
});

test("parsePermalink parses a valid hash", () => {
  assert.deepEqual(parsePermalink("#c42/m1009"), { channelId: 42, messageId: 1009 });
});

test("parsePermalink rejects the old /m/ slash form and junk", () => {
  // Regression: hrefs once emitted `#c5/m/123`, which the parser must NOT accept
  // as that drift silently broke shared links on fresh load.
  assert.equal(parsePermalink("#c5/m/123"), null);
  assert.equal(parsePermalink("#c5/m"), null);
  assert.equal(parsePermalink("#cx/my"), null);
  assert.equal(parsePermalink("#/"), null);
  assert.equal(parsePermalink(""), null);
  assert.equal(parsePermalink(null), null);
});
