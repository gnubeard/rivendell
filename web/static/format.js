// format.js — turn a plain-text message into safe HTML.
//
// Security model: the input is UNTRUSTED. We escape all HTML first, then apply a
// small, fixed set of inline markdown rules to the *escaped* string. Because the
// raw text can no longer contain real tags after escaping, the markdown pass can
// only ever introduce the specific tags we add ourselves. Fenced code blocks are
// the one exception: their raw content is handed to the syntax highlighter, which
// escapes it internally.
//
// Block parsing is line-based (renderBlocks): a ``` line opens a fenced code block
// (closed by the next ``` line); a run of `>` lines is a blockquote whose inner
// lines are stripped of one quote level and rendered RECURSIVELY as their own
// blocks. That recursion is what lets a quoted table or quoted code block — e.g. a
// forwarded message, where every line is prefixed with `> ` — render as the real
// block instead of a wall of broken quote lines. Fences must sit at the start of a
// line (after any quote markers), matching standard Markdown.
//
// Supported: ```fenced code```, `inline code`, **bold**, *italic*, _italic_,
// ~~strike~~, > blockquote (recursive), # headers, * / - lists, | tables |,
// [text](url) links, autolinked http(s) URLs, inline images (a bare URL pointing
// at an image renders the image), and newlines.
//
// This module is pure (no DOM, no globals) so it can be unit-tested under Node.

import { highlight } from "./syntax.js";

export function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// MENTION_RE matches an @username token that isn't part of an email/URL: the @
// must be at the start or follow a non-word, non-slash character. Usernames are
// [a-z0-9_]{2,32}; we accept any case here and lower-case for comparison.
const MENTION_RE = /(^|[^A-Za-z0-9_/])@([A-Za-z0-9_]{2,32})/g;

// CHANNEL_RE matches a #channelname token that isn't part of a URL fragment or
// word: # must be at the start or follow a non-word, non-slash character. Channel
// names start with a lowercase letter and contain [a-z0-9_-]. The boundary guard
// prevents firing on URL fragments (path/#section) or mid-word hashes.
const CHANNEL_RE = /(^|[^A-Za-z0-9_/])#([a-z][a-z0-9_-]{0,31})/g;

// mentionsUser reports whether `content` @-mentions `username` (case-insensitive,
// boundary-aware). Pure; used both for rendering highlights and notifications.
export function mentionsUser(content, username) {
  if (!content || !username) return false;
  const target = String(username).toLowerCase();
  MENTION_RE.lastIndex = 0;
  let m;
  while ((m = MENTION_RE.exec(content)) !== null) {
    if (m[2].toLowerCase() === target) return true;
  }
  return false;
}

// replySnippet condenses a message body into a one-line plaintext preview for the
// reply-reference chip (the "↪ Author: …" line above a reply and the composer's
// "Replying to" bar). Image-upload markdown collapses to a token, [text](url) keeps
// only its text, backticks are dropped, and runs of whitespace fold so a multi-line
// quote stays on one line. Pure and DOM-free — the result is rendered as a text node
// (never innerHTML), so it carries no escaping obligation of its own.
export function replySnippet(content, max = 80) {
  if (!content) return "";
  let s = String(content)
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "🖼 image") // image markdown → token
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, "$1")      // [text](url) → text
    .replace(/`{1,3}/g, "")                            // drop code fences/backticks
    .replace(/\|\|/g, "")                              // strip spoiler markers
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + "…";
  return s;
}

// applyEmoticons substitutes classic text emoticons with their Unicode glyphs.
// Runs on already-escaped text: <3 arrives as &lt;3. Negative lookbehind/ahead
// prevent firing mid-word (:Database) or inside URLs (http://x.com:D/y).
function applyEmoticons(s) {
  s = s.replace(/(?<![:\w]):D(?!\w)/g, "😁");
  s = s.replace(/(?<![:\w]):\)(?!\w)/g, "🙂");
  s = s.replace(/(?<![:\w]):\((?!\w)/g, "🙁");
  s = s.replace(/&lt;3(?!\d)/g, "❤️");
  return s;
}

// Apply text-only inline rules (bold/italic/strike/mentions/channels) to an
// already-escaped run. This deliberately does NOT touch links — link extraction
// happens one layer up in inline(), so a URL is never fed through these regexes
// (that is what keeps underscores in a URL from being chewed into <em>).
function inlineMarkup(escaped, meLower, channels, usernames) {
  let out = applyEmoticons(escaped);
  // Bold then italic (order matters so ** isn't eaten by *).
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // Mentions: style @username only for known usernames (when a set is provided).
  // When no set is provided all @tokens are styled (backward-compat / tests).
  // The captured name is [A-Za-z0-9_], so it can't carry HTML metacharacters.
  out = out.replace(MENTION_RE, (full, pre, name) => {
    const nameLower = name.toLowerCase();
    if (usernames && !usernames.has(nameLower)) return full;
    const cls = meLower && nameLower === meLower ? "mention mention-me" : "mention";
    return `${pre}<span class="${cls}">@${name}</span>`;
  });
  // Channel links: #channelname → clickable link when the channel exists.
  // Channel names are [a-z0-9_-], so they can't carry HTML metacharacters.
  if (channels) {
    CHANNEL_RE.lastIndex = 0;
    out = out.replace(CHANNEL_RE, (full, pre, name) => {
      const ch = Object.values(channels).find((c) => !c.is_dm && c.name === name);
      if (!ch) return full;
      return `${pre}<a class="channel-link" data-channel-id="${ch.id}">#${name}</a>`;
    });
  }
  return out;
}

