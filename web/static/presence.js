// presence.js — pure presence logic: the dot-color mapping and the debounce
// decision. Both are pure (no DOM, no app state) and unit-tested in
// web/test/presence.test.js.
//
// The *effect* of a presence change (writing state, repainting the roster/DM
// header, ending a secret session with a peer who went offline) stays in app.js
// — that's render orchestration. This module only holds the two decisions that
// have logic worth pinning: what color a dot is, and what to do with an incoming
// update.

// presenceClass maps a user to a presence-dot color class. Offline (or invisible)
// users are grey regardless of their stored status; online users get their
// status color (online=green, away=amber, dnd=red). Idle shares away's amber —
// auto-idle and user-set "away" are intentionally indistinguishable.
export function presenceClass(u) {
  if (!u.online) return "offline";
  if (u.idle) return "away";
  if (u.status === "away" || u.status === "dnd") return u.status;
  return "online";
}

// presenceLabel maps a user to the human-readable presence word shown in the
// member roster (the title and the fallback status line). Unlike presenceClass
// (the dot *color*, which folds idle into away's amber), this keeps the states
// distinct: offline wins outright; then dnd reads as "do not disturb", auto-idle
// as "idle"; otherwise the stored status word ("online"/"away").
export function presenceLabel(u) {
  if (!u.online) return "offline";
  if (u.status === "dnd") return "do not disturb";
  if (u.idle) return "idle";
  return u.status;
}

// presenceDecision decides what to do with an incoming presence.update for some
// user — the flicker-suppression rules. The caller supplies the facts; this is
// the pure policy:
//   "now"      — apply immediately, no debounce. Our own user only: deliberate
//                status picks shouldn't lag (and self is never debounced).
//   "drop"     — ignore. An unknown user (a no-op anyway), or a value that already
//                matches what's shown — a flip that reverted within the window.
//   "schedule" — defer by the debounce window (a real change for a known peer).
//
// Net effect: a brief connectivity blip never repaints a dot, killing the flicker;
// a genuine change still lands after the window. Don't collapse "schedule" to an
// immediate apply — the delay IS the flicker fix.
export function presenceDecision({ isSelf, knownUser, alreadyMatches }) {
  if (isSelf) return "now";
  if (!knownUser) return "drop";
  if (alreadyMatches) return "drop";
  return "schedule";
}
