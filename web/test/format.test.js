import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMessage, escapeHtml, mentionsUser, atQuery, colonQuery, hashQuery, permalinkHash, parsePermalink, decidePermalinkRoute, ROUTE_DEDUPE_MS, pingLabel, extractMessagePermalinkURL, extractFirstBareURL, suppressEmbedURL, isImageURL, replySnippet, reactionTooltip, classifyReaction, shouldGroupMessage, GROUP_WINDOW_MS, BUILTIN_EMOJI, BUILTIN_EMOJI_LIST } from "../static/format.js";
import { highlight } from "../static/syntax.js";

// ---- reactionTooltip ----

test("reactionTooltip: custom emoji shows its :shortcode: and reactors", () => {
  assert.equal(
    reactionTooltip("partyblob", "Alice, Bob", { isCustom: true, isOrphan: false, mine: false }),
    ":partyblob: — Alice, Bob",
  );
});

test("reactionTooltip: a builtin Unicode glyph reverse-maps to its :name: and is prefixed by the glyph", () => {
  // BUILTIN_EMOJI maps name → glyph; the tooltip surfaces the glyph + its shortcode.
  const glyph = BUILTIN_EMOJI.tada;
  assert.equal(
    reactionTooltip(glyph, "Alice", { isCustom: false, isOrphan: false, mine: false }),
    `${glyph} :tada: — Alice`,
  );
});

test("reactionTooltip: an unmapped Unicode glyph shows the bare glyph as its identity", () => {
  assert.equal(
    reactionTooltip("🦄", "Carol", { isCustom: false, isOrphan: false, mine: false }),
    "🦄 — Carol",
  );
});

test("reactionTooltip: an orphan adds the deleted note; mine adds the remove hint", () => {
  assert.equal(
    reactionTooltip("goneblob", "Alice", { isCustom: false, isOrphan: true, mine: false }),
    ":goneblob: — Alice (emoji deleted)",
  );
  assert.equal(
    reactionTooltip("goneblob", "Alice", { isCustom: false, isOrphan: true, mine: true }),
    ":goneblob: — Alice (emoji deleted — click to remove)",
  );
});

// ---- classifyReaction ----

test("classifyReaction: a live custom emoji is isCustom, not orphan, enabled", () => {
  assert.deepEqual(
    classifyReaction({ emoji: "partyblob", user_ids: [2] }, { partyblob: {} }, 1),
    { mine: false, isCustom: true, isOrphan: false, disabled: false });
});

test("classifyReaction: a Unicode glyph is neither custom nor orphan, enabled", () => {
  assert.deepEqual(
    classifyReaction({ emoji: "🔥", user_ids: [2] }, {}, 1),
    { mine: false, isCustom: false, isOrphan: false, disabled: false });
});

test("classifyReaction: mine reflects my id among the reactors", () => {
  assert.equal(classifyReaction({ emoji: "🔥", user_ids: [1, 2] }, {}, 1).mine, true);
  assert.equal(classifyReaction({ emoji: "🔥", user_ids: [2, 3] }, {}, 1).mine, false);
});

test("classifyReaction: a shortcode-shaped value absent from the registry is an orphan", () => {
  // Not mine ⇒ disabled (adding a deleted emoji would be rejected).
  assert.deepEqual(
    classifyReaction({ emoji: "goneblob", user_ids: [2] }, {}, 1),
    { mine: false, isCustom: false, isOrphan: true, disabled: true });
  // Mine ⇒ still clickable to remove.
  assert.deepEqual(
    classifyReaction({ emoji: "goneblob", user_ids: [1] }, {}, 1),
    { mine: true, isCustom: false, isOrphan: true, disabled: false });
});

test("classifyReaction: a missing user_ids array is treated as no reactors", () => {
  assert.deepEqual(
    classifyReaction({ emoji: "🔥" }, {}, 1),
    { mine: false, isCustom: false, isOrphan: false, disabled: false });
});

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

test("bold spanning a code span renders correctly", () => {
  const out = formatMessage("**foo `bar` baz**");
  assert.ok(out.includes("<strong>"), "outer bold rendered");
  assert.ok(out.includes("<code>bar</code>"), "inner code span rendered");
  assert.ok(!out.includes("**"), "bold markers consumed");
});

test("italic spanning a code span renders correctly", () => {
  const out = formatMessage("_foo `bar` baz_");
  assert.ok(out.includes("<em>"), "outer italic rendered");
  assert.ok(out.includes("<code>bar</code>"), "inner code span rendered");
  assert.ok(!out.includes("_foo"), "italic markers consumed");
});

test("unmatched backtick is left as literal", () => {
  const out = formatMessage("foo `bar baz");
  assert.ok(out.includes("`bar baz"), "unmatched backtick left literal");
  assert.ok(!out.includes("<code>"), "no code element for unmatched backtick");
});

test("fenced code block preserved verbatim", () => {
  const out = formatMessage("```\nline1\nline2\n```");
  assert.ok(out.includes('<pre class="code-block">'), "pre element present");
  assert.ok(out.includes("line1"), "code content preserved");
  assert.ok(out.includes("line2"), "code content preserved");
});

test("fenced code block strips language hint and adds data-lang", () => {
  const out = formatMessage("```go\nx := 1\n```");
  assert.ok(!out.includes("go\n"), "language hint not in output content");
  assert.ok(out.includes('data-lang="go"'), "lang stored as data-lang attribute");
  assert.ok(out.includes("x"), "code body present");
});

test("highlight returns escaped HTML for unknown language", () => {
  assert.equal(highlight("<div>", ""), "&lt;div&gt;");
  assert.equal(highlight("<div>", "unknownlang"), "&lt;div&gt;");
});

test("highlight keywords in Go", () => {
  const out = highlight("func main() {}", "go");
  assert.ok(out.includes('class="hl-kw"'), "keyword span present");
  assert.ok(out.includes("func"), "keyword text preserved");
});

test("highlight strings in JavaScript", () => {
  const out = highlight('const x = "hello";', "js");
  assert.ok(out.includes('class="hl-str"'), "string span present");
  assert.ok(out.includes("hello"), "string content preserved");
});