// LINK_RE matches, in priority order, a markdown link [text](url) OR a bare
// http(s) URL. Run against the *escaped* string: `[`, `]`, `(`, `)` survive
// escaping untouched, and only https?:// schemes are accepted (so `[x](javascript:…)`
// and a bare `javascript:` never become links). The markdown URL stops at `)` or
// whitespace; the bare URL stops at whitespace (the `<` guard is moot post-escape).
const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)/g;

// BLOB_IMG_RE matches the image markdown written by the client for uploaded blobs:
// ![alt](/api/blobs/<sha256-hex>). The path is a controlled server-side route and
// the hash is exactly 64 lowercase hex characters — safe to embed without further
// sanitisation. Processed before LINK_RE so the `!` prefix is consumed cleanly.
const BLOB_IMG_RE = /!\[([^\]\n]*)\]\((\/api\/blobs\/[a-f0-9]{64})\)/g;

// IMAGE_URL_RE recognizes a URL whose path ends in a known image extension
// (optionally followed by a ?query or #fragment). Used only on *bare* URLs — an
// explicit [text](url) keeps its text and never becomes an image.
const IMAGE_URL_RE = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)(?:[?#]\S*)?$/i;

function linkAnchor(url, text) {
  return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

function imageEmbed(url) {
  return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="msg-image-link">` +
    `<img class="msg-image" src="${url}" alt="" loading="lazy"></a>`;
}

// inline renders an escaped, non-code, non-emoji run. It SPLITS out links the same
// way inlineWithEmoji splits out emoji: the markdown pass (inlineMarkup) only runs
// on the gaps between links, so it can never mangle a URL. A bare URL pointing at
// an image renders the image inline (unless embedImages is false, e.g. in search
// rows, where it falls back to a plain link). A bare URL matching hideUrl is
// suppressed entirely — its YouTube embed (or message-permalink card) renders it instead.
function inline(escaped, meLower, channels, embedImages, hideUrl, usernames) {
  let out = "";
  let last = 0;
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(escaped)) !== null) {
    out += inlineMarkup(escaped.slice(last, m.index), meLower, channels, usernames);
    if (m[1] !== undefined) {
      // [text](url): keep the author's text (with markup); never an image.
      out += linkAnchor(m[2], inlineMarkup(m[1], meLower, channels, usernames));
    } else {
      const url = m[3];
      if (hideUrl && url === hideUrl) {
        // suppressed: YouTube embed or message-permalink card renders this URL
      } else {
        out += embedImages && IMAGE_URL_RE.test(url) ? imageEmbed(url) : linkAnchor(url, url);
      }
    }
    last = m.index + m[0].length;
  }
  return out + inlineMarkup(escaped.slice(last), meLower, channels, usernames);
}

// atQuery scans backward from `pos` in `text` for an @token that should
// trigger mention autocomplete. Returns { start, partial } if found, or null.
// Excluded: @ immediately after a word char or '/' (avoids emails and URL paths).
export function atQuery(text, pos) {
  let i = pos - 1;
  while (i >= 0 && /[A-Za-z0-9_]/.test(text[i])) i--;
  if (i < 0 || text[i] !== "@") return null;
  if (i > 0 && /[A-Za-z0-9_/]/.test(text[i - 1])) return null;
  return { start: i, partial: text.slice(i + 1, pos) };
}

// colonQuery is the :emoji autocomplete analogue of atQuery: it scans backward
// from `pos` for a `:shortcode` token and returns { start, partial } if found, or
// null. The same boundary guard as mentions keeps it from firing inside words,
// URLs, times, and ratios: the `:` must not be preceded by a word char, `/`, or
// another `:` — so `http://`, `3:30`, `16:9`, and `Foo::Bar` never trigger, while
// a `:` at a boundary (start of line or after whitespace) opens the picker.
// The scan accepts only lowercase chars — uppercase stops it — so typing `:D`,
// `:Fire`, etc. never opens the picker (no shortcode starts with a capital letter).
export function colonQuery(text, pos) {
  let i = pos - 1;
  while (i >= 0 && /[a-z0-9_]/.test(text[i])) i--;
  if (i < 0 || text[i] !== ":") return null;
  if (i > 0 && /[A-Za-z0-9_/:]/.test(text[i - 1])) return null;
  return { start: i, partial: text.slice(i + 1, pos) };
}

// hashQuery is the #channel autocomplete analogue of atQuery: it scans backward
// from `pos` for a `#name` token and returns { start, partial } if found, or null.
// The boundary guard prevents firing on URL fragments (path/#section), CSS color
// codes, and mid-word hashes: # must not be preceded by a word char or '/'.
// The scan accepts only lowercase chars and hyphens — matching the CHANNEL_RE set —
// so uppercase-starting tokens (like markdown # headers typed inline) never trigger.
// If at least one character follows '#', it must be a lowercase letter (channel
// names never start with a digit or hyphen, guarding against #123-style CSS colors).
export function hashQuery(text, pos) {
  let i = pos - 1;
  while (i >= 0 && /[a-z0-9_-]/.test(text[i])) i--;
  if (i < 0 || text[i] !== "#") return null;
  if (i > 0 && /[A-Za-z0-9_/]/.test(text[i - 1])) return null;
  if (i + 1 < pos && !/[a-z]/.test(text[i + 1])) return null;
  return { start: i, partial: text.slice(i + 1, pos) };
}

// permalinkHash builds the canonical location.hash for a message permalink:
// `#c<channelId>/m<messageId>`. This is the single source of truth for the format
// — the message-timestamp anchor hrefs use it (so right-click → copy link yields a
// shareable permalink), and parsePermalink must accept exactly what it emits (a
// past drift of `/m/` vs `/m` broke shared links on fresh load). Note the app does
// NOT keep this hash in the URL bar: after jumping to a message it resets to `/`
// (see jumpToMessage), so the address bar stays clean during normal use. Pure.
export function permalinkHash(channelId, messageId) {
  return `#c${channelId}/m${messageId}`;
}

// parsePermalink is the inverse of permalinkHash: it returns
// { channelId, messageId } for a matching hash, or null otherwise.
export function parsePermalink(hash) {
  const m = String(hash || "").match(/^#c(\d+)\/m(\d+)$/);
  if (!m) return null;
  return { channelId: parseInt(m[1], 10), messageId: parseInt(m[2], 10) };
}

// YOUTUBE_ID_RE extracts the 11-char video ID from youtube.com/watch, youtu.be,
// youtube.com/shorts, and youtube.com/embed URLs.
const YOUTUBE_ID_RE = /^https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

// extractYouTubeVideoID returns the video ID from the first bare YouTube URL in
// text, or null. Markdown-linked URLs are skipped (author chose the text).
export function extractYouTubeVideoID(text) {
  if (!text) return null;
  const re = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)/g;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    if (m[3] !== undefined) {
      const id = YOUTUBE_ID_RE.exec(m[3]);
      if (id) return id[1];
    }
  }
  return null;
}

// extractMessagePermalinkURL returns the first bare same-origin message
// permalink URL in text as { url, channelId, messageId }, or null. origin is
// e.g. "https://chat.example.com". Markdown-linked URLs are skipped (the
// author chose a label; those already render as plain links with their text).
export function extractMessagePermalinkURL(text, origin) {
  if (!text || !origin) return null;
  const re = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)/g;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    if (m[3] === undefined) continue;
    const url = m[3];
    if (!url.startsWith(origin)) continue;
    const rest = url.slice(origin.length); // e.g. "/#c28/m1684"
    const pl = rest.match(/^\/?#c(\d+)\/m(\d+)$/);
    if (pl) return { url, channelId: parseInt(pl[1], 10), messageId: parseInt(pl[2], 10) };
  }
  return null;
}

// extractHideURL returns the first bare URL that would generate a YouTube embed,
// so the caller can suppress its inline text rendering. Pass origin (e.g.
// location.origin) to also suppress message permalink URLs.
export function extractHideURL(text, origin) {
  if (!text) return null;
  if (origin) {
    const pl = extractMessagePermalinkURL(text, origin);
    if (pl) return pl.url;
  }
  const re = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)/g;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    if (m[3] !== undefined && YOUTUBE_ID_RE.test(m[3])) {
      return m[3];
    }
  }
  return null;
}

