/**
 * AI Assistant — line items read out of email attachments.
 *
 * The document numbers live in the subject, but the ITEMS live inside the
 * attached RFQ/PO PDF (EDC sends a «REQUEST FOR QUOTE» or «PURCHASE ORDER» with
 * a line table). Reading them through the model is not viable for a year's mail:
 * Gemini's free tier is 20 requests/day/model, so extraction runs locally on the
 * PDF text layer.
 *
 * The parser understands the two EDC layouts explicitly, and every caller gets a
 * coverage record — an empty result must never be indistinguishable from an
 * unreadable file, which is how "this order has no items" would be reported for
 * a document nobody managed to open.
 */
import { extractPdfText, type MessageAttachments } from "./email";
import { groupByItemIdentity, hasConfidentIdentity } from "./item-identity";

/** One parsed order line. */
export interface ParsedLineItem {
  lineNo: number | null;
  partNo: string | null;
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
 * Part numbers as they appear on EDC documents: four digits, a three-digit
 * group, a category word, then a running number (5720.001.GENRAL.0024). The
 * category varies in length (0600.000.GENRAL.0005), so the segment count is not
 * fixed.
 */
const PART_NO_RE = /\b\d{4}\.\d{3}\.[A-Z0-9]{2,}(?:\.[A-Z0-9]+)+\b/;

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

/** Does this line begin a new item row (`1 24 Each …`)? */
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
 * counted against — the operator asks how many ORDERS carried a part, and one
 * PO that lists a part on three lines is still one order.
 */
const DOC_NUMBER_RE = /\b(?:PO|RFQ)\s*(?:number|no\.?)\s*:?\s*([A-Z0-9][A-Z0-9-]{4,})/i;

/**
 * The table's column header — where the item region starts. The RFQ prints it as
 * `Line Quantity UOM Part No …`; the PO splits it, with `Line` / `No.` on their
 * own lines before `Quantity UOM Part No …`, so matching the `Quantity UOM` pair
 * covers both.
 */
const TABLE_HEADER_RE = /^(?:Line\s+)?Quantity\s+UOM\b/i;

/**
 * A part number written in the description (`P/N : 5702428662864`) rather than
 * in the Part No column. EDC's RFQ generator wraps/overflows the Part No cell
 * (observed: `5.70243E+` then `1854.027.` on the next visual line), so the
 * description's P/N is the reliable identifier for those rows.
 */
const PN_INLINE_RE = /\bP\s*\/\s*N\s*:?\s*([A-Z0-9][A-Z0-9./-]{4,})/i;

/** Junk left behind by the overflowing Part No cell, e.g. `5.70243E+`. */
const PART_CELL_JUNK_RE = /\b\d\.\d{3,}E[+-]?\b/;

/**
 * Page furniture that the PDF text layer interleaves with a row's real
 * description — never prose, always a stamp or a running footer.
 *
 * Seen live on EDC POs: every page repeats `P26E11255` (the document's own
 * number) and `Page N of M`, and the extractor can place them BETWEEN a row's
 * part number and its description. Left unhandled they became the description,
 * which is how a part ordered 100+ times surfaced as
 * «P26E11255 Page 2 of 4» — a row that looks authoritative and says nothing.
 */
const PAGE_FURNITURE_RE =
  /^(?:Page\s+\d+\s+of\s+\d+|[A-Z]\d{2}[A-Z]\d{5}(?:\([A-Z0-9]+\))?|PURCHASE ORDER|REQUEST FOR QUOTE|REQUEST FOR QUOTATION|(?:PO|RFQ)\s*(?:number|no\.?)\s*:.*)$/i;

/**
 * Parse the line-item table out of an EDC RFQ/PO attachment's text.
 *
 * Two layouts, because the RFQ and the PO place the part number differently:
 *  - PO:  `1 0 Each 21-OCT-2026 34.00 0.00` followed by `5720.003.GENRAL.7539`
 *    and the description on the NEXT lines.
 *  - RFQ: `1 24 Each …` with the part number in the Part No column — and, when
 *    that cell overflows, recoverable only from the `P/N : …` in the
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
    // «Purchase Order Distribution List» on page 2 that restates every line, so
    // continuing past the totals double-counts each item.
    if (TABLE_END_RE.test(line)) break;
    if (TABLE_NOISE_RE.test(line)) continue;
    const m = ITEM_ROW_RE.exec(line);
    if (!m) continue;
    const [, noStr, qtyStr, word, restRaw] = m;
    if (!UOM_RE.test(word)) continue;
    const rest = restRaw.trim();
    const lookahead = lines.slice(i, i + 6).join(" ");
    // The part number is on the row, within the next few lines (PO), or written
    // as `P/N : …` in the description (RFQ). Without one of those this is not a
    // table row.
    const partNo =
      PART_NO_RE.exec(rest)?.[0] ??
      PART_NO_RE.exec(lookahead)?.[0] ??
      PN_INLINE_RE.exec(rest)?.[1] ??
      PN_INLINE_RE.exec(lookahead)?.[1] ??
      null;
    if (!partNo && headerAt < 0) continue; // no header → demand a part number

    // Money and identity are read from the ROW plus its immediate lookahead: on
    // the PO the price sits on the row and the part number on the next lines, so
    // neither field alone sees both.
    const priceOn = PO_PRICE_RE.exec(rest) ?? PO_PRICE_RE.exec(lookahead);
    const unitPrice = priceOn ? parseMoney(priceOn[1]) : null;
    const lineTotal = priceOn ? parseMoney(priceOn[2]) : null;

    const described = collectDescription(lines, i, rest, partNo);
    // An ERP writes its tax row as a part with no prose: a real part number
    // (`0600.000.GENRAL.0005`) and a quantity, immediately followed by the totals
    // marker `VALUE ADDED TAX LOCAL`. Live, that pseudo-line sat atop "most
    // repeated" across 134 orders. A genuine line item always carries prose, so
    // an un-described row whose next content line is the totals boundary is
    // accounting, not stock.
    if (!described.text && described.hitTotals) continue;

    items.push({
      lineNo: Number(noStr),
      partNo,
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
 * the census mixes quotes into an order-frequency ranking — a part «ordered 5
 * times» could be a part merely quoted 5 times, which is a different fact.
 *
 * Two independent signals, because neither alone is reliable:
 *  - the title (`PURCHASE ORDER` / `REQUEST FOR QUOTE|QUOTATION`), which the
 *    generator prints but a scanned copy may lose;
 *  - the document number's prefix — EDC writes `P26E14630` for a PO and
 *    `26R011954` for an RFQ, so the leading letter identifies the type even when
 *    the title is unreadable.
 */
export function documentKind(text: string): DocumentKind {
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
  const head = (at >= 0 ? rowRest.slice(at + (partNo as string).length) : rowRest)
    // Drop the overflowing Part No cell's leftover ("5.70243E+") and any wrapped
    // part-number fragments that landed on this row.
    .replace(PART_CELL_JUNK_RE, " ")
    .replace(PART_NO_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  // A real description has a word in it. This drops the PO row's date/price
  // tail ("05-OCT-2026 75.00 900.00"), whose description is on the lines below.
  if (/[A-Za-z\u0600-\u06FF]{4,}/.test(head) && !PAGE_FURNITURE_RE.test(head)) parts.push(head);

  for (let j = startIndex + 1; j < lines.length && j <= startIndex + 7; j++) {
    const raw = lines[j];
    if (TABLE_END_RE.test(raw)) {
      hitTotals = true;
      break;
    }
    if (ITEM_ROW_RE.test(raw)) break;
    // A stamp or running footer is never the description: SKIP it and keep
    // looking at the following lines, because the real prose sits after it on
    // the page (breaking here is what produced the live «P26E11255 Page 2 of 4»
    // description).
    if (PAGE_FURNITURE_RE.test(raw)) continue;
    // A continuation line carries the row's line number, and often the wrapped
    // fragment of an overflowing Part No cell: `12 GENRAL.0 RECIPROCATING …`.
    const next = stripRowFurniture(raw);
    if (!next) continue;
    if (PART_NO_RE.test(next)) continue;
    if (/^Note:?$/i.test(next)) continue;
    if (/^[A-Za-z\u0600-\u06FF]/.test(next)) parts.push(next);
    else break;
  }
  return { text: parts.join(" ").replace(/\s+/g, " ").trim(), hitTotals };
}

/**
 * Remove the leading furniture the PDF's columns leave on a continuation line:
 * the row's line number and the wrapped fragment of an overflowing Part No cell
 * (observed on a real RFQ: `12 GENRAL.0 RECIPROCATING COMPRESSOR …` and
 * `084 MT100HS4EVE …`).
 */
function stripRowFurniture(line: string): string {
  return line
    .replace(/^\d{1,3}\s+/, "")
    .replace(/^[A-Z]{3,}\.\d+\b\s*/, "")
    .replace(/^\d{3,}\s+(?=[A-Za-z\u0600-\u06FF])/, "")
    .replace(/^Note:?\s*/i, "")
    .trim();
}

/** Canonical UOM label, preserving the document's own word. */
function normaliseUom(word: string): string {
  const hit = UOM_RE.exec(word);
  return hit ? hit[1] : word;
}

/** One part aggregated across every ORDERS it appeared on. */
export interface AggregatedPart {
  partNo: string | null;
  description: string;
  /** Total quantity across all occurrences. */
  qty: number;
  uom: string | null;
  /** How many distinct ORDER DOCUMENTS carried this part. */
  occurrences: number;
  /** Average unit price over the lines that printed one, or null when none did. */
  avgUnitPrice: number | null;
  /** Summed line totals over the lines that printed one, or null when none did. */
  totalValue: number | null;
  /** Distinct document numbers the part appeared in — the audit trail. */
  documents: string[];
  /**
   * Every part number seen for this item. More than one means the item was
   * written with different codes (or one order omitted it) and the identity
   * grouping joined them — the operator asked for exactly this.
   */
  partNos: string[];
  /**
   * True when a part number or model code pins the identity. False means the
   * cluster rests on prose alone, which is reported separately rather than
   * presented as certain.
   */
  identityConfident: boolean;
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
 * `ordering=qty`). The frequency view — «أكتر بند اتكرر», where a part on 10
 * orders outranks a part on 3 with a far larger quantity — is
 * `aggregateItemsByOccurrence`, which sorts on `occurrences`.
 */
export function aggregateItems(items: ParsedLineItem[]): AggregatedPart[] {
  // A line whose description is only page furniture is not an item at all; it is
  // dropped before grouping so it can neither form a cluster nor join one.
  const usable = items.filter((it) => itemKey(it) !== "");
  const groups = groupByItemIdentity(
    usable.map((it) => ({
      partNo: it.partNo,
      description: it.description,
      row: it,
    })),
  );

  const out: AggregatedPart[] = [];
  for (const group of groups) {
    const lines = group.rows.map((r) => r.row);
    const docs = new Set<string>();
    const partNos = new Set<string>();
    let description = "";
    let qty = 0;

    lines.forEach((it, idx) => {
      qty += it.qty ?? 0;
      const pn = (it.partNo || "").trim();
      if (pn) partNos.add(pn);
      // A line with no document number still counts as its own occurrence, keyed
      // on the line so it can never silently vanish from the total.
      const doc = (it.docId || "").trim() || `__line_${idx}__${it.lineNo ?? ""}`;
      docs.add(doc);
      // Keep the LONGEST description seen — the operator asked for the full text,
      // and the PDF wraps the same item across lines with varying completeness.
      if ((it.description || "").length > description.length) description = it.description;
    });

    const priced = lines.filter((l) => l.unitPrice != null && l.unitPrice > 0);
    const valued = lines.filter((l) => l.lineTotal != null);
    out.push({
      // The most specific code seen, so a cluster that includes a part-numbered
      // line is not reported as "غير متوفر".
      partNo: partNos.size ? [...partNos].sort((a, b) => b.length - a.length)[0] : null,
      description,
      qty,
      uom: dominantUom(lines),
      occurrences: docs.size,
      avgUnitPrice: priced.length
        ? Number((priced.reduce((s, l) => s + (l.unitPrice ?? 0), 0) / priced.length).toFixed(4))
        : null,
      totalValue: valued.length
        ? Number(valued.reduce((s, l) => s + (l.lineTotal ?? 0), 0).toFixed(2))
        : null,
      documents: [...docs].filter((d) => !d.startsWith("__line_")),
      partNos: [...partNos],
      identityConfident: hasConfidentIdentity(group.identity),
    });
  }

  return out.sort((a, b) => b.qty - a.qty || b.occurrences - a.occurrences);
}

/**
 * The identity a line is grouped by.
 *
 * Deliberately NOT the part number: the operator's rule is that a Part Number is
 * not an item's identity — it may be missing, misspelled, or printed on one PO
 * and absent from the next for the same item. Keying on it alone split one item
 * into several (the live case: the same breaker counted twice because one PO
 * printed `P/N : A9R41440` and another only the description).
 *
 * This function still returns a per-LINE key (used to dedupe an exact repeat and
 * as a cheap first pass); the authoritative grouping across wordings is
 * `groupByItemIdentity` in `item-identity.ts`, which compares the whole item —
 * part number, description, model, size, capacity, unit — and refuses to merge
 * two items whose model/size/capacity differ.
 *
 * Description keys are never number-stripped: stripping numbers would merge
 * genuinely different parts («50 MM» / «70 MM»), which is the opposite error.
 */
export function itemKey(it: ParsedLineItem): string {
  const partNo = (it.partNo || "").trim();
  if (partNo) return partNo.toUpperCase();
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
 * «أكتر بند اتكرر» is about FREQUENCY, not volume: a single huge line (1,000
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
  /** Purchase-order documents read (the operator counts POs, not RFQs). */
  poDocuments: number;
  /** RFQ / quotation documents read — parsed for coverage but excluded. */
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
      const text = await extractPdfText(att.content);
      if (!text) continue;
      sawReadable = true;
      // The document's own number when it prints one, else the message+file —
      // occurrences must key on the ORDER, and a message with two attachments
      // (PO plus its distribution copy) is one order, not two.
      const docId = documentNumber(text) ?? `${message.mailbox}#${message.uid}#${att.filename}`;
      // Only PURCHASE ORDERS count. The operator's rule is explicit: POs, not
      // RFQs or quotations — the same sender sends both with identical item
      // tables, so counting RFQs would report a part «ordered» on quotes that
      // were never ordered. Non-PO documents are still READ (so coverage is
      // honest about what was opened) but their lines are not counted.
      const kind = documentKind(text);
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
    "mailbox,date,subject,filename,docId,lineNo,partNo,description,qty,uom,unitPrice,lineTotal",
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

/** Aggregate CSV — the summary the operator reads, one row per part. */
export function itemsAggregateCsv(parts: AggregatedPart[]): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    "description,partNo,allPartNos,orders,totalQty,uom,avgUnitPrice,totalValue,identityConfident,documents",
  ];
  for (const p of parts) {
    lines.push(
      [
        p.description,
        p.partNo ?? "",
        p.partNos.join(" | "),
        p.occurrences,
        p.qty,
        p.uom ?? "",
        p.avgUnitPrice ?? "",
        p.totalValue ?? "",
        p.identityConfident ? "yes" : "no",
        p.documents.join(" | "),
      ]
        .map(esc)
        .join(","),
    );
  }
  return lines.join("\n");
}
