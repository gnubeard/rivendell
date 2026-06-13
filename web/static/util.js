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