// EMOJI_RE matches a :shortcode: token. Shortcodes are [+a-z0-9_]{2,32}; the
// leading + covers :+1:. All matched chars are HTML-safe by construction.
const EMOJI_RE = /:([+a-z0-9_]{2,32}):/g;

// BUILTIN_EMOJI maps conventional shortcode names to their Unicode glyphs.
// These render as native Unicode spans (not server-side image URLs), so they
// work without any custom emoji registry and survive an empty instance.
export const BUILTIN_EMOJI = {
  "+1": "👍",
  thumbsdown: "👎",
  symbolic_heart: "❤️",
  joy: "😂",
  wink: "😉",
  heart_eyes: "😍",
  thinking: "🤔",
  tada: "🎉",
  raised_hands: "🙌",
  open_mouth: "😮",
  cry: "😢",
  angry: "😡",
  pray: "🙏",
  fire: "🔥",
  white_check: "✅",
  eyes: "👀",
  "100": "💯",
  wave: "👋",
};

// hasEmoji checks the caller-supplied registry, accepting either a Set of
// shortcodes or a plain object keyed by shortcode (truthy value = known).
function hasEmoji(emojis, name) {
  if (!emojis) return false;
  if (typeof emojis.has === "function") return emojis.has(name);
  return !!emojis[name];
}

