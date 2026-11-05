/**
 * RTL geometry for the printable finance documents.
 *
 * Arabic reads right-to-left, so logical column 0 belongs at the RIGHT edge and
 * every following column steps leftwards. Laying columns out from the left
 * margin mirrors the table — the first column lands on the left where the last
 * one belongs — which is why the offsets are derived from the right edge here
 * and nowhere else.
 */

/** X of logical column `index`, given its neighbours' widths, in RTL order. */
export function rtlColumnX(widths: number[], index: number, left: number): number {
  let x = left;
  for (const w of widths) x += w;
  for (let k = 0; k <= index; k++) x -= widths[k];
  return x;
}

/** X of slot `index` among `count` equal columns, RTL: slot 0 is rightmost. */
export function rtlSlotX(index: number, count: number, left: number, totalWidth: number): number {
  return left + totalWidth - (index + 1) * (totalWidth / count);
}
