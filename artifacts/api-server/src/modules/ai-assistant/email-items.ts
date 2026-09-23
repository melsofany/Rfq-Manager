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

/** One parsed order line. */
export interface ParsedLineItem {
  lineNo: number | null;
  partNo: string | null;
  description: string;
  qty: number | null;
  uom: string | null;
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
export function parseLineItems(text: string): ParsedLineItem[] {
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

    items.push({
      lineNo: Number(noStr),
      partNo,
      description: collectDescription(lines, i, rest, partNo),
      qty: Number(qtyStr),
      uom: normaliseUom(word),
    });
  }
  return items;
}

/** Description for an item: text after the part number, plus following prose. */
function collectDescription(
  lines: string[],
  startIndex: number,
  rowRest: string,
  partNo: string | null,
): string {
  const parts: string[] = [];
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
  if (/[A-Za-z\u0600-\u06FF]{4,}/.test(head)) parts.push(head);

  for (let j = startIndex + 1; j < lines.length && j <= startIndex + 5; j++) {
    const raw = lines[j];
    if (TABLE_END_RE.test(raw)) break;
    if (ITEM_ROW_RE.test(raw)) break;
    // A continuation line carries the row's line number, and often the wrapped
    // fragment of an overflowing Part No cell: `12 GENRAL.0 RECIPROCATING …`.
    const next = stripRowFurniture(raw);
    if (!next) continue;
    if (PART_NO_RE.test(next)) continue;
    if (/^Note:?$/i.test(next)) continue;
    if (/^[A-Za-z\u0600-\u06FF]/.test(next)) parts.push(next);
    else break;
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
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

/** One part aggregated across every line it appeared on. */
export interface AggregatedPart {
  partNo: string | null;
  description: string;
  /** Total quantity across all occurrences. */
  qty: number;
  uom: string | null;
  /** How many order lines carried this part. */
  occurrences: number;
}

/**
 * Roll parsed lines up by part number.
 *
 * Grouping on the part number (falling back to the description when a document
 * omits one) answers "what did we quote/order most this year" — the operator's
 * actual question — instead of listing hundreds of raw rows.
 */
export function aggregateItems(items: ParsedLineItem[]): AggregatedPart[] {
  const map = new Map<string, AggregatedPart>();
  for (const it of items) {
    const key = itemKey(it);
    if (!key) continue;
    const hit = map.get(key);
    if (hit) {
      hit.qty += it.qty ?? 0;
      hit.occurrences += 1;
    } else {
      map.set(key, {
        partNo: it.partNo,
        description: it.description,
        qty: it.qty ?? 0,
        uom: it.uom,
        occurrences: 1,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.qty - a.qty || b.occurrences - a.occurrences);
}

/**
 * The identity a line is grouped by.
 *
 * The part number when there is one; otherwise the description. Rows with no
 * part number are common on EDC's RFQ layout (the Part No cell overflows), and
 * some of their descriptions are only fragments the PDF's columns left behind
 * (observed literally: «RCV», a location tag). Those fragments out-ranked real
 * parts on live mail — a 3-character string appearing on every order is not an
 * item — so an implausibly short description does not become its own group.
 * Description keys are never normalised further: stripping numbers would merge
 * genuinely different parts («50 MM» / «70 MM»).
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
 * Roll parsed lines up ranked by how often a part was ordered.
 *
 * «أكتر بند اتكرر» is about FREQUENCY, not volume: a single huge line (1,000
 * pcs ordered once) would top a quantity-ranked list over a small part that
 * appears on every order. The default quantity ranking answers a different
 * question, so the frequency view is its own sort rather than a re-slice.
 */
export function aggregateItemsByOccurrence(items: ParsedLineItem[]): AggregatedPart[] {
  return aggregateItems(items).sort((a, b) => b.occurrences - a.occurrences || b.qty - a.qty);
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
      const items = parseLineItems(text);
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
  const lines = ["mailbox,date,subject,filename,lineNo,partNo,description,qty,uom"];
  for (const m of result.messages) {
    for (const it of m.items) {
      lines.push(
        [
          m.mailbox,
          m.date,
          m.subject,
          m.filename,
          it.lineNo ?? "",
          it.partNo ?? "",
          it.description,
          it.qty ?? "",
          it.uom ?? "",
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
  const lines = ["partNo,description,totalQty,uom,occurrences"];
  for (const p of parts) {
    lines.push(
      [p.partNo ?? "", p.description, p.qty, p.uom ?? "", p.occurrences].map(esc).join(","),
    );
  }
  return lines.join("\n");
}