function emojiImg(name) {
  return `<img class="emoji" src="/api/emojis/${name}/image" alt=":${name}:" title=":${name}:" loading="lazy">`;
}

function emojiGlyph(glyph, name) {
  return `<span class="emoji-uni" title=":${name}:">${glyph}</span>`;
}

// --- Markdown tables (GFM-style) ------------------------------------------
// A table is a header row, then a delimiter row, then zero+ body rows. Rows are
// pipe-delimited; outer pipes are optional. The delimiter row's colons set
// per-column alignment. All of this runs on the *escaped* string (| : - and \
// all survive escapeHtml untouched), and cell text is rendered through the same
// inlineWithCode pipeline as everything else, so the escape-first XSS invariant
// holds — the only tags we emit are the fixed <table>/<tr>/<th>/<td> we build.

// TABLE_DELIM_RE matches a delimiter row: each cell is optional-colon, 1+ dashes,
// optional-colon (e.g. `---`, `:--`, `--:`, `:--:`), with optional outer pipes.
const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

// isTableRow: a candidate row must contain at least one pipe. (We only ever treat
// it as a table when the *next* line is a delimiter row, so this stays cheap.)
function isTableRow(line) {
  return line.includes("|");
}

// splitRow splits a pipe-delimited row into trimmed cells, honoring \| escapes
// and stripping optional leading/trailing pipes.
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (s[i] === "|") { cells.push(cur); cur = ""; continue; }
    cur += s[i];
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

// cellAlign maps a delimiter cell to a CSS text-align value (or "" for default).
function cellAlign(spec) {
  const s = spec.trim();
  const left = s.startsWith(":");
  const right = s.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "";
}

