// composer-field.js — the textarea-on-a-div facade for the message composer.
//
// The composer is a `contenteditable="plaintext-only"` div, not a <textarea>:
// that swap exists because GeckoView/Firefox-Android never delivers image
// clipboard content to a real <textarea> (see docs/composer-paste-qa.md and the
// project-composer-image-input memory). upgradeComposerField grafts the
// textarea API every caller already expects onto that div, so the rest of the
// app reads/writes the composer without knowing it's a div:
//
//   .value                 get/set the plain text (<br> ⟷ "\n")
//   .selectionStart/End    caret/selection as text offsets
//   .setSelectionRange()   move the caret/selection by text offset
//   .disabled              lock/unlock (the ended-secret-session lockout)
//   .placeholder           the data-ph attribute the :empty::before CSS reads
//
// This is a SEAM: pure DOM, no app state, no network. It is covered by
// web/e2e/composer-paste.spec.js ("facade" group) against a real browser — the
// offset math rides on real Range/TreeWalker/Selection, which only a real engine
// reproduces faithfully, so its test net is e2e, not node:test. Do NOT regress
// to a <textarea>; do NOT reimplement the offset math against a fake DOM.

export function upgradeComposerField(el) {
  // Feature-detect: engines that predate contenteditable="plaintext-only"
  // treat the unknown value as invalid and leave the element non-editable —
  // a bricked composer. Fall back to full contenteditable there; the input
  // handler's normalize pass keeps the content effectively plain.
  if (el.contentEditable !== "plaintext-only") el.contentEditable = "true";
  // Remembered so the `disabled` setter can restore the right mode (the
  // feature-detect above may have downgraded plaintext-only → true).
  const editableMode = el.contentEditable;

  // The single definition of "the text": flat walk, <br> → "\n". (innerText
  // is rendering-dependent and can't be reconciled with selection offsets;
  // textContent drops <br> newlines entirely.)
  const textOf = (root) => {
    let out = "";
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === Node.TEXT_NODE) out += c.data;
        else if (c.nodeName === "BR") out += "\n";
        else walk(c); // fallback-mode rich nodes contribute their text
      }
    })(root);
    return out;
  };

  // offsetOf: text offset of a DOM position, measured by cloning the range
  // from the field start so <br>s in between count as one character each.
  const offsetOf = (node, nodeOffset) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    try { r.setEnd(node, nodeOffset); } catch { return textOf(el).length; }
    return textOf(r.cloneContents()).length;
  };

  // pointAt: inverse of offsetOf — the (node, offset) DOM position for a text
  // offset, clamped to the end of the field.
  const pointAt = (target) => {
    let rem = target;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) {
        if (rem <= n.data.length) return { node: n, offset: rem };
        rem -= n.data.length;
      } else if (n.nodeName === "BR") {
        if (rem <= 0) return { node: n.parentNode, offset: [...n.parentNode.childNodes].indexOf(n) };
        rem -= 1;
      }
    }
    return { node: el, offset: el.childNodes.length };
  };

  const selOffset = (which) => {
    const s = el.ownerDocument.getSelection();
    if (!s || !s.rangeCount) return textOf(el).length; // unfocused → "end", like an untouched textarea caret
    const r = s.getRangeAt(0);
    const node = which === "start" ? r.startContainer : r.endContainer;
    if (!el.contains(node)) return textOf(el).length;
    return offsetOf(node, which === "start" ? r.startOffset : r.endOffset);
  };

  el.setSelectionRange = (start, end) => {
    const s = el.ownerDocument.getSelection();
    if (!s) return;
    const a = pointAt(start);
    const b = end === start ? a : pointAt(end);
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    s.removeAllRanges();
    s.addRange(r);
  };

  Object.defineProperties(el, {
    value: {
      get() { return textOf(el); },
      set(v) {
        el.textContent = v; // white-space: pre-wrap renders the \n's
        // A textarea's .value setter leaves the caret after the text; mirror
        // that when the field is focused so callers that set-then-type work.
        if (document.activeElement === el) el.setSelectionRange(v.length, v.length);
      },
    },
    selectionStart: { get() { return selOffset("start"); } },
    selectionEnd: { get() { return selOffset("end"); } },
    // Textarea-vocabulary disable/placeholder, so call sites (the secret-
    // session ended lockout) need not know this is a div. `disabled` maps to
    // contentEditable=false + aria-disabled + a .disabled class for styling;
    // `placeholder` maps to the data-ph attribute the :empty::before CSS
    // placeholder reads from.
    disabled: {
      get() { return el.contentEditable === "false"; },
      set(v) {
        el.contentEditable = v ? "false" : editableMode;
        el.setAttribute("aria-disabled", v ? "true" : "false");
        el.classList.toggle("disabled", !!v);
      },
    },
    placeholder: {
      get() { return el.dataset.ph || ""; },
      set(v) { el.dataset.ph = v; },
    },
  });
}
