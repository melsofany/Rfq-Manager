/**
 * AI Assistant ЕҢДҶГ¶ line items read out of email attachments.
 *
 * The document numbers live in the subject, but the ITEMS live inside the
 * attached RFQ/PO PDF (EDC sends a в”¬ВҪREQUEST FOR QUOTEв”¬в•— or в”¬ВҪPURCHASE ORDERв”¬в•— with
 * a line table). Reading them through the model is not viable for a year's mail:
 * Gemini's free tier is 20 requests/day/model, so extraction runs locally on the
 * PDF text layer.
 *
 * The parser understands the two EDC layouts explicitly, and every caller gets a
 * coverage record ЕҢДҶГ¶ an empty result must never be indistinguishable from an
 * unreadable file, which is how "this order has no items" would be reported for
 * a document nobody managed to open.
 */
import { extractPdfTextDetailed, type MessageAttachments } from "./email";
import { groupByItemIdentity, hasConfidentIdentity } from "./item-identity";

/** One parsed order line. */
export interface ParsedLineItem {
  /** The printed `Line No.` ЕҢДҶГ¶ a row number, NOT an identity. */
  lineNo: number | null;
  /**
   * The REAL Part Number (the `Part No` column, or a `P/N : ЕҢДҶвҖқ` written in the
   * description). Frequently absent ЕҢДҶГ¶ the operator's rule is that it is never
   * required and never sufficient on its own.
   */
  partNo: string | null;
  /**
   * The ERP's `Line Item` code (`1531.032.GENRAL.7538`, `0600.000.GENRAL.0005`).
   *
   * This is what the operator means by в”¬ВҪLine Itemв”¬в•—, and what the previous
   * implementation mislabelled as the Part Number: the PO prints it in the
   * `Line Item` column, on the line BELOW the row. Because it is category-coded
   * and stable per product it is the strongest identity key available, but it is
   * still not merged blindly ЕҢДҶГ¶ the EDC generator re-codes items across seasons.
   */
  lineItemNo?: string | null;
  description: string;
  qty: number | null;
  uom: string | null;
  /** Unit price printed on the row (PO layout), when present. */
  unitPrice?: number | null;
  /** Line total printed on the row (PO layout), when present. */
  lineTotal?: number | null;
  /**
   * Identity of the DOCUMENT this line came from. Occurrence counting keys on
   * this, not on the array index: a part printed on three lines of one PO (or
   * restated on its distribution page) is ONE order, not three.
   */
  docId?: string | null;
}

/**
 * The ERP's В«Line ItemВ» code as printed on EDC documents: four digits, a
 * three-digit group, a category word, then a running number
 * (5720.001.GENRAL.0024). The category varies in length (0600.000.GENRAL.0005),
 * so the segment count is not fixed.
 *
 * IMPORTANT: this is the LINE ITEM, not the Part Number. The PO prints it in its
 * own `Line Item` column (on the line below the row); the real `Part No` column
 * carries a short code (`UXL7-12`) or is empty. The previous implementation
 * labelled this code as the Part Number and reported the row number as the В«Line
 * ItemВ», which is exactly the mix-up the operator reported.
 */
const LINE_ITEM_RE = /\b\d{4}\.\d{3}\.[A-Z0-9]{2,}(?:\.[A-Z0-9]+)+\b/;

/**
 * How many continuation lines beyond the row a description may span.
 *
 * The EDC description wraps across several visual lines and a multi-page PDF can
 * break a row's prose across a page boundary. The previous 7 was not enough for
 * the longest real descriptions, which is why «التوصيف الكامل» came back cut.
 */
const MAX_DESCRIPTION_LINES = 20;

/**
 * The real `Part No` column value: a short alphanumeric code (`UXL7-12`,
 * `DCL163`, `A9R41440`). Deliberately strict вҖ” it must contain BOTH letters and
 * digits and must NOT be a Line Item code вҖ” so a category word or a stray number
 * is never mistaken for a part number.
 */
const PART_NO_TOKEN_RE = /^[A-Z0-9][A-Z0-9./-]{2,24}$/i;

/**
 * Units of measure seen on these documents. Restricted to a known set so a
 * quantity is never fabricated from an arbitrary following word.
 */
const UOM_RE =
  /\b(Each|Piece|Pieces|Pcs|Nos|No|Unit|Units|Set|Sets|Box|Boxes|Roll|Rolls|Meter|Metre|Mtr|Kg|KG|Ton|Litre|Liter|Ltr|Bag|Drum|Pair)\b/i;

/** Lines that END the item table (totals and the restatement pages). */
const TABLE_END_RE =
  /^(Total\b|Grand Total|VALUE ADDED TAX|Phrases:|Purchase Order Distribution|Supplier Quote Ref)/i;

/**
 * Lines that carry no item but do not end the table (page furniture inside it).
 */
const TABLE_NOISE_RE = /^(Page\s+\d|Note:?$|Line\s*$|No\.$)/i;

/** Does this line begin a new item row (`1 24 Each ЕҢДҶвҖқ`)? */
const ITEM_ROW_RE = /^(\d{1,3})\s+(\d+(?:\.\d+)?)\s+([A-Za-z]{1,12})\b(.*)$/;