function renderTable(header, aligns, body, meLower, emojis, channels, embedImages, hideUrl, usernames) {
  const ncols = header.length;
  const fmt = (c) => inlineWithCode(c || "", meLower, emojis, channels, embedImages, hideUrl, usernames);
  // align values are from a fixed {left,right,center,""} set — safe to inline.
  const alignAttr = (i) => (aligns[i] ? ` style="text-align:${aligns[i]}"` : "");
  let out = '<table class="md-table"><thead><tr>';
  for (let i = 0; i < ncols; i++) out += `<th${alignAttr(i)}>${fmt(header[i])}</th>`;
  out += "</tr></thead>";
  if (body.length) {
    out += "<tbody>";
    for (const row of body) {
      out += "<tr>";
      for (let i = 0; i < ncols; i++) out += `<td${alignAttr(i)}>${fmt(row[i])}</td>`;
      out += "</tr>";
    }
    out += "</tbody>";
  }
  return out + "</table>";
}

// formatMessage opts: { embedImages, hideUrl, channels, users } — embedImages:
// when false, bare image URLs render as plain links instead of inline <img>
// (search rows). hideUrl: a URL to suppress when its preview card is shown.
// channels: state.channels map (keyed by id) for #channel links. users: the
// state.users map (keyed by id); when provided, only @mentions whose lowercase
// username appears in it are styled — unknown @tokens are left as plain text.
export function formatMessage(text, me, emojis, opts) {
  if (text == null) return "";
  const embedImages = !opts || opts.embedImages !== false;
  const hideUrl = opts && opts.hideUrl ? escapeHtml(String(opts.hideUrl)) : null;
  const channels = (opts && opts.channels) || null;
  const meLower = me ? String(me).toLowerCase() : null;
  let usernames = null;
  if (opts && opts.users) {
    usernames = new Set();
    for (const u of Object.values(opts.users)) {
      if (u && u.username) usernames.add(String(u.username).toLowerCase());
    }
  }
  return renderBlocks(String(text).split("\n"), meLower, emojis, channels, embedImages, hideUrl, usernames);
}

// FENCE_RE matches a fenced-code delimiter line: ``` optionally followed by a
// language hint (and trailing spaces), nothing else. Detection is per-line so a
// fence works at the start of any line — including inside a blockquote, after its
// quote marker has been stripped.
const FENCE_RE = /^```([a-zA-Z0-9+_-]*)\s*$/;
const FENCE_CLOSE_RE = /^```\s*$/;
// QUOTE_RE matches a blockquote line (optional indent, then `>`). QUOTE_STRIP
// removes exactly one quote level and its single optional following space, so
// nested `> > x` peels one layer per recursion.
const QUOTE_RE = /^\s*>/;
const QUOTE_STRIP = /^\s*>\s?/;

