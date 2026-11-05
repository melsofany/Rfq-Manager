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

/** The slice of pdfkit `flowRows` needs, so the geometry is testable on its own. */
export interface Measurer {
  heightOfString(text: string, options?: { width?: number }): number;
}

/** One label/value row of a flowing block. Both strings arrive pre-`rtl()`ed. */
export interface FlowRow {
  value: string;
  label: string;
}

/**
 * `y` of every row in a label/value block that flows downwards, plus the `y`
 * just past the last one.
 *
 * A fixed per-row step is only correct while every value fits on ONE line. A
 * bank account holder's registered name is long enough to wrap, and with a
 * constant step its second line is drawn straight over the row beneath — so
 * every row is MEASURED and the next one starts below it.
 */
export function flowRows(
  doc: Measurer,
  rows: FlowRow[],
  options: { top: number; valueWidth: number; labelWidth: number },
): { ys: number[]; nextY: number } {
  const ys: number[] = [];
  let y = options.top;
  for (const row of rows) {
    ys.push(y);
    y += Math.max(
      doc.heightOfString(row.value, { width: options.valueWidth }),
      doc.heightOfString(row.label, { width: options.labelWidth }),
    );
  }
  return { ys, nextY: y };
}
