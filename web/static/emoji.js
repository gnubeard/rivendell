// emoji.js — the shared emoji popup controller.
//
// One #emoji-wrap popup serves three jobs through a single rendered grid: drop a
// token into the composer, drop one into an inline message-edit box, or react to
// a message. The controller owns which target is active (`pickerTarget`) and the
// placement: on desktop it floats above the control that opened it, flipping below
// when cramped (getBoundingClientRect, which only a real browser has); on a phone
// (narrow viewport) it pins to a full-width panel at the top of the screen so the
// search field and grid clear the on-screen keyboard (see placeForMobile).
// Behavior is pinned by web/e2e/emoji-picker.spec.js.
//
// The popup is a combobox (#emoji-search) over a listbox (#emoji-picker): the
// search field keeps focus while the arrow keys move an aria-activedescendant
// highlight through the options and Enter picks the active one. The grid is built
// in sections — recently-used (default view only), the quick Unicode palette, and
// the instance's custom emoji — and the search box filters by shortcode across
// them. The "common" palette is NOT a parallel list: it is the renderer's ordered
// BUILTIN_EMOJI_LIST (format.js) so the picker and the renderer can never drift, and
// each glyph carries its conventional `:shortcode:` purely as searchable metadata
// (picks still insert the literal grapheme, which format.js round-trips).
//
// deps:
//   el          — element builder (app.js)
//   $           — querySelector helper (app.js); $(sel) is scoped to document
//   getState    — () => current app state (read at call time; state is reassigned)
//   emojiSrc    — (code) => versioned custom-emoji image URL (cache-busted)
//   isModPlus   — () => whether the current user is moderator+ (gates the ➕ footer)
//   toggleReaction(messageId, value) — apply a reaction pick
//   openEmojiManager() — open the custom-emoji manager modal (from the ➕ footer)
//   loadRecentEmoji() / pushRecentEmoji(value, isCustom) — MRU recents (prefs.js)
import { BUILTIN_EMOJI_LIST } from "./format.js";

// The quick Unicode palette is the renderer's ordered builtin list (single source
// of truth for both content and display order — see format.js), reshaped to the
// {name, glyph} the picker uses. The reverse map gives a recently-used literal
// glyph its shortcode back for the same `:name:` tooltip the quick palette shows.
const COMMON_EMOJI = BUILTIN_EMOJI_LIST.map(([name, glyph]) => ({ name, glyph }));
const GLYPH_TO_NAME = Object.fromEntries(COMMON_EMOJI.map(({ name, glyph }) => [glyph, name]));

// filterEmoji narrows the two named sections by a search query (already
// lowercased+trimmed). The quick palette matches on its shortcode name, custom
// emoji on their shortcode; an empty query passes everything through. Pure — the
// recents section and all DOM live in the controller; this is unit-tested.
export function filterEmoji(query, commonEntries, customCodes) {
  if (!query) return { common: commonEntries.slice(), custom: customCodes.slice() };
  return {
    common: commonEntries.filter((e) => e.name.includes(query)),
    custom: customCodes.filter((code) => code.includes(query)),
  };
}