// renderBlocks turns an array of raw (unescaped) lines into block-level HTML. It
// recognizes, per line: fenced code blocks (raw content → highlighter), blockquote
// runs (stripped one level and rendered recursively), GFM tables, # headers, * / -
// unordered lists, and otherwise inline runs. Every non-fence branch escapes its
// text before the inline markdown pass, preserving the escape-first XSS invariant.
function renderBlocks(lines, meLower, emojis, channels, embedImages, hideUrl, usernames) {
  const fmt = (s) => inlineWithCode(escapeHtml(s), meLower, emojis, channels, embedImages, hideUrl, usernames);
  const rendered = [];
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];

    // Fenced code block: ``` (optional language hint) on its own line, running
    // to the next closing ``` line — or to end-of-input if the fence is unclosed.
    const fence = raw.match(FENCE_RE);
    if (fence) {
      const lang = fence[1].toLowerCase();
      const code = [];
      let j = li + 1;
      for (; j < lines.length && !FENCE_CLOSE_RE.test(lines[j]); j++) code.push(lines[j]);
      const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
      rendered.push(`<pre class="code-block"${langAttr}><code>${highlight(code.join("\n"), lang)}</code></pre>`);
      li = j; // skip the closing fence; if unclosed, j === lines.length and we stop
      continue;
    }

    // Blockquote: a run of consecutive `>` lines. Strip one quote level and render
    // the inner lines as their own blocks, so a quoted table / code / list / nested
    // quote survives. This is what makes forwarded messages render correctly.
    if (QUOTE_RE.test(raw)) {
      const inner = [];
      let j = li;
      for (; j < lines.length && QUOTE_RE.test(lines[j]); j++) inner.push(lines[j].replace(QUOTE_STRIP, ""));
      rendered.push(`<blockquote>${renderBlocks(inner, meLower, emojis, channels, embedImages, hideUrl, usernames)}</blockquote>`);
      li = j - 1;
      continue;
    }

    // Table: a pipe-bearing row immediately followed by a delimiter row.
    if (li + 1 < lines.length && isTableRow(raw) && TABLE_DELIM_RE.test(escapeHtml(lines[li + 1]))) {
      const header = splitRow(escapeHtml(raw));
      const aligns = splitRow(escapeHtml(lines[li + 1])).map(cellAlign);
      const body = [];
      let j = li + 2;
      for (; j < lines.length && isTableRow(lines[j]) && !FENCE_RE.test(lines[j]) && !QUOTE_RE.test(lines[j]); j++) {
        body.push(splitRow(escapeHtml(lines[j])));
      }
      rendered.push(renderTable(header, aligns, body, meLower, emojis, channels, embedImages, hideUrl, usernames));
      li = j - 1;
      continue;
    }

    const hm = raw.match(/^(#{1,3})\s+(.*)/);
    if (hm) {
      const tag = ["h3", "h4", "h5"][hm[1].length - 1];
      rendered.push(`<${tag}>${fmt(hm[2])}</${tag}>`);
      continue;
    }

    // Unordered list: consecutive lines starting with "* " or "- ". The required
    // trailing space means "*italic*" (no space after *) is left to inlineMarkup.
    if (/^[*-]\s+/.test(raw)) {
      let j = li;
      const lis = [];
      for (; j < lines.length && /^[*-]\s+/.test(lines[j]); j++) lis.push(`<li>${fmt(lines[j].replace(/^[*-]\s+/, ""))}</li>`);
      rendered.push(`<ul>${lis.join("")}</ul>`);
      li = j - 1;
      continue;
    }

    rendered.push(fmt(raw));
  }

  // Block elements don't need <br> separators — their block formatting provides the newline.
  const isBlock = (s) => /^<(?:blockquote|h[1-6]|table|ul|pre)/.test(s);
  return rendered.reduce((acc, item, idx) => {
    if (idx === 0) return item;
    return acc + (isBlock(rendered[idx - 1]) || isBlock(item) ? "" : "<br>") + item;
  }, "");
}

// inlineWithBlobImages splits an escaped segment on BLOB_IMG_RE, rendering each
// match as an <img> (or plain link when embedImages is false, e.g. search rows).
// Gaps between matches are handed off to inline() for the normal link/markup pass.
function inlineWithBlobImages(seg, meLower, channels, embedImages, hideUrl, usernames) {
  let out = "";
  let last = 0;
  BLOB_IMG_RE.lastIndex = 0;
  let m;
  while ((m = BLOB_IMG_RE.exec(seg)) !== null) {
    out += inline(seg.slice(last, m.index), meLower, channels, embedImages, hideUrl, usernames);
    // m[1] is already HTML-escaped (from the escaped input string).
    // m[2] is /api/blobs/<hex64> — no user-controlled characters.
    if (embedImages) {
      out += imageEmbed(m[2]);
    } else {
      out += linkAnchor(m[2], m[1] || "image");
    }
    last = m.index + m[0].length;
  }
  return out + inline(seg.slice(last), meLower, channels, embedImages, hideUrl, usernames);
}

// SPOILER_RE matches ||text|| pairs. Uses a lazy quantifier so nested or
// sequential spoilers each match their own nearest closing ||. Processes the
// already-HTML-escaped string; | is not an HTML special character so it survives
// escapeHtml unchanged.
const SPOILER_RE = /\|\|([\s\S]*?)\|\|/g;

