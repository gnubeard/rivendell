// util.js — small pure helpers with no DOM or app-state dependency. Home for the
// odds and ends that don't belong to a feature module; everything here is
// unit-testable in node:test.

// humanBytes formats a byte count as a short human-readable string (B/KB/MB/GB).
// Sub-KB shows whole bytes; larger units show one decimal unless the value is a
// whole number or ≥10 (where the fraction is noise), and the unit caps at GB.
export function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let val = n / 1024, i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  const rounded = val >= 10 || val === Math.floor(val) ? Math.round(val) : val.toFixed(1);
  return `${rounded} ${units[i]}`;
}

// overSizeLimit reports whether a chosen file is too big to bother uploading.
// A 0/falsy limit (instance fetch failed) means "unknown" and skips the check —
// the server still enforces its own ceiling. The boundary is inclusive: a file
// exactly at the limit is allowed.
export function overSizeLimit(size, limit) {
  if (!limit) return false;
  return size > limit;
}

// formatTime renders an ISO timestamp for display next to a message or in an
// admin table. Same-day timestamps show just the time (HH:MM); older ones are
// prefixed with the locale date. Locale-driven (toLocaleTimeString/DateString),
// so the exact punctuation is the user's environment, not a fixed format.
export function formatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString()} ${time}`;
}
