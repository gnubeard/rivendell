// autocomplete.js — @-mention / :emoji / #channel inline completion, shared by
// the composer and the inline message-edit boxes.
//
// One reusable widget (createAutocomplete) drives a text field + its popup <ul>.
// The candidate filtering — who/what matches the partial after a trigger char,
// minus anyone already @-mentioned — is the gnarly part and is pure + unit-tested
// here (mentionedUsernames / filterMentionCandidates / filterEmojiCandidates /
// filterChannelCandidates / clampIndex). The DOM (popup render, touch/keyboard
// handling, inserting the pick) lives in the widget; its e2e net is the
// "@-mention autocomplete" test in web/e2e/composer-paste.spec.js.

import { atQuery, colonQuery, hashQuery, BUILTIN_EMOJI } from "./format.js";

// mentionedUsernames returns the lowercased usernames already @-mentioned in
// `text`, EXCLUDING a mention whose '@' sits at triggerAt (the one being typed,
// which we're completing). Mirrors the mention regex: '@' must be preceded by
// start-of-string or a non-word char. Pure.
export function mentionedUsernames(text, triggerAt) {
  const out = new Set();
  const re = /(^|[^A-Za-z0-9_/])@([A-Za-z0-9_]{2,32})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const atIdx = m.index + m[1].length;
    if (atIdx !== triggerAt) out.add(m[2].toLowerCase());
  }
  return out;
}

// filterMentionCandidates: active users — excluding me, the already-mentioned,
// and (when activeMemberIds is set) anyone outside the channel audience — whose
// username or display name starts with the partial; alphabetical, capped at 8.
export function filterMentionCandidates(users, partial, { meId, activeMemberIds, alreadyMentioned }) {
  const q = partial.toLowerCase();
  return Object.values(users)
    .filter((u) => u.is_active !== false &&
      u.id !== meId &&
      !alreadyMentioned.has(u.username.toLowerCase()) &&
      (!activeMemberIds || activeMemberIds.has(u.id)) &&
      (u.username.toLowerCase().startsWith(q) ||
        (u.display_name && u.display_name.toLowerCase().startsWith(q))))
    .sort((a, b) => a.username.localeCompare(b.username))
    .slice(0, 8);
}

// filterEmojiCandidates: builtin shortcodes (with their glyph) plus custom ones
// (code only) starting with the partial; alphabetical, capped at 8. `builtins`
// is the { code: glyph } map; `customCodes` is the custom shortcode list.
export function filterEmojiCandidates(partial, builtins, customCodes) {
  const q = partial.toLowerCase();
  const b = Object.entries(builtins)
    .filter(([code]) => code.startsWith(q))
    .map(([code, glyph]) => ({ code, glyph }));
  const c = customCodes
    .filter((code) => code.startsWith(q))
    .map((code) => ({ code }));
  return [...b, ...c].sort((a, b) => a.code.localeCompare(b.code)).slice(0, 8);
}