export function createEmojiPicker({ el, $, getState, emojiSrc, isModPlus, toggleReaction, openEmojiManager, loadRecentEmoji, pushRecentEmoji }) {
  // The shared popup serves two targets: a text field (insert a token) and a
  // message reaction. pickerTarget tracks which, set when the popup is opened.
  let pickerTarget = { mode: "insert" };
  // Keyboard state: `choices` is the flat list of rendered option buttons in
  // visual order (rebuilt every render); `activeIndex` is the aria-activedescendant
  // highlight the arrow keys move and Enter picks. -1 ⇒ nothing active (empty grid).
  let choices = [];
  let activeIndex = -1;
  let wired = false;
  // mobilePanel: the picker is pinned to the top of the screen as a full-width
  // panel (see placeForMobile) — the mobile layout for every target (composer,
  // reaction, inline edit). Tracked so the VisualViewport resize handler refits
  // the grid only in that mode, never for a desktop-floated picker.
  let mobilePanel = false;

  function isOpen() {
    const p = $("#emoji-wrap");
    return p && !p.hidden;
  }

  // ensureWired attaches the search field's input/keydown listeners exactly once.
  // Deferred (rather than done at construction) so it's robust to call order; the
  // field itself is static HTML inside #emoji-wrap.
  function ensureWired() {
    if (wired) return;
    const search = $("#emoji-search");
    if (!search) return;
    search.addEventListener("input", rerender);
    search.addEventListener("keydown", onSearchKey);
    // When the picker is the mobile top panel, refit the grid as the on-screen
    // keyboard opens/closes (it shrinks/grows the visual viewport, not the layout).
    window.visualViewport?.addEventListener("resize", () => {
      if (mobilePanel && isOpen()) sizeMobilePanelGrid();
    });
    wired = true;
  }

  function isMobile() {
    return !!window.matchMedia?.("(max-width: 720px)")?.matches;
  }

  // sizeMobilePanelGrid caps the grid to the space left in the visual viewport
  // (which excludes the on-screen keyboard) below the panel's top + the search
  // field, so the whole panel stays above the keyboard while the grid scrolls.
  function sizeMobilePanelGrid() {
    const vh = window.visualViewport?.height ?? window.innerHeight;
    $("#emoji-picker").style.maxHeight = Math.max(120, Math.round(vh - 120)) + "px";
  }

  // placeForMobile pins the picker to the top of the screen as a full-width fixed
  // panel on a phone (no-op on desktop). The normal placement — floating by the
  // composer or the reaction/edit control — lands behind the on-screen keyboard
  // once the search field is focused, and `interactive-widget=resizes-content`
  // doesn't always lift the anchor clear of it. The top of the screen is always
  // above the keyboard, so anchor there and size the grid to the visible area.
  function placeForMobile() {
    if (!isMobile()) return;
    const wrap = $("#emoji-wrap");
    wrap.style.position = "fixed";
    wrap.style.left = "8px";
    wrap.style.right = "8px";
    wrap.style.top = "8px";
    wrap.style.bottom = "auto";
    wrap.style.width = "auto";
    mobilePanel = true;
    sizeMobilePanelGrid();
  }

  // setActive moves the highlight to index i (clamped), updating aria-selected, the
  // field's aria-activedescendant, and scrolling the option into the listbox view.
  function setActive(i) {
    if (activeIndex >= 0 && choices[activeIndex]) choices[activeIndex].removeAttribute("aria-selected");
    activeIndex = choices.length ? Math.max(0, Math.min(i, choices.length - 1)) : -1;
    const search = $("#emoji-search");
    if (activeIndex < 0) { search?.removeAttribute("aria-activedescendant"); return; }
    const btn = choices[activeIndex];
    btn.setAttribute("aria-selected", "true");
    search?.setAttribute("aria-activedescendant", btn.id);
    btn.scrollIntoView({ block: "nearest" });
  }

  // moveVertical finds the option geometrically above (dir -1) or below (dir +1)
  // the active one and highlights it. A flat index step can't do this: the grid is
  // ragged (the Recent/Custom sections start partial rows, and full-width section
  // headers sit between them), so "the emoji below" is a screen-position lookup,
  // not index±columns. It picks the nearest row in the requested direction, then
  // the option in that row whose horizontal centre is closest to the current one.
  function moveVertical(dir) {
    if (!choices.length) return;
    if (activeIndex < 0) { setActive(0); return; }
    const cur = choices[activeIndex].getBoundingClientRect();
    const curMid = cur.left + cur.width / 2;
    // Nearest row edge strictly in the requested direction (rows share a top).
    let rowTop = null;
    for (const btn of choices) {
      const t = btn.getBoundingClientRect().top;
      if (dir > 0 ? t > cur.top + 1 : t < cur.top - 1) {
        if (rowTop === null || (dir > 0 ? t < rowTop : t > rowTop)) rowTop = t;
      }
    }
    if (rowTop === null) return; // already in the first/last row
    let best = activeIndex, bestDx = Infinity;
    choices.forEach((btn, i) => {
      const r = btn.getBoundingClientRect();
      if (Math.abs(r.top - rowTop) > 1) return;
      const dx = Math.abs(r.left + r.width / 2 - curMid);
      if (dx < bestDx) { bestDx = dx; best = i; }
    });
    setActive(best);
  }

  function onSearchKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); $("#emoji-wrap").hidden = true; return; }
    if (e.key === "Enter") {
      if (activeIndex >= 0) { e.preventDefault(); choices[activeIndex].pick(e); }
      return;
    }
    // Left/Right step in reading order; Up/Down move to the option geometrically
    // above/below (see moveVertical). setActive clamps, so edges are no-ops.
    if (e.key === "ArrowRight") setActive(activeIndex < 0 ? 0 : activeIndex + 1);
    else if (e.key === "ArrowLeft") setActive(activeIndex < 0 ? 0 : activeIndex - 1);
    else if (e.key === "ArrowDown") moveVertical(1);
    else if (e.key === "ArrowUp") moveVertical(-1);
    else return;
    e.preventDefault();
  }

  // makeChoice builds one option button, registers it in `choices`, and wires both
  // a mouse click and a keyboard `pick(evt)` to the same routing. `value` is the
  // reaction/insert value (custom shortcode or literal glyph); `title` is the
  // hover/search label; `child` is the rendered img or glyph span.
  function makeChoice(value, isCustom, title, child) {
    const idx = choices.length;
    const pick = (evt) => chooseEmoji(value, isCustom, evt);
    const btn = el("button", {
      type: "button", class: "emoji-choice", role: "option", id: `emoji-opt-${idx}`,
      title, onclick: pick,
    }, child);
    btn.pick = pick;
    choices.push(btn);
    return btn;
  }

  function commonChoice({ name, glyph }) {
    return makeChoice(glyph, false, `:${name}:`, el("span", { class: "emoji-uni" }, glyph));
  }
  function customChoice(code) {
    return makeChoice(code, true, `:${code}:`, el("img", { class: "emoji", src: emojiSrc(code), alt: `:${code}:` }));
  }

  // section appends a labeled group of option buttons to the grid (a full-width
  // dim header + the buttons), skipping entirely when the group is empty.
  function section(picker, label, buttons) {
    if (!buttons.length) return;
    picker.append(el("div", { class: "emoji-section" }, label));
    for (const b of buttons) picker.append(b);
  }

  function rerender() {
    const picker = $("#emoji-picker");
    const wrap = $("#emoji-wrap");
    picker.innerHTML = "";
    choices = [];
    // Remove any manage button appended to the wrap by a previous render.
    wrap.querySelector(".emoji-manage-btn")?.remove();

    const query = ($("#emoji-search")?.value || "").trim().toLowerCase();
    const emojis = getState().emojis;
    const customCodes = Object.keys(emojis).sort();
    const { common, custom } = filterEmoji(query, COMMON_EMOJI, customCodes);

    // Recently-used shows only in the default (no-query) view, most-recent-first.
    // A recent custom entry whose emoji was since deleted is dropped (its image
    // would 404); a recent literal glyph is rendered like a common one.
    if (!query) {
      const recent = loadRecentEmoji()
        .map((e) => (e.c ? (emojis[e.v] ? customChoice(e.v) : null) : commonChoice({ name: GLYPH_TO_NAME[e.v] || e.v, glyph: e.v })))
        .filter(Boolean);
      section(picker, "Recent", recent);
    }
    section(picker, query ? "Results" : "Emoji", common.map(commonChoice));
    section(picker, "Custom", custom.map(customChoice));

    if (!choices.length) picker.append(el("div", { class: "emoji-empty" }, "No emoji found"));
    setActive(0);

    // Moderators+ get a ➕ footer strip below the grid that opens the custom-emoji manager.
    if (isModPlus()) {
      wrap.append(el("button", {
        type: "button", class: "emoji-manage-btn", title: "Manage custom emojis",
        onclick: (e) => { e.stopPropagation(); $("#emoji-wrap").hidden = true; openEmojiManager(); },
      }, "➕ Manage emojis"));
    }
  }

  // chooseEmoji routes a picked emoji to the popup's current target and records it
  // as recently-used. isCustom marks a custom shortcode (vs a literal Unicode glyph)
  // — only the former is :colon:-wrapped when inserted into a message; as a reaction
  // value the bare shortcode/glyph is stored. Shift-clicking keeps the picker open so
  // multiple emoji can be reacted with (insertions close anyway — insertIntoInput
  // hides the popup).
  function chooseEmoji(value, isCustom, evt) {
    pushRecentEmoji(value, isCustom);
    if (!evt?.shiftKey) $("#emoji-wrap").hidden = true;
    if (pickerTarget.mode === "react") {
      toggleReaction(pickerTarget.messageId, value);
      return;
    }
    // mode "insert": the composer (no explicit input) or an inline edit box.
    insertIntoInput(pickerTarget.input || $("#composer-input"), isCustom ? `:${value}:` : value);
  }

  // prepareOpen resets the search field to its empty default and (on a pointer-fine
  // device only) focuses it so typing filters immediately — autofocus is skipped on
  // touch so opening the picker doesn't pop the on-screen keyboard over the grid.
  function prepareOpen() {
    ensureWired();
    const search = $("#emoji-search");
    if (search) search.value = "";
    // Clear any mobile-panel overrides (grid cap + auto width) so the floated/
    // desktop picker uses its CSS sizing; placeForMobile re-applies them when it
    // pins the panel.
    mobilePanel = false;
    $("#emoji-picker").style.maxHeight = "";
    $("#emoji-wrap").style.width = "";
    rerender();
    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches;
    if (!coarse) search?.focus();
  }

  // floatPickerAt fixes the shared #emoji-picker as a popup above (flipping below
  // if cramped) the control that opened it — used by the reaction button and the
  // inline-edit 😀 button, which live outside the composer's CSS anchor. The picker
  // must be rendered (sized) before this is called so getBoundingClientRect reads
  // real dimensions.
  function floatPickerAt(picker, anchorEl) {
    const a = anchorEl.getBoundingClientRect();
    const pr = picker.getBoundingClientRect();
    let left = Math.max(8, Math.min(a.left, window.innerWidth - pr.width - 8));
    let top = a.top - pr.height - 6;
    if (top < 8) top = a.bottom + 6;
    picker.style.left = left + "px";
    picker.style.top = top + "px";
  }

  // floatPicker readies the shared picker as an off-screen fixed popup, renders it,
  // then places it next to anchorEl. Shared setup for the reaction + edit pickers.
  // On a phone the anchor (a message's reaction button) sits behind the on-screen
  // keyboard just like the composer does, so pin to the top panel instead of
  // floating next to it — same treatment as the composer picker.
  function floatPicker(anchorEl) {
    const wrap = $("#emoji-wrap");
    // Render off-screen first so we can measure it, then place it relative to the
    // control (flipping below if there's no room above).
    wrap.style.position = "fixed";
    wrap.style.left = "-9999px";
    wrap.style.top = "0";
    wrap.style.right = "auto";
    wrap.style.bottom = "auto";
    wrap.hidden = false;
    prepareOpen();
    if (isMobile()) placeForMobile();
    else floatPickerAt(wrap, anchorEl);
  }

  // openForReaction opens the shared popup in reaction mode, floated next to the
  // message control that was clicked (it otherwise lives anchored by the composer).
  function openForReaction(messageId, anchorEl) {
    pickerTarget = { mode: "react", messageId };
    floatPicker(anchorEl);
  }

  // openForInput floats the shared picker next to an inline edit box's 😀 button
  // and routes picks into that textarea. Clicking the button again while it is
  // already open for the same box toggles it closed.
  function openForInput(input, anchorEl) {
    const wrap = $("#emoji-wrap");
    if (!wrap.hidden && pickerTarget.input === input) {
      wrap.hidden = true;
      return;
    }
    pickerTarget = { mode: "insert", input };
    floatPicker(anchorEl);
  }

  // toggle opens/closes the popup anchored above the composer (the composer 😀
  // button). Targets the composer (no explicit input).
  function toggle() {
    const wrap = $("#emoji-wrap");
    if (wrap.hidden) {
      pickerTarget = { mode: "insert" }; // no .input ⇒ targets the composer
      // Clear any fixed-position overrides left by a reaction pick so the popup
      // returns to its CSS anchor above the composer.
      wrap.style.position = wrap.style.left = wrap.style.top = wrap.style.right = wrap.style.bottom = "";
      wrap.hidden = false;
      prepareOpen();
      // On a phone the composer anchor sits behind the keyboard; pin to the top
      // of the screen instead so the field and its results clear it.
      placeForMobile();
    } else {
      wrap.hidden = true;
    }
  }

  // insertIntoInput drops a token at the caret of a textarea-like field (inline
  // edit box or the composer div), padded with spaces so it reads as a standalone
  // token, then fires a synthetic input event so the target's autosize/typing
  // logic runs as if it were typed.
  function insertIntoInput(input, token) {
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const before = input.value.slice(0, start);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const insert = `${lead}${token} `;
    input.value = before + insert + input.value.slice(end);
    const pos = start + insert.length;
    input.setSelectionRange(pos, pos);
    $("#emoji-wrap").hidden = true;
    input.focus();
    input.dispatchEvent(new Event("input"));
  }

  return { isOpen, rerender, toggle, openForReaction, openForInput };
}