test("highlight XSS-safe: code block with HTML tags", () => {
  const out = formatMessage("```\n<script>alert(1)</script>\n```");
  assert.ok(!out.includes("<script>"), "raw script tag escaped");
  assert.ok(out.includes("&lt;script&gt;"), "angle brackets escaped");
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

test("underscores in a URL never get italicized (no mangling)", () => {
  const out = formatMessage("see https://example.com/a_b_c_d");
  assert.ok(out.includes('href="https://example.com/a_b_c_d"'), "full URL preserved in href");
  assert.ok(out.includes(">https://example.com/a_b_c_d</a>"), "full URL preserved as link text");
  assert.ok(!out.includes("<em>"), "no stray italic from the underscores");
});

test("asterisks in a bare URL never bold; markup outside it still applies", () => {
  // Pins "links are extracted BEFORE the inlineMarkup pass" for the bold rule too
  // (the underscore/italic case is the test above). A refactor to a single sweep
  // that linkified LAST would turn the **…** inside the URL into <strong> and split
  // the href. The link scanner is one regex (makeLinkRe); inlineMarkup only runs on
  // the gaps between links.
  const out = formatMessage("**hi** https://example.com/a**b**c");
  assert.ok(out.includes("<strong>hi</strong>"), "real bold outside the URL still renders");
  assert.ok(out.includes('href="https://example.com/a**b**c"'), "full URL (asterisks and all) preserved in href");
  assert.ok(out.includes(">https://example.com/a**b**c</a>"), "full URL preserved as link text");
  assert.equal((out.match(/<strong>/g) || []).length, 1, "no stray bold from the URL's asterisks");
});

test("markdown link [text](url) renders as an anchor", () => {
  const out = formatMessage("see [the docs](https://example.com/docs)");
  assert.ok(out.includes('<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">the docs</a>'));
  assert.ok(!out.includes("](https"), "raw markdown syntax consumed");
});

test("markdown link text may carry inline markup", () => {
  const out = formatMessage("[**bold** link](https://x.com)");
  assert.ok(out.includes('<a href="https://x.com"'));
  assert.ok(out.includes("<strong>bold</strong>"));
});

test("markdown link with a non-http scheme stays literal text", () => {
  const out = formatMessage("[click](javascript:alert(1))");
  assert.ok(!out.includes("<a "), "javascript: target must not become a link");
  assert.ok(out.includes("[click]"), "left as literal text");
});

test("markdown link URL is not also autolinked or imaged", () => {
  const out = formatMessage("[pic](https://x.com/c.png)");
  assert.ok(out.includes(">pic</a>"), "renders the author's text, not an image");
  assert.ok(!out.includes("<img"), "explicit link text suppresses image embedding");
});

test("angle-bracket <url> renders a plain link with brackets stripped", () => {
  const out = formatMessage("<https://example.com/page>");
  assert.ok(out.includes('<a href="https://example.com/page" target="_blank" rel="noopener noreferrer">https://example.com/page</a>'), "plain link, no brackets in href/text");
  assert.ok(!out.includes("&gt;</a>"), "closing bracket not glued onto the URL");
  assert.ok(!out.includes("&lt;https"), "opening bracket consumed");
});

test("angle-bracket <imageurl> suppresses the inline image (plain link instead)", () => {
  const out = formatMessage("<https://example.com/cat.gif>");
  assert.ok(!out.includes("<img"), "no image embed for an angle-bracketed image URL");
  assert.ok(out.includes('href="https://example.com/cat.gif"'), "renders as a plain link");
});

test("angle-bracket autolink preserves a query string with &", () => {
  const out = formatMessage("<https://example.com/x?a=1&b=2>");
  assert.ok(out.includes('href="https://example.com/x?a=1&amp;b=2"'), "full query kept, & escaped, no trailing bracket");
});

test("bare image URL renders inline as an image", () => {
  const out = formatMessage("https://example.com/cat.gif");
  assert.ok(out.includes('<img class="msg-image" src="https://example.com/cat.gif"'));
  // Bare-URL images carry msg-image-url so the author "remove embed" affordance can find them.
  assert.ok(out.includes('class="msg-image-link msg-image-url"'), "image wrapped in a link to the full URL");
});

test("image embedding can be disabled (search rows)", () => {
  const out = formatMessage("https://example.com/cat.gif", null, null, { embedImages: false });
  assert.ok(!out.includes("<img"), "no inline image when embedImages is false");
  assert.ok(out.includes('href="https://example.com/cat.gif"'), "falls back to a plain link");
});

test("image URL with a query string is still detected", () => {
  const out = formatMessage("https://example.com/pic.jpg?w=200&h=100");
  // & was escaped before matching; the image must still be recognized.
  assert.ok(out.includes('<img class="msg-image" src="https://example.com/pic.jpg?w=200&amp;h=100"'));
});

test("non-image bare URL still autolinks (not imaged)", () => {
  const out = formatMessage("https://example.com/page");
  assert.ok(out.includes('<a href="https://example.com/page"'));
  assert.ok(!out.includes("<img"));
});

test("trailing period on a bare URL stays out of the link", () => {
  const out = formatMessage("see https://example.com/page.");
  assert.ok(out.includes('href="https://example.com/page"'), "period excluded from href");
  assert.ok(out.includes(">https://example.com/page</a>"), "period excluded from link text");
  assert.ok(out.endsWith("."), "period rendered as trailing plain text");
});

test("multiple trailing periods on a bare URL are all stripped", () => {
  const out = formatMessage("https://example.com/x...");
  assert.ok(out.includes('href="https://example.com/x"'));
  assert.ok(out.includes(">https://example.com/x</a>..."), "all dots become trailing text");
});

test("a trailing period on a bare image URL is excluded", () => {
  const out = formatMessage("https://example.com/cat.gif.");
  assert.ok(out.includes('src="https://example.com/cat.gif"'), "image src has no trailing dot");
  assert.ok(out.endsWith("."), "the period renders after the image");
});

test("trailing period inside an explicit markdown link is preserved", () => {
  const out = formatMessage("[docs](https://example.com/page.)");
  assert.ok(out.includes('href="https://example.com/page."'), "author-delimited URL kept verbatim");
});

test("links and images stay XSS-safe", () => {
  const out = formatMessage('[x](https://e.com/"onmouseover="alert(1))');
  assert.ok(!out.includes('"onmouseover='), "a quote in the URL is escaped, can't break the attribute");
  const img = formatMessage('https://e.com/a.png" onerror="alert(1)');
  // The space ends the bare URL token, so the trailing attribute payload is just
  // escaped text, never part of the tag.
  assert.ok(!img.includes('onerror="alert'), "no live event handler injected");
});

test("an image URL inside a code span is left as text", () => {
  const out = formatMessage("`https://example.com/cat.gif`");
  assert.ok(out.includes("<code>https://example.com/cat.gif</code>"));
  assert.ok(!out.includes("<img"), "code spans are never imaged");
});

test("newlines become breaks", () => {
  assert.equal(formatMessage("a\nb"), "a<br>b");
});

test("blockquote", () => {
  const out = formatMessage("> quoted");
  assert.ok(out.includes("<blockquote>quoted</blockquote>"));
});

test("blockquote adjacent to text has no extra <br> separators", () => {
  const out = formatMessage("before\n> quote\nafter");
  assert.ok(!out.includes("<br><blockquote>"), "no <br> before blockquote");
  assert.ok(!out.includes("</blockquote><br>"), "no <br> after blockquote");
  assert.ok(out.includes("before<blockquote>quote</blockquote>after"));
});

test("multi-line blockquote is one container, not adjacent quotes", () => {
  const out = formatMessage("> line one\n> line two");
  assert.equal((out.match(/<blockquote>/g) || []).length, 1, "single blockquote");
  assert.ok(out.includes("line one<br>line two"), "inner lines kept on separate lines");
});

test("nested blockquote peels one level per layer", () => {
  const out = formatMessage("> > deep");
  assert.ok(out.includes("<blockquote><blockquote>deep</blockquote></blockquote>"));
});

test("quoted table renders as a real table (forwarded message)", () => {
  // Forwarding prefixes every line with "> "; the table must still parse.
  const out = formatMessage("*Forwarded:*\n> | A | B |\n> | --- | --- |\n> | 1 | 2 |");
  assert.ok(out.includes("<blockquote>"), "wrapped in a blockquote");
  assert.ok(out.includes('<table class="md-table">'), "table renders inside the quote");
  assert.ok(out.includes("<th>A</th><th>B</th>"), "header cells parsed");
  assert.ok(out.includes("<td>1</td><td>2</td>"), "body cells parsed");
  assert.ok(!out.includes("&gt;"), "no leftover literal quote markers");
});

test("quoted fenced code block renders verbatim, no quote markers in code", () => {
  const out = formatMessage("> ```go\n> x := 1\n> ```");
  assert.ok(out.includes('<pre class="code-block"'), "code block renders inside quote");
  assert.ok(out.includes('data-lang="go"'), "language hint survives quoting");
  assert.ok(out.includes("x :="), "code body present");
  assert.ok(!out.includes("&gt;"), "no leftover quote markers baked into the code");
});

test("quoted list renders as a <ul> inside the blockquote", () => {
  const out = formatMessage("> - one\n> - two");
  assert.ok(out.includes("<blockquote><ul><li>one</li><li>two</li></ul></blockquote>"));
});

test("markdown headers h1-h3", () => {
  assert.ok(formatMessage("# Title").includes("<h3>Title</h3>"));
  assert.ok(formatMessage("## Sub").includes("<h4>Sub</h4>"));
  assert.ok(formatMessage("### Fine").includes("<h5>Fine</h5>"));
});

test("# without space is not a header", () => {
  const out = formatMessage("#notaheader");
  assert.ok(!out.includes("<h"));
});

test("markdown table renders header + body rows", () => {
  const out = formatMessage("| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
  assert.ok(out.includes('<table class="md-table">'));
  assert.ok(out.includes("<thead><tr><th>A</th><th>B</th></tr></thead>"));
  assert.ok(out.includes("<tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody>"));
  // No stray <br> around the block table.
  assert.ok(!out.includes("<br>"));
});

test("table without outer pipes still parses", () => {
  const out = formatMessage("A | B\n--- | ---\n1 | 2");
  assert.ok(out.includes("<th>A</th><th>B</th>"));
  assert.ok(out.includes("<td>1</td><td>2</td>"));
});

test("table column alignment from delimiter colons", () => {
  const out = formatMessage("| L | C | R |\n| :-- | :-: | --: |\n| a | b | c |");
  assert.ok(out.includes('<th style="text-align:left">L</th>'));
  assert.ok(out.includes('<th style="text-align:center">C</th>'));
  assert.ok(out.includes('<th style="text-align:right">R</th>'));
  assert.ok(out.includes('<td style="text-align:center">b</td>'));
});

test("table cells run the inline pipeline (bold, code)", () => {
  const out = formatMessage("| H |\n| --- |\n| **x** `y` |");
  assert.ok(out.includes("<td><strong>x</strong> <code>y</code></td>"));
});

test("table cell content is escaped (XSS-safe)", () => {
  const out = formatMessage("| H |\n| --- |\n| <img src=x> |");
  assert.ok(out.includes("&lt;img src=x&gt;"));
  assert.ok(!out.includes("<img src=x>"));
});

test("ragged body rows pad/truncate to header width", () => {
  const out = formatMessage("| A | B |\n| --- | --- |\n| 1 |\n| x | y | z |");
  assert.ok(out.includes("<tr><td>1</td><td></td></tr>"), "missing cell padded");
  assert.ok(out.includes("<tr><td>x</td><td>y</td></tr>"), "extra cell dropped");
});

test("pipe line without a delimiter row is not a table", () => {
  const out = formatMessage("a | b | c\nd | e | f");
  assert.ok(!out.includes("<table"));
  assert.ok(out.includes("a | b | c<br>d | e | f"));
});

test("escaped pipe stays literal inside a cell", () => {
  const out = formatMessage("| H |\n| --- |\n| a \\| b |");
  assert.ok(out.includes("<td>a | b</td>"));
});

test("header-only table (no body rows) renders just a head", () => {
  const out = formatMessage("| A | B |\n| --- | --- |");
  assert.ok(out.includes("<thead><tr><th>A</th><th>B</th></tr></thead>"));
  assert.ok(!out.includes("<tbody>"));
});

test("unordered list with * and - bullets", () => {
  assert.equal(formatMessage("* one\n* two"), "<ul><li>one</li><li>two</li></ul>");
  assert.equal(formatMessage("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
});

test("list items run the inline pipeline", () => {
  const out = formatMessage("* **bold** item\n* `code` item");
  assert.ok(out.includes("<li><strong>bold</strong> item</li>"));
  assert.ok(out.includes("<li><code>code</code> item</li>"));
});

test("list adjacent to text has no extra <br> separators", () => {
  const out = formatMessage("before\n* item\nafter");
  assert.ok(!out.includes("<br><ul>"), "no <br> before list");
  assert.ok(!out.includes("</ul><br>"), "no <br> after list");
  assert.ok(out.includes("before<ul><li>item</li></ul>after"));
});

test("*foo* italicizes but * foo lists (no collision)", () => {
  assert.equal(formatMessage("*foo*"), "<em>foo</em>");
  assert.equal(formatMessage("* foo"), "<ul><li>foo</li></ul>");
});

test("bold and italic render inside list items", () => {
  // Each <li>'s content runs through the inline pipeline, so markdown styles work
  // inside a bullet — including a bold/italic split across two items.
  assert.equal(
    formatMessage("* **bold** and *italic*"),
    "<ul><li><strong>bold</strong> and <em>italic</em></li></ul>",
  );
  assert.equal(
    formatMessage("- **a**\n- *b*"),
    "<ul><li><strong>a</strong></li><li><em>b</em></li></ul>",
  );
});

test("bold may contain a nested italic (regression: ** body with a lone *)", () => {
  // The bold body holds a single `*` (the *why* markers). The old `[^*]+` body
  // forbade any star, so the bold rule didn't match at all and the ** leaked as
  // literal text while only the inner italic rendered. Pins both directions.
  assert.equal(formatMessage("**a *b* c**"), "<strong>a <em>b</em> c</strong>");
  assert.equal(
    formatMessage("- **a point, with the *why*.**"),
    "<ul><li><strong>a point, with the <em>why</em>.</strong></li></ul>",
  );
  // adjacent bold spans must not merge across the gap (non-greedy body)
  assert.equal(formatMessage("**x** and **y**"), "<strong>x</strong> and <strong>y</strong>");
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

test("replySnippet condenses a message body to a one-line preview", () => {
  assert.equal(replySnippet(""), "");
  assert.equal(replySnippet(null), "");
  assert.equal(replySnippet("hello world"), "hello world");
  // multi-line collapses to a single line
  assert.equal(replySnippet("line one\nline two"), "line one line two");
  // image markdown becomes a token, not a raw URL
  assert.equal(replySnippet("![pic](/api/blobs/" + "a".repeat(64) + ")"), "🖼 image");
  // [text](url) keeps only the text
  assert.equal(replySnippet("see [the docs](https://example.com/x)"), "see the docs");
  // backticks are dropped
  assert.equal(replySnippet("run `make test` now"), "run make test now");
  // long bodies truncate with an ellipsis
  const long = replySnippet("x".repeat(200));
  assert.ok(long.length <= 80, "snippet is bounded");
  assert.ok(long.endsWith("…"), "truncated snippet ends with an ellipsis");
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

test("formatMessage only styles real @mentions when users map is provided", () => {
  const users = { 1: { username: "alice" }, 2: { username: "bob" } };
  const out = formatMessage("hi @bob and @me and @alice", "alice", null, { users });
  assert.ok(out.includes('<span class="mention">@bob</span>'), "known user styled");
  assert.ok(out.includes('<span class="mention mention-me">@alice</span>'), "own mention flagged");
  assert.ok(!out.includes('<span class="mention">@me</span>'), "unknown @me not styled");
  assert.ok(out.includes("@me"), "unknown @me left as plain text");
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

test("colonQuery finds the :emoji token immediately before the caret", () => {
  assert.deepEqual(colonQuery(":part", 5), { start: 0, partial: "part" });
  assert.deepEqual(colonQuery("hi :part", 8), { start: 3, partial: "part" });
  assert.deepEqual(colonQuery("hi :", 4), { start: 3, partial: "" }, "bare colon at a boundary opens the picker");
  // caret mid-token: only chars before the caret form the partial
  assert.deepEqual(colonQuery(":party", 3), { start: 0, partial: "pa" });
});

test("colonQuery returns null inside words, URLs, times, and ratios", () => {
  assert.equal(colonQuery("hello", 5), null, "no colon present");
  assert.equal(colonQuery("note:", 5), null, "colon attached to a word");
  assert.equal(colonQuery("https://x.com", 6), null, "URL scheme colon");
  assert.equal(colonQuery("at 3:30", 7), null, "time colon (word char before)");
  assert.equal(colonQuery("ratio 16:9", 10), null, "ratio colon");
  assert.equal(colonQuery("Foo::Bar", 8), null, "double colon");
  assert.equal(colonQuery(":party", 0), null, "caret before the colon");
});

test("custom emoji: known :shortcode: renders as an <img>, unknown stays literal", () => {
  const emojis = new Set(["party", "smile_cat"]);
  const out = formatMessage("yay :party: and :nope:", "me", emojis);
  assert.ok(out.includes('<img class="emoji" src="/api/emojis/party/image"'), "known shortcode -> img");
  assert.ok(out.includes('alt=":party:"'));
  assert.ok(out.includes(":nope:"), "unknown shortcode left as literal text");
  assert.ok(!out.includes("/api/emojis/nope/"), "unknown shortcode not turned into an image");
});

test("custom emoji: registry may be a plain object keyed by shortcode", () => {
  const out = formatMessage(":party:", "me", { party: { shortcode: "party" } });
  assert.ok(out.includes('src="/api/emojis/party/image"'));
});

test("custom emoji: no registry means shortcodes are inert", () => {
  assert.equal(formatMessage(":party:"), ":party:");
});

test("custom emoji: a shortcode with underscores is not mangled by italics", () => {
  // The italic rule keys on _x_; a multi-underscore shortcode rendered in place
  // would be corrupted. Splitting on the token keeps the <img> intact.
  const emojis = new Set(["a_b_c"]);
  const out = formatMessage(":a_b_c:", "me", emojis);
  assert.equal(out, '<img class="emoji" src="/api/emojis/a_b_c/image" alt=":a_b_c:" title=":a_b_c:" loading="lazy">');
  assert.ok(!out.includes("<em>"), "no stray italic inside the generated tag");
});

test("custom emoji: not rendered inside code spans or fenced blocks", () => {
  const emojis = new Set(["party"]);
  assert.ok(formatMessage("`:party:`", "me", emojis).includes("<code>:party:</code>"));
  assert.ok(formatMessage("```\n:party:\n```", "me", emojis).includes("<code>:party:</code>"));
});

test("custom emoji: markdown around an emoji still applies to the text", () => {
  const emojis = new Set(["party"]);
  const out = formatMessage("**bold** :party:", "me", emojis);
  assert.ok(out.includes("<strong>bold</strong>"));
  assert.ok(out.includes('src="/api/emojis/party/image"'));
});

test("builtin emoji: known shortcodes render as Unicode glyphs", () => {
  const out = formatMessage(":joy: :pray: :fire:", "me", null);
  assert.ok(out.includes("😂"), ":joy: renders glyph");
  assert.ok(out.includes("🙏"), ":pray: renders glyph");
  assert.ok(out.includes("🔥"), ":fire: renders glyph");
  assert.ok(out.includes('title=":joy:"'), "title attribute set");
});

test("builtin emoji: :+1: with plus sign renders correctly", () => {
  const out = formatMessage(":+1:", "me", null);
  assert.ok(out.includes("👍"), ":+1: renders thumbs-up glyph");
});

test("builtin emoji: :100: all-digit shortcode renders", () => {
  const out = formatMessage(":100:", "me", null);
  assert.ok(out.includes("💯"));
});

test("builtin emoji: :symbolic_heart: renders heart", () => {
  const out = formatMessage(":symbolic_heart:", "me", null);
  assert.ok(out.includes("❤️"));
});

test("builtin emoji: renders even with no custom emoji registry", () => {
  assert.ok(formatMessage(":wave:", "me", null).includes("👋"));
  assert.ok(formatMessage(":wave:", "me", undefined).includes("👋"));
});

test("builtin emoji: unknown shortcode still passes through", () => {
  assert.ok(formatMessage(":unknown_xyz:", "me", null).includes(":unknown_xyz:"));
});

test("builtin emoji: not rendered inside code spans", () => {
  assert.ok(formatMessage("`:fire:`", "me", null).includes(":fire:"));
});

test("builtin emoji: BUILTIN_EMOJI export has expected entries", () => {
  assert.equal(BUILTIN_EMOJI["+1"], "👍");
  assert.equal(BUILTIN_EMOJI.joy, "😂");
  assert.equal(BUILTIN_EMOJI.symbolic_heart, "❤️");
  assert.equal(BUILTIN_EMOJI.white_check, "✅");
  assert.equal(BUILTIN_EMOJI["100"], "💯");
});

test("builtin emoji: BUILTIN_EMOJI_LIST is the ordered source and the map derives from it", () => {
  // The list dictates the emoji picker's quick-palette order, so its head is pinned.
  // (The map can't carry order: "100" would hoist to the front as an integer key.)
  assert.deepEqual(BUILTIN_EMOJI_LIST[0], ["+1", "👍"]);
  assert.deepEqual(BUILTIN_EMOJI_LIST[1], ["thumbsdown", "👎"]);
  assert.equal(Object.fromEntries(BUILTIN_EMOJI_LIST)["100"], BUILTIN_EMOJI["100"]);
  assert.equal(BUILTIN_EMOJI_LIST.length, Object.keys(BUILTIN_EMOJI).length);
});

test("emoticons: :D :) :( ;) render as glyphs", () => {
  assert.ok(formatMessage("hello :D world").includes("😁"), ":D");
  assert.ok(formatMessage("hello :) world").includes("🙂"), ":)");
  assert.ok(formatMessage("hello :( world").includes("🙁"), ":(");
  assert.ok(formatMessage("hello ;) world").includes("😉"), ";)");
});

test("emoticons: <3 renders as heart", () => {
  assert.ok(formatMessage("I <3 this").includes("❤️"), "<3 → ❤️");
  assert.ok(formatMessage("<3").includes("❤️"), "<3 at start of string → ❤️");
});

test("emoticons: <3 does not fire mid-word (1<3 is a comparison, not a heart)", () => {
  assert.ok(!formatMessage("1<3").includes("❤️"), "1<3 not a heart");
  assert.ok(!formatMessage("x<3").includes("❤️"), "x<3 not a heart");
  assert.ok(!formatMessage("a<3").includes("❤️"), "a<3 not a heart");
  assert.ok(!formatMessage("5<300").includes("❤️"), "5<300 not a heart (trailing digit)");
});

test("emoticons: do not fire mid-word or after colon", () => {
  assert.ok(!formatMessage(":Database").includes("😁"), ":Database not a smiley");
  assert.ok(!formatMessage("::D").includes("😁"), "::D not a smiley");
  assert.ok(!formatMessage("http://x.com:D/y").includes("😁"), "URL colon-D not a smiley");
});

test("colonQuery: uppercase after colon does not open picker", () => {
  assert.equal(colonQuery(":D", 2), null, ":D should not trigger");
  assert.equal(colonQuery(":Fire", 5), null, ":Fire should not trigger");
  assert.equal(colonQuery("hello :B", 8), null, ":B should not trigger");
});

test("colonQuery: lowercase still triggers normally", () => {
  assert.deepEqual(colonQuery(":fire", 5), { start: 0, partial: "fire" });
  assert.deepEqual(colonQuery("hello :joy", 10), { start: 6, partial: "joy" });
});

test("hashQuery finds the #channel token immediately before the caret", () => {
  assert.deepEqual(hashQuery("#general", 8), { start: 0, partial: "general" });
  assert.deepEqual(hashQuery("see #gen", 8), { start: 4, partial: "gen" });
  assert.deepEqual(hashQuery("see #", 5), { start: 4, partial: "" });
  assert.deepEqual(hashQuery("#gen", 3), { start: 0, partial: "ge" });
  assert.deepEqual(hashQuery("#my-channel", 11), { start: 0, partial: "my-channel" });
});

test("hashQuery returns null when there is no valid trigger", () => {
  assert.equal(hashQuery("hello world", 11), null, "no # present");
  assert.equal(hashQuery("id#123", 6), null, "word char before #");
  assert.equal(hashQuery("path/#section", 13), null, "/ before #");
  assert.equal(hashQuery("#general", 0), null, "caret before #");
  assert.equal(hashQuery("text #gen", 5), null, "caret lands on #, not past it");
  assert.equal(hashQuery("#General", 8), null, "uppercase after # does not trigger");
  assert.equal(hashQuery("#123", 4), null, "digit-only start does not trigger");
});

test("formatMessage renders known #channel as a clickable link", () => {
  const channels = { 5: { id: 5, name: "general", is_dm: false } };
  const out = formatMessage("check #general for updates", null, null, { channels });
  assert.ok(out.includes('class="channel-link"'), "channel-link class present");
  assert.ok(out.includes('data-channel-id="5"'), "channel id present");
  assert.ok(out.includes("#general"), "channel name present");
});

test("formatMessage leaves unknown #name as plain text", () => {
  const channels = { 5: { id: 5, name: "general", is_dm: false } };
  const out = formatMessage("see #unknown channel", null, null, { channels });
  assert.ok(!out.includes("channel-link"), "unknown channel is not linkified");
  assert.ok(out.includes("#unknown"), "text preserved");
});

test("formatMessage does not linkify #channel when channels opt is omitted", () => {
  const out = formatMessage("check #general please");
  assert.ok(!out.includes("channel-link"), "no linkification without channels opt");
  assert.ok(out.includes("#general"), "text preserved");
});

test("permalinkHash builds the canonical no-slash hash", () => {
  assert.equal(permalinkHash(5, 123), "#c5/m123");
});

test("parsePermalink round-trips permalinkHash", () => {
  assert.deepEqual(parsePermalink(permalinkHash(5, 123)), { channelId: 5, messageId: 123 });
});

test("pingLabel: a DM is just the sender's name; a channel reads '<who> in #<name>'", () => {
  assert.equal(pingLabel("Frodo", { is_dm: true, name: "ignored" }), "Frodo");
  assert.equal(pingLabel("Frodo", { is_dm: false, name: "shire" }), "Frodo in #shire");
  // A missing channel record falls back to a generic "#channel".
  assert.equal(pingLabel("Frodo", null), "Frodo in #channel");
});

// ---- shouldGroupMessage ----

test("shouldGroupMessage: same author within the window groups", () => {
  assert.equal(
    shouldGroupMessage(7, 1000, { user_id: 7, reply_to_id: null }, 1000 + 60_000),
    true);
});

test("shouldGroupMessage: a different author breaks the group", () => {
  assert.equal(
    shouldGroupMessage(7, 1000, { user_id: 8, reply_to_id: null }, 1000 + 1000),
    false);
});

test("shouldGroupMessage: a gap at or beyond the window breaks the group", () => {
  // Strictly-less-than: exactly GROUP_WINDOW_MS apart is NOT grouped.
  assert.equal(
    shouldGroupMessage(7, 1000, { user_id: 7, reply_to_id: null }, 1000 + GROUP_WINDOW_MS),
    false);
  assert.equal(
    shouldGroupMessage(7, 1000, { user_id: 7, reply_to_id: null }, 1000 + GROUP_WINDOW_MS - 1),
    true);
});

test("shouldGroupMessage: a reply always starts a fresh block", () => {
  assert.equal(
    shouldGroupMessage(7, 1000, { user_id: 7, reply_to_id: 42 }, 1000 + 1000),
    false);
});

test("shouldGroupMessage: a null previous author (run reset) never groups", () => {
  assert.equal(
    shouldGroupMessage(null, 0, { user_id: 7, reply_to_id: null }, 1000),
    false);
});

test("shouldGroupMessage: a custom window overrides the default", () => {
  const msg = { user_id: 7, reply_to_id: null };
  assert.equal(shouldGroupMessage(7, 1000, msg, 1000 + 5000, 10_000), true);
  assert.equal(shouldGroupMessage(7, 1000, msg, 1000 + 5000, 1000), false);
});

test("parsePermalink parses a valid hash", () => {
  assert.deepEqual(parsePermalink("#c42/m1009"), { channelId: 42, messageId: 1009 });
});

// --- blob image tests --------------------------------------------------------

const FAKE_HASH = "a".repeat(64); // 64-char hex string (all 'a', valid)

test("blob image ![alt](/api/blobs/<hash>) renders as an inline image", () => {
  const out = formatMessage(`![cat photo](/api/blobs/${FAKE_HASH})`);
  assert.ok(out.includes(`<img class="msg-image" src="/api/blobs/${FAKE_HASH}"`), "img tag present");
  assert.ok(out.includes("msg-image-link"), "wrapped in a link");
  assert.ok(!out.includes("!["), "markdown syntax consumed");
});

test("blob image is wrapped in a link to the blob URL", () => {
  const out = formatMessage(`![x](/api/blobs/${FAKE_HASH})`);
  assert.ok(out.includes(`href="/api/blobs/${FAKE_HASH}"`));
});

test("blob image with embedImages:false renders as a plain link (search rows)", () => {
  const out = formatMessage(`![photo](/api/blobs/${FAKE_HASH})`, null, null, { embedImages: false });
  assert.ok(!out.includes("<img"), "no img in search rows");
  assert.ok(out.includes(`href="/api/blobs/${FAKE_HASH}"`), "falls back to link");
});

test("blob image does not match a wrong-length or uppercase hash", () => {
  const shortHash = "a".repeat(63);
  const out1 = formatMessage(`![x](/api/blobs/${shortHash})`);
  assert.ok(!out1.includes("<img"), "short hash not matched");
  const upperHash = "A".repeat(64);
  const out2 = formatMessage(`![x](/api/blobs/${upperHash})`);
  assert.ok(!out2.includes("<img"), "uppercase hash not matched");
});

test("blob URL without the ![ prefix stays as a literal (not imaged)", () => {
  // A plain [text](/api/blobs/hash) without the ! is not a blob image.
  const out = formatMessage(`[file](/api/blobs/${FAKE_HASH})`);
  assert.ok(!out.includes("<img"), "no image without ! prefix");
});

test("blob image in a code span is left as literal text", () => {
  const out = formatMessage(`\`![x](/api/blobs/${FAKE_HASH})\``);
  assert.ok(out.includes("<code>"), "inside code span");
  assert.ok(!out.includes("<img"), "never imaged inside code");
});

test("blob image XSS: injected alt text is HTML-escaped before reaching the img", () => {
  // The alt text is captured from the already-escaped string, so any raw
  // HTML in the original is already safe. Verify via a full round-trip.
  const out = formatMessage(`![\"><script>bad</script>](/api/blobs/${FAKE_HASH})`);
  assert.ok(!out.includes("<script>"), "raw script tag must not survive");
});

// --- spoiler tag tests -------------------------------------------------------

test("spoiler: ||text|| renders a spoiler span", () => {
  const out = formatMessage("||secret||");
  assert.ok(out.includes('<span class="spoiler"'), "spoiler span present");
  assert.ok(out.includes("secret"), "content preserved");
  assert.ok(!out.includes("||"), "markers consumed");
});

test("spoiler: inline formatting inside a spoiler still applies", () => {
  const out = formatMessage("||**bold** secret||");
  assert.ok(out.includes('<span class="spoiler"'), "spoiler span present");
  assert.ok(out.includes("<strong>bold</strong>"), "bold inside spoiler rendered");
});

test("spoiler: unmatched || is rendered literally", () => {
  const out = formatMessage("hello ||world");
  assert.ok(!out.includes('<span class="spoiler"'), "no spoiler span without closing ||");
  assert.ok(out.includes("||world"), "literal text preserved");
});

test("spoiler: multiple spoilers on one line", () => {
  const out = formatMessage("||a|| and ||b||");
  assert.equal(out.match(/<span class="spoiler"/g)?.length, 2, "two spoiler spans");
});

test("spoiler: blob image inside a spoiler wraps the image", () => {
  const out = formatMessage(`||![photo](/api/blobs/${FAKE_HASH})||`);
  assert.ok(out.includes('<span class="spoiler"'), "spoiler span present");
  assert.ok(out.includes('<img class="msg-image"'), "image rendered inside");
});

test("spoiler: not rendered inside a code span", () => {
  const out = formatMessage("`||not a spoiler||`");
  assert.ok(out.includes("<code>||not a spoiler||</code>"), "inside code is literal");
  assert.ok(!out.includes('<span class="spoiler"'), "no spoiler span inside code");
});

test("spoiler: XSS — HTML in content is escaped", () => {
  const out = formatMessage('||<script>bad</script>||');
  assert.ok(!out.includes("<script>"), "raw tag escaped");
  assert.ok(out.includes("&lt;script&gt;"), "angle brackets escaped");
});

test("spoiler: replySnippet strips || markers", () => {
  assert.equal(replySnippet("||secret text||"), "secret text");
  assert.equal(replySnippet("before ||hidden|| after"), "before hidden after");
});

test("spoiler: spoiler with a link inside", () => {
  const out = formatMessage("||see https://example.com/page||");
  assert.ok(out.includes('<span class="spoiler"'), "spoiler span present");
  assert.ok(out.includes('href="https://example.com/page"'), "link inside spoiler rendered");
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

// extractMessagePermalinkURL
test("extractMessagePermalinkURL finds a bare same-origin permalink", () => {
  const r = extractMessagePermalinkURL("https://chat.example.com/#c28/m1684", "https://chat.example.com");
  assert.deepEqual(r, { url: "https://chat.example.com/#c28/m1684", channelId: 28, messageId: 1684 });
});

test("extractMessagePermalinkURL finds permalink embedded in surrounding text", () => {
  const r = extractMessagePermalinkURL("see https://chat.example.com/#c5/m99 for context", "https://chat.example.com");
  assert.deepEqual(r, { url: "https://chat.example.com/#c5/m99", channelId: 5, messageId: 99 });
});

test("extractMessagePermalinkURL ignores markdown-linked permalinks", () => {
  const r = extractMessagePermalinkURL("[link](https://chat.example.com/#c1/m2)", "https://chat.example.com");
  assert.equal(r, null);
});

test("extractMessagePermalinkURL ignores cross-origin URLs", () => {
  const r = extractMessagePermalinkURL("https://other.example.com/#c1/m2", "https://chat.example.com");
  assert.equal(r, null);
});

test("extractMessagePermalinkURL ignores non-permalink same-origin URLs", () => {
  const r = extractMessagePermalinkURL("https://chat.example.com/some/path", "https://chat.example.com");
  assert.equal(r, null);
});

test("extractMessagePermalinkURL returns null for empty or null input", () => {
  assert.equal(extractMessagePermalinkURL("", "https://chat.example.com"), null);
  assert.equal(extractMessagePermalinkURL(null, "https://chat.example.com"), null);
  assert.equal(extractMessagePermalinkURL("https://chat.example.com/#c1/m2", null), null);
});

test("extractMessagePermalinkURL returns first match when multiple permalinks present", () => {
  const r = extractMessagePermalinkURL(
    "https://chat.example.com/#c1/m10 and https://chat.example.com/#c2/m20",
    "https://chat.example.com"
  );
  assert.deepEqual(r, { url: "https://chat.example.com/#c1/m10", channelId: 1, messageId: 10 });
});

// --- dataUriToFile (composer channel-3 paste harvest) ---------------------

import { dataUriToFile } from "../static/format.js";

// 1×1 transparent PNG — the canonical tiny fixture.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("dataUriToFile: base64 PNG decodes byte-identical", async () => {
  const f = dataUriToFile("data:image/png;base64," + PNG_B64);
  assert.equal(f.type, "image/png");
  assert.equal(f.name, "pasted.png");
  const got = Buffer.from(await f.arrayBuffer());
  assert.ok(got.equals(Buffer.from(PNG_B64, "base64")), "decoded bytes must match the source exactly");
});

test("dataUriToFile: percent-encoded (non-base64) payload", async () => {
  const f = dataUriToFile("data:text/plain,hello%20world");
  assert.equal(f.type, "text/plain");
  assert.equal(f.name, "pasted.bin"); // unknown-to-the-ext-map MIME falls back to .bin
  assert.equal(Buffer.from(await f.arrayBuffer()).toString("utf8"), "hello world");
});

test("dataUriToFile: known MIME → extension mapping", () => {
  assert.equal(dataUriToFile("data:image/jpeg;base64,").name, "pasted.jpg");
  assert.equal(dataUriToFile("data:image/gif;base64,").name, "pasted.gif");
  assert.equal(dataUriToFile("data:image/webp;base64,").name, "pasted.webp");
});

test("dataUriToFile: missing MIME defaults to octet-stream", () => {
  const f = dataUriToFile("data:;base64," + Buffer.from("x").toString("base64"));
  assert.equal(f.type, "application/octet-stream");
});

test("dataUriToFile: malformed URI (no comma) throws", () => {
  assert.throws(() => dataUriToFile("data:image/png;base64"));
  assert.throws(() => dataUriToFile("not a uri at all"));
});

test("dataUriToFile: base64 marker is case-insensitive", async () => {
  const f = dataUriToFile("data:image/png;BASE64," + PNG_B64);
  const got = Buffer.from(await f.arrayBuffer());
  assert.ok(got.equals(Buffer.from(PNG_B64, "base64")));
});

// extractFirstBareURL
test("extractFirstBareURL returns first bare https URL", () => {
  assert.equal(extractFirstBareURL("check https://github.com/foo"), "https://github.com/foo");
});

test("extractFirstBareURL skips markdown-linked URLs", () => {
  assert.equal(extractFirstBareURL("[repo](https://github.com/foo)"), null);
});

test("extractFirstBareURL skips markdown link but finds subsequent bare URL", () => {
  assert.equal(
    extractFirstBareURL("[repo](https://github.com/foo) and https://wikipedia.org/wiki/Test"),
    "https://wikipedia.org/wiki/Test",
  );
});

test("extractFirstBareURL returns null for no URL", () => {
  assert.equal(extractFirstBareURL("just some text"), null);
});

test("extractFirstBareURL also returns http:// bare URLs (server rejects non-https)", () => {
  assert.equal(extractFirstBareURL("http://github.com/foo"), "http://github.com/foo");
});

test("extractFirstBareURL skips an angle-bracketed <url> (embed opted out)", () => {
  assert.equal(extractFirstBareURL("<https://github.com/foo>"), null);
});

test("extractFirstBareURL skips <url> but finds a later bare URL", () => {
  assert.equal(
    extractFirstBareURL("<https://github.com/foo> then https://wikipedia.org/x"),
    "https://wikipedia.org/x",
  );
});

test("extractMessagePermalinkURL skips an angle-bracketed permalink", () => {
  assert.equal(extractMessagePermalinkURL("<https://chat.example.com/#c1/m2>", "https://chat.example.com"), null);
});

// suppressEmbedURL — the author "remove embed" rewrite
test("suppressEmbedURL wraps the first bare occurrence of the URL in <>", () => {
  assert.equal(
    suppressEmbedURL("look https://example.com/cat.gif nice", "https://example.com/cat.gif"),
    "look <https://example.com/cat.gif> nice",
  );
});

test("suppressEmbedURL leaves the URL outside trailing punctuation", () => {
  assert.equal(
    suppressEmbedURL("see https://example.com/x.png.", "https://example.com/x.png"),
    "see <https://example.com/x.png>.",
  );
});

test("suppressEmbedURL ignores a markdown-linked or already-wrapped URL", () => {
  assert.equal(
    suppressEmbedURL("[pic](https://example.com/c.png)", "https://example.com/c.png"),
    "[pic](https://example.com/c.png)",
  );
  assert.equal(
    suppressEmbedURL("<https://example.com/c.png>", "https://example.com/c.png"),
    "<https://example.com/c.png>",
  );
});

test("suppressEmbedURL is a no-op when the URL isn't present", () => {
  assert.equal(suppressEmbedURL("nothing here", "https://example.com/x"), "nothing here");
});

test("isImageURL recognizes image extensions, bare or with query/trailing dot", () => {
  assert.equal(isImageURL("https://x.com/a.JPG"), true);
  assert.equal(isImageURL("https://x.com/a.png?v=2"), true);
  assert.equal(isImageURL("https://x.com/a.gif."), true);
  assert.equal(isImageURL("https://x.com/page"), false);
  assert.equal(isImageURL(""), false);
});

// --- decidePermalinkRoute: the notification-click routing decision -----------
// (the pure half of notifyui's routeToPermalink: parse + guard + de-dupe)

const NONE = { key: "", at: 0 }; // a "nothing routed yet" de-dupe record

test("decidePermalinkRoute jumps to a message permalink", () => {
  const r = decidePermalinkRoute("#c5/m123", { channelLoaded: () => false, now: 1000, last: NONE });
  assert.equal(r.skip, false);
  assert.equal(r.action, "jump");
  assert.equal(r.channelId, 5);
  assert.equal(r.messageId, 123);
  assert.deepEqual(r.last, { key: "5/123", at: 1000 });
});

test("decidePermalinkRoute jumps even when the channel isn't loaded (closed DM)", () => {
  // jumpToMessage self-handles fetch/reopen — the guard must NOT swallow this.
  const r = decidePermalinkRoute("#c9/m50", { channelLoaded: () => false, now: 1000, last: NONE });
  assert.equal(r.action, "jump");
  assert.equal(r.channelId, 9);
});

test("decidePermalinkRoute selects a channel for the messageId-0 ring sentinel when loaded", () => {
  const r = decidePermalinkRoute("#c7/m0", { channelLoaded: (id) => id === 7, now: 1000, last: NONE });
  assert.equal(r.skip, false);
  assert.equal(r.action, "select");
  assert.equal(r.channelId, 7);
});

test("decidePermalinkRoute does nothing for the ring sentinel when the channel isn't loaded", () => {
  const r = decidePermalinkRoute("#c7/m0", { channelLoaded: () => false, now: 1000, last: NONE });
  assert.equal(r.skip, false);
  assert.equal(r.action, "none");
  // still recorded, so an immediate duplicate is collapsed
  assert.deepEqual(r.last, { key: "7/0", at: 1000 });
});

test("decidePermalinkRoute skips a non-permalink hash and leaves last untouched", () => {
  const last = { key: "5/123", at: 500 };
  const r = decidePermalinkRoute("#not-a-permalink", { channelLoaded: () => true, now: 1000, last });
  assert.equal(r.skip, true);
  assert.equal(r.last, last);
});

test("decidePermalinkRoute de-dupes a repeat of the same target inside the window", () => {
  const last = { key: "5/123", at: 1000 };
  const r = decidePermalinkRoute("#c5/m123", { channelLoaded: () => true, now: 1000 + ROUTE_DEDUPE_MS - 1, last });
  assert.equal(r.skip, true);
  assert.equal(r.last, last); // unchanged
});

test("decidePermalinkRoute routes again once the de-dupe window has passed", () => {
  const last = { key: "5/123", at: 1000 };
  const r = decidePermalinkRoute("#c5/m123", { channelLoaded: () => true, now: 1000 + ROUTE_DEDUPE_MS, last });
  assert.equal(r.skip, false);
  assert.equal(r.action, "jump");
  assert.deepEqual(r.last, { key: "5/123", at: 1000 + ROUTE_DEDUPE_MS });
});

test("decidePermalinkRoute does not de-dupe a different target inside the window", () => {
  const last = { key: "5/123", at: 1000 };
  const r = decidePermalinkRoute("#c5/m124", { channelLoaded: () => true, now: 1001, last });
  assert.equal(r.skip, false);
  assert.equal(r.action, "jump");
  assert.equal(r.messageId, 124);
});
