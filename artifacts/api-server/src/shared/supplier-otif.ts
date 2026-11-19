// OTIF (on time in full) percentage for a supplier. `lines` is the due PO lines
// that carry a promised delivery date; `hits` is how many of them were delivered
// in full and on or before the promise. No due lines means no score (null).
export function otifScoreOf(lines: number, hits: number): number | null {
  if (lines <= 0) return null;
  const clamped = Math.min(Math.max(hits, 0), lines);
  return Math.round((clamped / lines) * 100);
}
