// format.js — turn a plain-text message into safe HTML.
//
// Security model: the input is UNTRUSTED. We escape all HTML first, then apply a
// small, fixed set of inline markdown rules to the *escaped* string. Because the
// raw text can no longer contain real tags after escaping, the markdown pass can
// only ever introduce the specific tags we add ourselves.
//
// Supported: ```fenced code```, `inline code`, **bold**, *italic*, _italic_,
// ~~strike~~, > blockquote, autolinked http(s) URLs, and newlines.
//
// This module is pure (no DOM, no globals) so it can be unit-tested under Node.

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

// Apply inline rules to a single already-escaped line (no code spans here).
function inline(escaped, meLower) {
  let out = escaped;
  // Bold then italic (order matters so ** isn't eaten by *).
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // Mentions: style @username; flag the current user's own. MUST run before
  // autolinking so the span (which contains a quoted class attr) is never
  // injected inside an href="...". The captured name is [A-Za-z0-9_], so it
  // can't carry HTML metacharacters.
  out = out.replace(MENTION_RE, (full, pre, name) => {
    const cls = meLower && name.toLowerCase() === meLower ? "mention mention-me" : "mention";
    return `${pre}<span class="${cls}">@${name}</span>`;
  });
  // Autolink http/https URLs. URLs in escaped text can contain &amp; etc.
  out = out.replace(
    /\bhttps?:\/\/[^\s<]+/g,
    (m) => `<a href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`
  );
  return out;
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
export function colonQuery(text, pos) {
  let i = pos - 1;
  while (i >= 0 && /[A-Za-z0-9_]/.test(text[i])) i--;
  if (i < 0 || text[i] !== ":") return null;
  if (i > 0 && /[A-Za-z0-9_/:]/.test(text[i - 1])) return null;
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

// EMOJI_RE matches a :shortcode: token. Shortcodes are [a-z0-9_]{2,32} (same
// charset as usernames), so a matched name can never carry an HTML metacharacter
// — the <img> we build from it is safe by construction.
const EMOJI_RE = /:([a-z0-9_]{2,32}):/g;

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

export function formatMessage(text, me, emojis) {
  if (text == null) return "";
  const meLower = me ? String(me).toLowerCase() : null;
  const escaped = escapeHtml(String(text));

  // Split on fenced code blocks first so their contents are left verbatim.
  // The fence is ``` on its own logical run; we accept ```lang\n...\n```.
  const parts = escaped.split(/```/);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // Inside a fence: drop an optional leading language token + newline.
      let code = parts[i].replace(/^[a-zA-Z0-9_-]*\n/, "");
      code = code.replace(/^\n/, "").replace(/\n$/, "");
      html += `<pre class="code-block"><code>${code}</code></pre>`;
    } else {
      // Outside a fence: handle inline code, blockquotes, line breaks.
      const lines = parts[i].split("\n");
      const rendered = lines.map((line) => {
        if (/^&gt;\s?/.test(line)) {
          const body = line.replace(/^&gt;\s?/, "");
          return `<blockquote>${inlineWithCode(body, meLower, emojis)}</blockquote>`;
        }
        return inlineWithCode(line, meLower, emojis);
      });
      html += rendered.join("<br>");
    }
  }
  return html;
}

// Handle `inline code` spans, leaving their contents free of inline markdown.
function inlineWithCode(escapedLine, meLower, emojis) {
  const segs = escapedLine.split(/`/);
  let out = "";
  for (let i = 0; i < segs.length; i++) {
    if (i % 2 === 1) {
      out += `<code>${segs[i]}</code>`;
    } else {
      out += inlineWithEmoji(segs[i], meLower, emojis);
    }
  }
  return out;
}

// Render known :shortcode: emojis in an escaped, non-code segment. We SPLIT on
// the emoji tokens and apply the markdown rules only to the text between them —
// the same layering used for code spans above — so the inline pass can never run
// over (and mangle) a generated <img> tag, even when a shortcode contains the
// underscores that the italic rule keys on. Unknown shortcodes are left in place
// as literal text for inline() to render.
function inlineWithEmoji(seg, meLower, emojis) {
  if (!emojis) return inline(seg, meLower);
  let out = "";
  let last = 0;
  let m;
  EMOJI_RE.lastIndex = 0;
  while ((m = EMOJI_RE.exec(seg)) !== null) {
    if (!hasEmoji(emojis, m[1])) continue;
    out += inline(seg.slice(last, m.index), meLower) + emojiImg(m[1]);
    last = m.index + m[0].length;
  }
  return out + inline(seg.slice(last), meLower);
}
