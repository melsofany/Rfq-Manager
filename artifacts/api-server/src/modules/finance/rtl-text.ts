/**
 * Arabic word order for the printable finance documents.
 *
 * pdfkit lays a string out strictly left-to-right and shapes each space-separated
 * word on its own (fontkit reverses the characters INSIDE a word, so a single
 * word is already correct). It never reorders words, so a multi-word Arabic
 * phrase comes out with its words in reverse reading order.
 *
 * The rule is therefore: compose the FULL string first, then reverse its words
 * EXACTLY ONCE. Applying it twice restores the logical order — which is how
 * «إجمالي المستحق» once reached the supplier as «المستحق: إجمالي» — and not
 * applying it at all leaves «البنك التجاري الدولي» reading «الدولي التجاري البنك».
 */

const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** Reverse the word order of `text` for RTL display; Latin-only text is untouched. */
export function rtl(text: string | null | undefined): string {
  if (!text) return text ?? "";
  const trimmed = String(text).trim();
  if (!ARABIC_RE.test(trimmed)) return trimmed;
  const words = trimmed.split(/\s+/);
  if (words.length <= 1) return trimmed;
  return words.reverse().join(" ");
}

/**
 * Compose a label with its value and lay the RESULT out RTL.
 *
 * Call this instead of `rtl(label) + " " + value`: reversing only the label
 * leaves the value pinned to the wrong side of it, and reversing the assembled
 * string a second time cancels the first reversal out.
 */
export function rtlLabelValue(label: string, value: string | number | null | undefined): string {
  return rtl(`${label} ${value ?? ""}`.trim());
}