/**
 * The PO row's money tail: the delivery date followed by the unit price and the
 * line total, as printed under `Delivery Date Unit Price Total (EGP)`
 * (`05-OCT-2026 75.00 900.00`). Anchored on the date so a description that
 * merely ends in two numbers is not read as prices.
 */
const PO_PRICE_RE = /\b\d{2}-[A-Za-z]{3}-\d{4}\b\s+(\d[\d,]*(?:\.\d+)?)\s+(\d[\d,]*(?:\.\d+)?)/;

/**
 * The document's own number, printed on the PO (`PO number: P26E14630(RIG58)`)
 * and on the RFQ (`RFQ number: 26R011954`). This is the identity an item is
 * counted against ЕҢДҶГ¶ the operator asks how many ORDERS carried a part, and one
 * PO that lists a part on three lines is still one order.
 */
const DOC_NUMBER_RE = /\b(?:PO|RFQ)\s*(?:number|no\.?)\s*:?\s*([A-Z0-9][A-Z0-9-]{4,})/i;

/**
 * The table's column header ЕҢДҶГ¶ where the item region starts. The RFQ prints it as
 * `Line Quantity UOM Part No ЕҢДҶвҖқ`; the PO splits it, with `Line` / `No.` on their
 * own lines before `Quantity UOM Part No ЕҢДҶвҖқ`, so matching the `Quantity UOM` pair
 * covers both.
 */
const TABLE_HEADER_RE = /^(?:Line\s+)?Quantity\s+UOM\b/i;

/**
 * A part number written in the description (`P/N : 5702428662864`) rather than
 * in the Part No column. EDC's RFQ generator wraps/overflows the Part No cell
 * (observed: `5.70243E+` then `1854.027.` on the next visual line), so the
 * description's P/N is the reliable identifier for those rows.
 *
 * A digit-only value is deliberately rejected: `P/N : 2102024` on a HEATER row
 * is the manufacturer's catalogue number, and carrying it as the item's Part
 * Number would put an unrelated number in the report. A code is taken only when
 * it carries a letter, or when it is long enough to be a real long part number.
 */
const PN_INLINE_RE = /\bP\s*\/\s*N\s*:?\s*([A-Z0-9][A-Z0-9./-]{4,})/i;

/** Accept a `P/N : …` value only when it looks like a genuine code, not a number. */
function isUsableInlinePartNo(value: string | undefined): value is string {
  if (!value) return false;
  if (LINE_ITEM_RE.test(value)) return false;
  if (/[A-Za-z]/.test(value)) return true;
  // Digit-only: a real part number is long (`5702428662864`); the short numeric
  // `P/N : 2102024` on a HEATER row is the maker's catalogue number, and carrying
  // it would put an unrelated number in the report as the item's identity.
  return /^\d{8,}$/.test(value);
}

/** The real part number of a row: the Part No cell, else a `P/N : …` code. */
function partNoFromRow(head: string, rest: string): string | null {
  const cell = extractPartNo(head);
  if (cell) return cell;
  // Only the ROW's own text: reading a multi-line lookahead picked up the NEIGHBOURING
  // row's `P/N` (a MINI BAR row's code landed on the water-heater row above it), which
  // is a false identity rather than a missing one.
  const inline = PN_INLINE_RE.exec(rest)?.[1];
  return isUsableInlinePartNo(inline) ? inline : null;
}

/** Junk left behind by the overflowing Part No cell, e.g. `5.70243E+`. */
const PART_CELL_JUNK_RE = /\b\d\.\d{3,}E[+-]?\b/;

/**
 * The date + money tail the PO prints at the END of a description's last line
 * (`ЕҢДҶвҖқ WALL 05-OCT-2026 5,100.00 10,200.00`).
 *
 * The embedded columns are only separate visually; the text layer appends them to
 * the prose, so the description the operator asked for ("ЕҫВҰв”ҳГӨв”ҳЕӮЕҫД„в”ҳГј в”ҳДҒЕҫВҰв”ҳДЈв”ҳГӨв”ҳЕ—ЕҫВҰ") carried a
 * delivery date and two figures that are NOT part of the item's name. The money
 * is already parsed as `unitPrice`/`lineTotal` and the date is a column of its
 * own, so leaving them in the description duplicates data and makes two identical
 * parts look different.
 */
const DESCRIPTION_TAIL_RE =
  /\s*\b\d{2}-[A-Za-z]{3}-\d{4}\b\s+[\d,]+\.\d{2}(?:\s+[\d,]+\.\d{2})?.*$/;

/** Strip the printed date/price tail from a description fragment. */
function stripDescriptionTail(text: string): string {
  return text.replace(DESCRIPTION_TAIL_RE, "").replace(/\s+/g, " ").trim();
}

/**
 * Page furniture that the PDF text layer interleaves with a row's real
 * description ЕҢДҶГ¶ never prose, always a stamp or a running footer.
 *
 * Seen live on EDC POs: every page repeats `P26E11255` (the document's own
 * number) and `Page N of M`, and the extractor can place them BETWEEN a row's
 * part number and its description. Left unhandled they became the description,
 * which is how a part ordered 100+ times surfaced as
 * в”¬ВҪP26E11255 Page 2 of 4в”¬в•— ЕҢДҶГ¶ a row that looks authoritative and says nothing.
 */
