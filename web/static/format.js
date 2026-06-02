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

// Apply inline rules to a single already-escaped line (no code spans here).
function inline(escaped) {
  let out = escaped;
  // Bold then italic (order matters so ** isn't eaten by *).
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // Autolink http/https URLs. URLs in escaped text can contain &amp; etc.
  out = out.replace(
    /\bhttps?:\/\/[^\s<]+/g,
    (m) => `<a href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`
  );
  return out;
}

export function formatMessage(text) {
  if (text == null) return "";
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
          return `<blockquote>${inlineWithCode(body)}</blockquote>`;
        }
        return inlineWithCode(line);
      });
      html += rendered.join("<br>");
    }
  }
  return html;
}

// Handle `inline code` spans, leaving their contents free of inline markdown.
function inlineWithCode(escapedLine) {
  const segs = escapedLine.split(/`/);
  let out = "";
  for (let i = 0; i < segs.length; i++) {
    if (i % 2 === 1) {
      out += `<code>${segs[i]}</code>`;
    } else {
      out += inline(segs[i]);
    }
  }
  return out;
}
