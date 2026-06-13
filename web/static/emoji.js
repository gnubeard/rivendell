// emoji.js — the shared emoji popup controller.
//
// One #emoji-wrap popup serves three jobs through a single rendered grid: drop a
// token into the composer, drop one into an inline message-edit box, or react to
// a message. The controller owns which target is active (`pickerTarget`) and the
// floating-popup placement math (it floats above the control that opened it,
// flipping below when cramped — getBoundingClientRect, which only a real browser
// has). Behavior is pinned by web/e2e/emoji-picker.spec.js.
//
// deps:
//   el          — element builder (app.js)
//   $           — querySelector helper (app.js); $(sel) is scoped to document
//   getState    — () => current app state (read at call time; state is reassigned)
//   isModPlus   — () => whether the current user is moderator+ (gates the ➕ footer)
//   toggleReaction(messageId, value) — apply a reaction pick
//   openEmojiManager() — open the custom-emoji manager modal (from the ➕ footer)
import { api } from "./api.js?v=__RIVENDELL_VERSION__";

// A small set of common Unicode emoji offered alongside the instance's custom
// emoji, so reactions aren't custom-only. These are literal graphemes (no image).
const COMMON_EMOJI = ["👍", "👎", "❤️", "😂", "😉", "😍", "🤔", "🎉", "🙌", "😮", "😢", "😡", "🙏", "🔥", "✅", "👀", "💯", "👋"];

export function createEmojiPicker({ el, $, getState, isModPlus, toggleReaction, openEmojiManager }) {
  // The shared popup serves two targets: a text field (insert a token) and a
  // message reaction. pickerTarget tracks which, set when the popup is opened.
  let pickerTarget = { mode: "insert" };

  function isOpen() {
    const p = $("#emoji-wrap");
    return p && !p.hidden;
  }

  function rerender() {
    const picker = $("#emoji-picker");
    const wrap = $("#emoji-wrap");
    picker.innerHTML = "";
    // Remove any manage button appended to the wrap by a previous render.
    wrap.querySelector(".emoji-manage-btn")?.remove();
    // Quick Unicode palette first — usable as a reaction or dropped into a message.
    for (const ch of COMMON_EMOJI) {
      picker.append(el("button", {
        type: "button", class: "emoji-choice", title: ch,
        onclick: (e) => chooseEmoji(ch, false, e),
      }, el("span", { class: "emoji-uni" }, ch)));
    }
    const codes = Object.keys(getState().emojis).sort();
    if (codes.length) {
      picker.append(el("div", { class: "emoji-sep" }));
      for (const code of codes) {
        picker.append(el("button", {
          type: "button", class: "emoji-choice", title: `:${code}:`,
          onclick: (e) => chooseEmoji(code, true, e),
        }, el("img", { class: "emoji", src: api.emojiURL(code), alt: `:${code}:` })));
      }
    }
    // Moderators+ get a ➕ footer strip below the grid that opens the custom-emoji manager.
    if (isModPlus()) {
      wrap.append(el("button", {
        type: "button", class: "emoji-manage-btn", title: "Manage custom emojis",
        onclick: (e) => { e.stopPropagation(); $("#emoji-wrap").hidden = true; openEmojiManager(); },
      }, "➕ Manage emojis"));
    }
  }

  // chooseEmoji routes a picked emoji to the popup's current target. isCustom marks a
  // custom shortcode (vs a literal Unicode glyph) — only the former is :colon:-wrapped
  // when inserted into a message; as a reaction value the bare shortcode is stored.
  // Shift-clicking keeps the picker open so multiple emoji can be reacted with
  // (insertions close anyway — insertIntoInput hides the popup).
  function chooseEmoji(value, isCustom, evt) {
    if (!evt?.shiftKey) $("#emoji-wrap").hidden = true;
    if (pickerTarget.mode === "react") {
      toggleReaction(pickerTarget.messageId, value);
      return;
    }
    // mode "insert": the composer (no explicit input) or an inline edit box.
    insertIntoInput(pickerTarget.input || $("#composer-input"), isCustom ? `:${value}:` : value);
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
    rerender();
    floatPickerAt(wrap, anchorEl);
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
      rerender();
      wrap.hidden = false;
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