const PAGE_FURNITURE_RE =
  /^(?:Page\s+\d+\s+of\s+\d+|[A-Z]\d{2}[A-Z]\d{5}(?:\([A-Z0-9]+\))?|PURCHASE ORDER|REQUEST FOR QUOTE|REQUEST FOR QUOTATION|(?:PO|RFQ)\s*(?:number|no\.?)\s*:.*)$/i;

/**
 * Parse the line-item table out of an EDC RFQ/PO attachment's text.
 *
 * Two layouts, because the RFQ and the PO place the part number differently:
 *  - PO:  `1 0 Each 21-OCT-2026 34.00 0.00` followed by `5720.003.GENRAL.7539`
 *    and the description on the NEXT lines.
 *  - RFQ: `1 24 Each ЕҢДҶвҖқ` with the part number in the Part No column ЕҢДҶГ¶ and, when
 *    that cell overflows, recoverable only from the `P/N : ЕҢДҶвҖқ` in the
 *    description.
 *
 * Parsing is restricted to the region AFTER the table header, which is what
 * keeps a sentence that happens to start with a number from being read as an
 * item. When the header is absent the whole text is scanned, so a document with
 * a slightly different header still yields items rather than nothing.
 */
export function parseLineItems(text: string, docId: string | null = null): ParsedLineItem[] {
  const lines = (text || "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const headerAt = lines.findIndex((l) => TABLE_HEADER_RE.test(l));
  const startAt = headerAt >= 0 ? headerAt + 1 : 0;
  const items: ParsedLineItem[] = [];

  for (let i = startAt; i < lines.length; i++) {
    const line = lines[i];
    // The totals / restatement pages END the item table. The PO prints a
    // в”¬ВҪPurchase Order Distribution Listв”¬в•— on page 2 that restates every line, so
    // continuing past the totals double-counts each item.
    if (TABLE_END_RE.test(line)) break;
    if (TABLE_NOISE_RE.test(line)) continue;
    const m = ITEM_ROW_RE.exec(line);
    if (!m) continue;
    const [, noStr, qtyStr, word, restRaw] = m;
    if (!UOM_RE.test(word)) continue;
    const rest = restRaw.trim();
    const lookahead = lines.slice(i, i + 6).join(" ");
    // The row's money tail splits it into a HEAD cell and the trailing
    // columns. Whatever comes first on the row - a `Part No` code, or the
    // description when that cell is empty - is in the head.
    const priceOnRow = PO_PRICE_RE.exec(rest);
    const head = (priceOnRow ? rest.slice(0, priceOnRow.index) : rest).trim();

    // The `Line Item` code lives in its OWN column, printed on the line BELOW
    // the row; on some restatements it is inline, so the row itself is checked
    // too. It is never the Part Number — the two are separate fields.
    const lineItemNo = LINE_ITEM_RE.exec(rest)?.[0] ?? LINE_ITEM_RE.exec(lookahead)?.[0] ?? null;

    const partNo = partNoFromRow(head, rest);
    // Without any identifier at all the row is not a table row - unless the
    // document had no recognisable header, where the description alone still
    // identifies it (a part number is never REQUIRED).
    if (!lineItemNo && !partNo && headerAt < 0) continue;

    // Money and identity are read from the ROW plus its immediate lookahead: on
    // the PO the price sits on the row and the part number on the next lines, so
    // neither field alone sees both.
    const priceOn = PO_PRICE_RE.exec(rest) ?? PO_PRICE_RE.exec(lookahead);
    const unitPrice = priceOn ? parseMoney(priceOn[1]) : null;
    const lineTotal = priceOn ? parseMoney(priceOn[2]) : null;

    const described = collectDescription(lines, i, rest, partNo);
    // An ERP writes its tax row as a code with no prose: a Line Item code
    // (`0600.000.GENRAL.0005`) and a quantity, immediately followed by the totals
    // marker `VALUE ADDED TAX LOCAL`. Live, that pseudo-line sat atop "most
    // repeated" across 134 orders. A genuine line item always carries prose, so
    // an un-described row is dropped when it sits at the totals boundary вҖ” and
    // also when it carries no Line Item code at all (nothing identifies it).
    if (!described.text && (described.hitTotals || !lineItemNo)) continue;

    items.push({
      lineNo: Number(noStr),
      partNo,
      lineItemNo,
      description: described.text,
      qty: Number(qtyStr),
      uom: normaliseUom(word),
      unitPrice,
      lineTotal,
      docId,
    });
  }
  return items;
}

/** Parse a printed money token (`1,026.00`) into a number; null when invalid. */
function parseMoney(token: string): number | null {
  const n = Number(token.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Words that appear in the column region but are never a part number. */
const NON_PART_NO_WORDS =
  /^(Each|Piece|Pieces|Pcs|Nos|Unit|Units|Set|Sets|Box|Boxes|Roll|Rolls|Meter|Metre|Mtr|Kg|Ton|Litre|Liter|Ltr|Bag|Drum|Pair|Line|No|Quantity|UOM|Part|Item|Delivery|Date|Unit|Price|Total|EGP)$/i;

/**
 * The real `Part No` cell at the head of a PO row, or null.
 *
 * The EDC PO prints the description immediately after the UOM and leaves the
 * `Part No` cell empty on most rows, so the head is USUALLY prose. Scanning it for
 * anything code-like would pull a model number out of the description and label it
 * a part number — worse than reporting none. The cell is therefore accepted only
 * when the head IS the code and nothing else; otherwise the item's part numbers
 * come from an explicit `P/N : …` in the description (see PN_INLINE_RE).
 */
export function extractPartNo(head: string): string | null {
  const tokens = head.split(/\s+/).filter(Boolean);
  if (tokens.length !== 1) return null;
  const t = tokens[0];
  if (LINE_ITEM_RE.test(t)) return null;
  if (!PART_NO_TOKEN_RE.test(t)) return null;
  if (NON_PART_NO_WORDS.test(t)) return null;
  // Require BOTH a letter and a digit: a plain quantity or a bare word is not a
  // part number.
  if (!/[A-Za-z]/.test(t) || !/\d/.test(t)) return null;
  return t;
}

/**
 * The document number printed inside an attachment's text, if any.
 *
 * Falls back to null so a document that omits it still parses; callers then key
 * occurrences on the message instead (see `docIdFor`).
 */
export function documentNumber(text: string): string | null {
  return DOC_NUMBER_RE.exec(text || "")?.[1] ?? null;
}

/** The kind of document an attachment is. */
export type DocumentKind = "po" | "rfq" | "unknown";

/**
 * Classify an attachment as a PURCHASE ORDER or a REQUEST FOR QUOTE.
 *
 * The operator's rule is explicit: count POs, NOT RFQs or quotations. The two
 * arrive from the same sender with nearly identical item tables, so without this
 * the census mixes quotes into an order-frequency ranking ЕҢДҶГ¶ a part в”¬ВҪordered 5
 * timesв”¬в•— could be a part merely quoted 5 times, which is a different fact.
 *
 * Two independent signals, because neither alone is reliable:
 *  - the title (`PURCHASE ORDER` / `REQUEST FOR QUOTE|QUOTATION`), which the
 *    generator prints but a scanned copy may lose;
 *  - the document number's prefix ЕҢДҶГ¶ EDC writes `P26E14630` for a PO and
 *    `26R011954` for an RFQ, so the leading letter identifies the type even when
 *    the title is unreadable.
 */
export function documentKind(text: string, subject?: string | null): DocumentKind {
  const t = (text || "").toUpperCase();
  // The title wins when present: it is the generator's own statement of intent.
  const saysPo = /\bPURCHASE\s+ORDER\b/.test(t);
  const saysRfq = /\bREQUEST\s+FOR\s+(QUOTE|QUOTATION)\b/.test(t) || /\bQUOTATION\b/.test(t);
  if (saysPo && !saysRfq) return "po";
  if (saysRfq && !saysPo) return "rfq";
  // Otherwise fall back to the number's prefix.
  const no = documentNumber(text);
  if (no) {
    if (/^P\d/i.test(no)) return "po";
    if (/^\d{2}R/i.test(no) || /^R\d/i.test(no)) return "rfq";
  }
  // The explicit label EDC prints beside the number (`PO number:` / `RFQ number:`).
  if (/\bPO\s*(?:number|no\.?)\s*:/.test(t)) return "po";
  if (/\bRFQ\s*(?:number|no\.?)\s*:/.test(t)) return "rfq";
  // The SUBJECT is the last resort: EDC titles its mail «EDC PO No P26E14708» /
  // «EDC RFQ No 26R011900», and a scanned copy whose text layer dropped the
  // title would otherwise be counted as an unidentified PO — inflating the PO
  // census the operator is asked to trust.
  const s = (subject || "").toUpperCase();
  if (/\bPO\s*(?:NO|NUMBER|#)/.test(s)) return "po";
  if (/\bRFQ\s*(?:NO|NUMBER|#)/.test(s) || /\bREQUEST\s+FOR\s+(QUOTE|QUOTATION)\b/.test(s)) {
    return "rfq";
  }
  return "unknown";
}

/** Description for an item: text after the part number, plus following prose. */
function collectDescription(
  lines: string[],
  startIndex: number,
  rowRest: string,
  partNo: string | null,
): { text: string; hitTotals: boolean } {
  const parts: string[] = [];
  let hitTotals = false;
  const at = partNo ? rowRest.indexOf(partNo) : -1;
  const head = stripOverflowPartNo(
    (at >= 0 ? rowRest.slice(at + (partNo as string).length) : rowRest)
      // Drop the overflowing Part No cell's leftover ("5.70243E+") and any wrapped
      // part-number fragments that landed on this row.
      .replace(PART_CELL_JUNK_RE, " ")
      .replace(LINE_ITEM_RE, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  // A real description has a word in it. This drops the PO row's date/price
  // tail ("05-OCT-2026 75.00 900.00"), whose description is on the lines below.
  if (/[A-Za-z\u0600-\u06FF]{4,}/.test(head) && !PAGE_FURNITURE_RE.test(head)) {
    parts.push(stripDescriptionTail(head));
  }

  for (let j = startIndex + 1; j < lines.length && j <= startIndex + MAX_DESCRIPTION_LINES; j++) {
    const raw = lines[j];
    if (TABLE_END_RE.test(raw)) {
      hitTotals = true;
      break;
    }
    if (ITEM_ROW_RE.test(raw)) break;
    // A stamp or running footer is never the description: SKIP it and keep
    // looking at the following lines, because the real prose sits after it on
    // the page (breaking here is what produced the live в”¬ВҪP26E11255 Page 2 of 4в”¬в•—
    // description).
    if (PAGE_FURNITURE_RE.test(raw)) continue;
    // A continuation line carries the row's line number, and often the wrapped
    // fragment of an overflowing Part No cell: `12 GENRAL.0 RECIPROCATING ЕҢДҶвҖқ`.
    // The line's Line Item code is a COLUMN of its own that the text layer can
    // drop inside the prose (`CODE 1001.001.USED.0360 ) FOR ELECTRICAL`); the
    // code is removed and the prose kept, rather than dropping the operator's
    // description for containing it.
    const next = stripDescriptionTail(
      stripOverflowPartNo(stripRowFurniture(raw)).replace(LINE_ITEM_RE, " "),
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!next) continue;
    if (/^Note:?$/i.test(next)) continue;
    // Prose with ≥2 words is kept, and so is a continuation after one has
    // started. A wrapped «التوصيف الكامل» ends in short fragments that carry a
    // word but are fewer than 4 characters, and a 4-char-only rule stopped there
    // and cut the description mid-phrase. The word count is what still rejects
    // a money/date-only tail (which has no letters at all).
    const words = next.split(/\s+/).filter((w) => /[A-Za-z\u0600-\u06FF]{4,}/.test(w));
    if (words.length >= 2 || (words.length === 1 && parts.length > 0)) parts.push(next);
    else if (isPartNoFragment(next)) continue;
    else break;
  }
  return { text: parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim(), hitTotals };
}

/**
 * A wrapped `Part No` cell that the text layer pushed onto its own line, with no
 * prose of its own (`SFCTR3P30`, `A24VSA2L`, `EWL-X0000`, `LSGP-40-`).
 *
 * Such a line carries no 4-letter word, so the description collector used to
 * treat it as the END of the description and stop — silently dropping the real
 * prose that followed it on the next lines. Seen live on EDC P26E09609: the row
 * read «P/N : SFCTR3P30A24VSA2L , CONTACTOR ,3P» and then `SFCTR3P30` /
 * `A24VSA2L` on their own lines, after which «,30A 24VAC / SCREWS,24V COIL FOR
 * TRANE SCR HVAC , ( OLD P/N : CTR02575 )» was lost. The fragment is SKIPPED
 * rather than treated as prose or as an end marker.
 *
 * Deliberately narrow — a code is only a fragment when it is ALMOST ALL uppercase
 * letters, digits, dots and dashes (a category word such as `VALUE ADDED TAX` is
 * prose and must never match).
 */
function isPartNoFragment(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 24 || !/\d/.test(t)) return false;
  return /^[A-Z0-9][A-Z0-9./-]*$/.test(t);
}

/**
 * Remove the leading furniture the PDF's columns leave on a continuation line:
 * the row's line number and the wrapped fragment of an overflowing Part No cell
 * (observed on a real RFQ: `12 GENRAL.0 RECIPROCATING COMPRESSOR ЕҢДҶвҖқ` and
 * `084 MT100HS4EVE ЕҢДҶвҖқ`).
 */
function stripRowFurniture(line: string): string {
  return line
    .replace(/^\d{1,3}\s+/, "")
    .replace(/^[A-Z]{3,}\.\d+\b\s*/, "")
    .replace(/^\d{3,}\s+(?=[A-Za-z\u0600-\u06FF])/, "")
    .replace(/^Note:?\s*/i, "")
    .trim();
}

/**
 * Drop the overflowing `Part No` cell's fragment from a continuation line.
 *
 * The EDC generator sometimes pushes the Part No cell onto the NEXT visual line,
 * glued ahead of the description (`3RV20214AA P/N : 3RV20214AA10 , CIRCUIT
 * BREAKER, 460V,`). The line then begins with a digit, so it was taken for a new
 * table row and the row's description came out EMPTY — the item surfaced in the
 * report with no name at all, which is the field the operator audits by.
 *
 * The fragment is removed only when CORROBORATED: the remainder still carries a
 * `P/N :` marker and the fragment is a prefix of that value (or of it). A plain
 * description that merely opens with a code-shaped word is left intact, because
 * silently deleting its first word would damage real prose.
 */
function stripOverflowPartNo(line: string): string {
  const m = /^([A-Z0-9][A-Z0-9./-]{2,24})\s+\S/i.exec(line);
  if (!m) return line;
  const frag = m[1].toUpperCase();
  if (!/\d/.test(frag)) return line;
  const rest = line.slice(m[0].length - 1);
  const inline = PN_INLINE_RE.exec(rest)?.[1]?.toUpperCase();
  if (inline && (inline.startsWith(frag) || frag.startsWith(inline))) return rest;
  return line;
}

/** Canonical UOM label, preserving the document's own word. */
function normaliseUom(word: string): string {
  const hit = UOM_RE.exec(word);
  return hit ? hit[1] : word;
}

/** One part aggregated across every ORDERS it appeared on. */
export interface AggregatedPart {
  /** The real Part Number (short code), when the documents printed one. */
  partNo: string | null;
  description: string;
  /** Total quantity across all occurrences. */
  qty: number;
  uom: string | null;
  /** How many distinct ORDER DOCUMENTS carried this part. */
  occurrences: number;
  /**
   * Average unit price over the lines that printed one, or null when none did.
   * Present as an ANALYTICAL value only - never a basis for the total.
   */
  avgUnitPrice: number | null;
  /**
   * Total amount for the item = the SUM OF THE PRINTED LINE TOTALS across every
   * order. The operator's rule: never `total qty x average unit price`. The two
   * differ whenever the same item carried different quantities/prices across
   * orders. Null when no line yielded a total.
   */
  totalValue: number | null;
  /**
   * True when at least one contributing line's total was COMPUTED (qty x the
   * unit price printed on that SAME PO) rather than read from the document. The
   * report must distinguish a transferred figure from a calculated one.
   */
  totalComputed: boolean;
  /** Distinct document numbers the part appeared in - the audit trail. */
  documents: string[];
  /** Every Line Item code seen for this item (the ERP's `1531.032.GENRAL.7538`). */
  lineItemNos: string[];
  /**
   * Every part number seen for this item. More than one means the item was
   * written with different codes (or one order omitted it) and the identity
   * grouping joined them - the operator asked for exactly this.
   */
  partNos: string[];
  /**
   * True when a Line Item code, part number or model code pins the identity.
   * False means the cluster rests on prose alone, which is reported separately
   * rather than presented as certain.
   */
  identityConfident: boolean;
  /**
   * The printed `Line No.` row numbers, deduped and sorted. Deliberately NOT
   * part of the identity: the same item is row 1 on one PO and row 3 on the
   * next. It is carried because it lets the operator open the right row.
   */
  lineItems: number[];
}

/** Unit of measure as it should appear beside an aggregated quantity. */
function dominantUom(items: ParsedLineItem[]): string | null {
  const counts = new Map<string, number>();
  for (const it of items) {
    if (!it.uom) continue;
    counts.set(it.uom, (counts.get(it.uom) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [uom, n] of counts) {
    if (n > bestN) {
      best = uom;
      bestN = n;
    }
  }
  return best;
}

/**
 * Roll parsed lines up by ITEM IDENTITY (not by part number).
 *
 * Grouping on the part number alone answers the wrong question: the operator
 * wants "which item was ordered most often", and an item written `P/N : A9R41440`
 * on one PO and by description alone on the next is ONE item. The grouping is
 * therefore delegated to `groupByItemIdentity`, which compares the whole item
 * (part number, description, model, size, capacity, unit) and refuses to merge
 * two items whose distinguishing attributes conflict.
 *
 * Occurrences count DOCUMENTS, not lines: one PO that prints a part on three
 * lines (or restates it on its distribution page) is one order. Counting lines
 * would let a single noisy document top a frequency ranking.
 *
 * Sort order is by QUANTITY: this function is the VOLUME view (the caller's
 * `ordering=qty`). The frequency view ЕҢДҶГ¶ в”¬ВҪЕҫЕ»в”ҳДҒЕҫВ¬Еҫв–’ ЕҫВ©в”ҳГҘЕҫВ» ЕҫВҰЕҫВ¬в”ҳДҒЕҫв–’Еҫв–’в”¬в•—, where a part on 10
 * orders outranks a part on 3 with a far larger quantity ЕҢДҶГ¶ is
 * `aggregateItemsByOccurrence`, which sorts on `occurrences`.
 */
export function aggregateItems(items: ParsedLineItem[]): AggregatedPart[] {
  // A line whose description is only page furniture is not an item at all; it is
  // dropped before grouping so it can neither form a cluster nor join one.
  const usable = items.filter((it) => itemKey(it) !== "");
  const groups = groupByItemIdentity(
    usable.map((it) => ({
      // The ERP's Line Item code is the strongest identity an EDC document
      // offers, so it leads; the real Part Number is the fallback for the
      // (rare) row that prints one but no code.
      partNo: it.lineItemNo || it.partNo,
      description: it.description,
      row: it,
    })),
  );

  const out: AggregatedPart[] = [];
  for (const group of groups) {
    const lines = group.rows.map((r) => r.row);
    const docs = new Set<string>();
    const partNos = new Set<string>();
    const lineItemNos = new Set<string>();
    const lineItems = new Set<number>();
    let description = "";
    let qty = 0;
    // Totals are summed PER ORDER, exactly as the operator requires. A line
    // that printed no total is computed from ITS OWN PO's qty x unit price and
    // flagged, never replaced by `total qty x average price`.
    let totalValue = 0;
    let sawTotal = false;
    let totalComputed = false;

    lines.forEach((it, idx) => {
      qty += it.qty ?? 0;
      const pn = (it.partNo || "").trim();
      if (pn) partNos.add(pn);
      const lin = (it.lineItemNo || "").trim();
      if (lin) lineItemNos.add(lin);
      if (typeof it.lineNo === "number" && Number.isFinite(it.lineNo)) lineItems.add(it.lineNo);
      if (it.lineTotal != null) {
        totalValue += it.lineTotal;
        sawTotal = true;
      } else if (it.unitPrice != null && it.qty != null) {
        totalValue += it.unitPrice * it.qty;
        sawTotal = true;
        totalComputed = true;
      }
      // A line with no document number still counts as its own occurrence, keyed
      // on the line so it can never silently vanish from the total.
      const doc = (it.docId || "").trim() || `__line_${idx}__${it.lineNo ?? ""}`;
      docs.add(doc);
      // Keep the LONGEST description seen - the operator asked for the full text,
      // and the PDF wraps the same item across lines with varying completeness.
      // `it.description` is already the merged prose for one line, so comparing
      // the merged strings picks the most complete rendering of the item.
      if ((it.description || "").length > description.length) description = it.description;
    });

    const priced = lines.filter((l) => l.unitPrice != null && l.unitPrice > 0);
    out.push({
      // The most specific code seen, so a cluster that includes a part-numbered
      // line is not reported as missing one.
      partNo: partNos.size ? [...partNos].sort((a, b) => b.length - a.length)[0] : null,
      description,
      qty,
      uom: dominantUom(lines),
      occurrences: docs.size,
      avgUnitPrice: priced.length
        ? Number((priced.reduce((s, l) => s + (l.unitPrice ?? 0), 0) / priced.length).toFixed(4))
        : null,
      totalValue: sawTotal ? Number(totalValue.toFixed(2)) : null,
      totalComputed,
      documents: [...docs].filter((d) => !d.startsWith("__line_")),
      lineItemNos: [...lineItemNos].sort(),
      partNos: [...partNos],
      identityConfident: hasConfidentIdentity(group.identity),
      lineItems: [...lineItems].sort((a, b) => a - b),
    });
  }

  return out.sort((a, b) => b.qty - a.qty || b.occurrences - a.occurrences);
}

/**
 * The identity a line is grouped by.
 *
 * Deliberately NOT the part number: the operator's rule is that a Part Number is
 * not an item's identity ЕҢДҶГ¶ it may be missing, misspelled, or printed on one PO
 * and absent from the next for the same item. Keying on it alone split one item
 * into several (the live case: the same breaker counted twice because one PO
 * printed `P/N : A9R41440` and another only the description).
 *
 * This function still returns a per-LINE key (used to dedupe an exact repeat and
 * as a cheap first pass); the authoritative grouping across wordings is
 * `groupByItemIdentity` in `item-identity.ts`, which compares the whole item ЕҢДҶГ¶
 * part number, description, model, size, capacity, unit ЕҢДҶГ¶ and refuses to merge
 * two items whose model/size/capacity differ.
 *
 * Description keys are never number-stripped: stripping numbers would merge
 * genuinely different parts (в”¬ВҪ50 MMв”¬в•— / в”¬ВҪ70 MMв”¬в•—), which is the opposite error.
 */
export function itemKey(it: ParsedLineItem): string {
  const strong = (it.lineItemNo || it.partNo || "").trim();
  if (strong) return strong.toUpperCase();
  const description = (it.description || "").trim();
  if (description.length < MIN_DESCRIPTION_KEY_LEN) return "";
  return description.toUpperCase();
}

/**
 * Shortest description that can stand in for a part number. Below this the text
 * is page furniture, not an item name.
 */
const MIN_DESCRIPTION_KEY_LEN = 4;

/**
 * Roll parsed lines up ranked by how often an ORDER carried the part.
 *
 * в”¬ВҪЕҫЕ»в”ҳДҒЕҫВ¬Еҫв–’ ЕҫВ©в”ҳГҘЕҫВ» ЕҫВҰЕҫВ¬в”ҳДҒЕҫв–’Еҫв–’в”¬в•— is about FREQUENCY, not volume: a single huge line (1,000
 * pcs ordered once) would top a quantity-ranked list over a small part that
 * appears on every order. The default quantity ranking answers a different
 * question, so the frequency view is its own sort rather than a re-slice.
 *
 * `minOccurrences` is the operator's explicit rule: a part seen on only one
 * order is excluded even when its quantity is huge. Defaults to 1 so callers
 * that want the raw list are unaffected.
 */
export function aggregateItemsByOccurrence(
  items: ParsedLineItem[],
  minOccurrences = 1,
): AggregatedPart[] {
  return aggregateItems(items)
    .filter((p) => p.occurrences >= Math.max(1, minOccurrences))
    .sort((a, b) => b.occurrences - a.occurrences || b.qty - a.qty);
}

/** Items parsed from one message. */
export interface MessageItems {
  uid: number;
  mailbox: string;
  folder: string;
  subject: string;
  date: string;
  /** Attachment the items came from. */
  filename: string;
  items: ParsedLineItem[];
}

/** Per-message coverage of an item parse. */
export interface ItemScanCoverage {
  /** Messages considered. */
  messages: number;
  /** Messages with at least one readable PDF attachment. */
  readable: number;
  /** Messages that yielded at least one parsed item. */
  withItems: number;
  /** Messages whose PDF was readable but contained no item table. */
  noItems: number;
  /** Messages whose PDF had no text layer or could not be parsed. */
  unreadable: number;
  /** Messages with no PDF attachment at all. */
  noAttachment: number;
  /** PDF attachments parsed. */
  attachments: number;
  /** Total parsed lines. */
  lines: number;
  /** PDF pages actually rendered — evidence of how much was really processed. */
  pages: number;
  /** Purchase-order documents read (the operator counts POs, not RFQs). */
  poDocuments: number;
  /** RFQ / quotation documents read ЕҢДҶГ¶ parsed for coverage but excluded. */
  rfqDocuments: number;
  /** Documents whose type could not be determined. */
  unknownDocuments: number;
}

export interface ItemScanResult {
  messages: MessageItems[];
  items: ParsedLineItem[];
  aggregate: AggregatedPart[];
  coverage: ItemScanCoverage;
}

/**
 * Parse the line items out of already-downloaded attachments.
 *
 * Kept separate from the IMAP layer (`fetchMessageAttachments`) so the parser
 * and the aggregation can be tested against real document text with no mailbox.
 */
export async function parseItemsFromAttachments(
  messages: MessageAttachments[],
): Promise<ItemScanResult> {
  const coverage: ItemScanCoverage = {
    messages: messages.length,
    readable: 0,
    withItems: 0,
    noItems: 0,
    unreadable: 0,
    noAttachment: 0,
    attachments: 0,
    lines: 0,
    pages: 0,
    poDocuments: 0,
    rfqDocuments: 0,
    unknownDocuments: 0,
  };
  const out: MessageItems[] = [];
  const flat: ParsedLineItem[] = [];

  for (const message of messages) {
    if (!message.attachments.length) {
      coverage.noAttachment += 1;
      continue;
    }
    let sawReadable = false;
    let sawItem = false;
    for (const att of message.attachments) {
      if (!att.content) continue;
      coverage.attachments += 1;
      const { text, pages } = await extractPdfTextDetailed(att.content);
      coverage.pages += pages;
      if (!text) continue;
      sawReadable = true;
      // The document's own number when it prints one, else the message+file ЕҢДҶГ¶
      // occurrences must key on the ORDER, and a message with two attachments
      // (PO plus its distribution copy) is one order, not two.
      const docId = documentNumber(text) ?? `${message.mailbox}#${message.uid}#${att.filename}`;
      // Only PURCHASE ORDERS count. The operator's rule is explicit: POs, not
      // RFQs or quotations ЕҢДҶГ¶ the same sender sends both with identical item
      // tables, so counting RFQs would report a part в”¬ВҪorderedв”¬в•— on quotes that
      // were never ordered. Non-PO documents are still READ (so coverage is
      // honest about what was opened) but their lines are not counted.
      const kind = documentKind(text, message.subject);
      if (kind === "rfq") {
        coverage.rfqDocuments += 1;
        continue;
      }
      if (kind === "unknown") coverage.unknownDocuments += 1;
      else coverage.poDocuments += 1;
      const items = parseLineItems(text, docId);
      if (!items.length) continue;
      sawItem = true;
      coverage.lines += items.length;
      out.push({ ...message, filename: att.filename, items });
      flat.push(...items);
    }
    if (sawReadable) coverage.readable += 1;
    else coverage.unreadable += 1;
    if (sawItem) coverage.withItems += 1;
    else if (sawReadable) coverage.noItems += 1;
  }

  return { messages: out, items: flat, aggregate: aggregateItems(flat), coverage };
}

/** CSV of the item census: one row per parsed line, so nothing is lost. */
export function itemsCsv(result: ItemScanResult): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    "mailbox,date,subject,filename,docId,lineNo,lineItemNo,partNo,description,qty,uom,unitPrice,lineTotal",
  ];
  for (const m of result.messages) {
    for (const it of m.items) {
      lines.push(
        [
          m.mailbox,
          m.date,
          m.subject,
          m.filename,
          it.docId ?? "",
          it.lineNo ?? "",
          it.lineItemNo ?? "",
          it.partNo ?? "",
          it.description,
          it.qty ?? "",
          it.uom ?? "",
          it.unitPrice ?? "",
          it.lineTotal ?? "",
        ]
          .map(esc)
          .join(","),
      );
    }
  }
  return lines.join("\n");
}

/** Aggregate CSV ЕҢДҶГ¶ the summary the operator reads, one row per part. */
export function itemsAggregateCsv(parts: AggregatedPart[]): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    "description,lineItemNo,partNo,allPartNos,lineItems,orders,totalQty,uom,avgUnitPrice,totalValue,totalComputed,identityConfident,documents",
  ];
  for (const p of parts) {
    lines.push(
      [
        p.description,
        p.lineItemNos.join(" | "),
        p.partNo ?? "",
        p.partNos.join(" | "),
        p.lineItems.join(" | "),
        p.occurrences,
        p.qty,
        p.uom ?? "",
        p.avgUnitPrice ?? "",
        p.totalValue ?? "",
        p.totalComputed ? "computed" : "from-document",
        p.identityConfident ? "yes" : "no",
        p.documents.join(" | "),
      ]
        .map(esc)
        .join(","),
    );
  }
  return lines.join("\n");
}