// filterChannelCandidates: non-DM channels whose name starts with the partial;
// alphabetical, capped at 8.
export function filterChannelCandidates(channels, partial) {
  const q = partial.toLowerCase();
  return Object.values(channels)
    .filter((c) => !c.is_dm && c.name.startsWith(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 8);
}

// clampIndex keeps the highlighted row in range as the candidate list shrinks
// between keystrokes (0 when the list is empty).
export function clampIndex(prevIndex, itemCount) {
  return Math.min(prevIndex, Math.max(0, itemCount - 1));
}

// createAutocomplete wires the widget to a field + popup and the live app state:
//   input              the text field (textarea, or the composer facade div)
//   popup              the popup <ul> element
//   el                 the app's element-builder helper
//   getState           () => state — read live for users/me/emojis/channels
//   getActiveMemberIds () => the active channel's member-id Set, or null
//   emojiURL           (code) => URL for a custom emoji image
// Returns { handleKeydown }: the host's keydown must defer to it first — it
// returns true when an open completion consumed the key (arrows navigate,
// Tab/Enter pick, Esc dismiss), so Enter only sends/saves when none is showing.
export function createAutocomplete({ input, popup, el, getState, getActiveMemberIds, emojiURL }) {
  // `kind` is "mention" | "emoji" | "channel"; null when no completion is active.
  let completion = null; // { kind, query: { start, partial }, items, index }

  // Touch-scroll guard: distinguish a tap (no movement) from a drag-to-scroll.
  // Tracked at the container level so it survives popup re-renders mid-scroll.
  let popupTouchMoved = false;
  let popupTouchOriginY = 0;
  popup.addEventListener("touchstart", (e) => {
    popupTouchMoved = false;
    popupTouchOriginY = e.touches[0].clientY;
  }, { passive: true });
  popup.addEventListener("touchmove", (e) => {
    if (Math.abs(e.touches[0].clientY - popupTouchOriginY) > 8) popupTouchMoved = true;
  }, { passive: true });

  // Detect which trigger (if any) sits just before the caret. @-mentions take
  // precedence over :emoji and #channel — a single caret can't satisfy both.
  function detectCompletion() {
    const s = getState();
    const pos = input.selectionStart;
    const at = atQuery(input.value, pos);
    if (at) {
      const alreadyMentioned = mentionedUsernames(input.value, at.start);
      const items = filterMentionCandidates(s.users, at.partial, {
        meId: s.me?.id, activeMemberIds: getActiveMemberIds(), alreadyMentioned,
      });
      return { kind: "mention", query: at, items };
    }
    const colon = colonQuery(input.value, pos);
    if (colon) return { kind: "emoji", query: colon, items: filterEmojiCandidates(colon.partial, BUILTIN_EMOJI, Object.keys(s.emojis)) };
    const hash = hashQuery(input.value, pos);
    if (hash) return { kind: "channel", query: hash, items: filterChannelCandidates(s.channels, hash.partial) };
    return null;
  }

  function renderPopup() {
    popup.innerHTML = "";
    if (!completion) { popup.hidden = true; return; }
    let activeEl = null; // the highlighted <li>, scrolled into view after layout
    completion.items.forEach((item, i) => {
      const active = i === completion.index ? " active" : "";
      // Mouse: pointerdown prevents textarea blur so the item stays visible for
      // the click. Touch: touchend fires pick only when the finger didn't drag
      // (popupTouchMoved guards scroll intent); preventDefault stops the
      // synthetic click that would otherwise double-pick.
      const itemHandlers = {
        onpointerdown: (e) => { if (e.pointerType !== "mouse") return; e.preventDefault(); pick(item); },
        ontouchend: (e) => { if (!popupTouchMoved) { e.preventDefault(); pick(item); } },
      };
      let li;
      if (completion.kind === "mention") {
        li = el("li", {
          class: "mention-item" + active,
          ...itemHandlers,
        },
          el("span", { class: "mention-item-name" }, "@" + item.username),
          item.display_name && item.display_name !== item.username
            ? el("span", { class: "mention-item-display" }, item.display_name)
            : null,
        );
      } else if (completion.kind === "channel") {
        li = el("li", {
          class: "mention-item" + active,
          ...itemHandlers,
        },
          el("span", { class: "mention-item-name" }, "#" + item.name),
        );
      } else {
        li = el("li", {
          class: "mention-item" + active,
          ...itemHandlers,
        },
          item.glyph
            ? el("span", { class: "emoji-uni" }, item.glyph)
            : el("img", { class: "emoji", src: emojiURL(item.code), alt: `:${item.code}:` }),
          el("span", { class: "mention-item-name" }, `:${item.code}:`),
        );
      }
      popup.append(li);
      if (active) activeEl = li;
    });
    popup.hidden = completion.items.length === 0;
    // Keep the highlighted row visible: when the list overflows its max-height,
    // arrowing past the visible window must scroll it back into view.
    if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
  }

  function updatePopup() {
    const detected = detectCompletion();
    if (!detected) {
      completion = null;
      popup.hidden = true;
      return;
    }
    const prevIndex = completion ? completion.index : 0;
    completion = { ...detected, index: clampIndex(prevIndex, detected.items.length) };
    renderPopup();
  }

  // Insert the chosen completion, replacing from the trigger char to the caret:
  // "@username " for a mention, ":shortcode: " for an emoji, "#name " for a channel.
  // The synthetic input event re-runs the host's autosize (and re-checks for a
  // follow-on trigger — there is none, the caret lands past a trailing space).
  function pick(item) {
    if (!completion) return;
    const text = completion.kind === "mention" ? "@" + item.username + " "
      : completion.kind === "channel" ? "#" + item.name + " "
      : `:${item.code}: `;
    const before = input.value.slice(0, completion.query.start);
    const after = input.value.slice(input.selectionStart);
    input.value = before + text + after;
    const newPos = completion.query.start + text.length;
    input.setSelectionRange(newPos, newPos);
    completion = null;
    popup.hidden = true;
    input.focus();
    input.dispatchEvent(new Event("input"));
  }

  input.addEventListener("input", updatePopup);

  input.addEventListener("blur", () => {
    // Small delay so a pointerdown on a popup item fires before we close it.
    setTimeout(() => { popup.hidden = true; completion = null; }, 200);
  });

  return {
    // Call from the host keydown before its own logic; true == key consumed.
    handleKeydown(e) {
      if (popup.hidden || !completion) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        completion.index = Math.min(completion.index + 1, completion.items.length - 1);
        renderPopup();
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        completion.index = Math.max(completion.index - 1, 0);
        renderPopup();
        return true;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        if (completion.items[completion.index]) pick(completion.items[completion.index]);
        return true;
      }
      if (e.key === "Escape") {
        popup.hidden = true;
        completion = null;
        return true;
      }
      return false;
    },
  };
}