// Render spoiler spans (||content||). Content is passed through the full inline
// pipeline so images, links, and formatting inside spoilers render correctly.
function inlineWithSpoiler(seg, meLower, emojis, channels, embedImages, hideUrl, usernames) {
  let out = "";
  let last = 0;
  let m;
  SPOILER_RE.lastIndex = 0;
  while ((m = SPOILER_RE.exec(seg)) !== null) {
    out += inlineWithEmoji(seg.slice(last, m.index), meLower, emojis, channels, embedImages, hideUrl, usernames);
    const innerHtml = inlineWithEmoji(m[1], meLower, emojis, channels, embedImages, hideUrl, usernames);
    out += `<span class="spoiler" tabindex="0">${innerHtml}</span>`;
    last = m.index + m[0].length;
  }
  return out + inlineWithEmoji(seg.slice(last), meLower, emojis, channels, embedImages, hideUrl, usernames);
}

// Handle `inline code` spans, leaving their contents free of inline markdown.
// Uses a placeholder strategy so that bold/italic/strike markers that span
// across a code token are matched correctly by inlineWithSpoiler/inlineMarkup.
// Unmatched backticks (odd count) are left as literal backtick characters.
function inlineWithCode(escapedLine, meLower, emojis, channels, embedImages, hideUrl, usernames) {
  const tokens = [];
  // Replace each matched `...` span with a null-byte sentinel so inlineMarkup
  // sees the surrounding text as one continuous string.
  const substituted = escapedLine.replace(/`([^`]*)`/g, (_, inner) => {
    const idx = tokens.length;
    tokens.push(`<code>${inner}</code>`);
    return `\x00${idx}\x00`;
  });
  // Run the full inline pipeline on the substituted string, then restore.
  const rendered = inlineWithSpoiler(substituted, meLower, emojis, channels, embedImages, hideUrl, usernames);
  return rendered.replace(/\x00(\d+)\x00/g, (_, i) => tokens[+i]);
}

// Render known :shortcode: emojis in an escaped, non-code segment. We SPLIT on
// the emoji tokens and apply the markdown rules only to the text between them —
// the same layering used for code spans above — so the inline pass can never run
// over (and mangle) a generated <img> tag, even when a shortcode contains the
// underscores that the italic rule keys on. Unknown shortcodes are left in place
// as literal text for inlineWithBlobImages() to handle. Blob images are processed
// next so that !(…) syntax is consumed before LINK_RE sees it.
// Builtin emoji (BUILTIN_EMOJI) always render as Unicode glyphs; custom emoji
// from the server registry render as <img> tags.
function inlineWithEmoji(seg, meLower, emojis, channels, embedImages, hideUrl, usernames) {
  let out = "";
  let last = 0;
  let m;
  EMOJI_RE.lastIndex = 0;
  while ((m = EMOJI_RE.exec(seg)) !== null) {
    const builtin = BUILTIN_EMOJI[m[1]];
    if (!builtin && !hasEmoji(emojis, m[1])) continue;
    const rendered = builtin ? emojiGlyph(builtin, m[1]) : emojiImg(m[1]);
    out += inlineWithBlobImages(seg.slice(last, m.index), meLower, channels, embedImages, hideUrl, usernames) + rendered;
    last = m.index + m[0].length;
  }
  return out + inlineWithBlobImages(seg.slice(last), meLower, channels, embedImages, hideUrl, usernames);
}

// --- pasted-image decoding ------------------------------------------------

const DATA_URI_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

// dataUriToFile decodes a data: URI into a File, synchronously and without the
// network stack. fetch() on a data: URI is the obvious alternative, but it
// routes a string we already hold through the fetch machinery, where CSP
// connect-src can (and in testing did) kill it with a NetworkError; atob is
// byte-exact and has no CSP jurisdiction. Used by the composer's channel-3
// paste harvest (see wireComposer in app.js).
export function dataUriToFile(src) {
  const comma = src.indexOf(",");
  if (comma < 0) throw new Error("malformed data URI");
  const header = src.slice(5, comma); // strip the leading "data:"
  const payload = src.slice(comma + 1);
  const mime = header.split(";")[0] || "application/octet-stream";
  let bytes;
  if (/;base64$/i.test(header)) {
    const bin = atob(payload);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }
  return new File([bytes], "pasted." + (DATA_URI_EXT[mime] || "bin"), { type: mime });
}
