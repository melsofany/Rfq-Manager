/**
 * Line items read out of EDC email attachments.
 *
 * Live failure: the operator asked the WhatsApp assistant for the ITEMS and
 * quantities on EDC's RFQs/POs for the year, and for a file listing them. The
 * assistant could not: item data lives inside the attached PDF, and the only
 * document-reading path was Gemini `inline_data` — capped at 20 requests/day/
 * model, so it returned null and the request ended as «تعذّر معالجة طلبك».
 *
 * The fixtures below are the ACTUAL text pdf-parse produces for a real EDC RFQ
 * and PO (glyph positions rebuilt into rows), including the two layout quirks
 * that break a naive parser: the RFQ's Part No cell overflows across lines
 * (`5.70243E+` / `1854.027.`), and the PO restates every line on a page-2
 * «Purchase Order Distribution List».
 */
import { describe, it, expect } from "vitest";

const {
  parseLineItems,
  aggregateItems,
  aggregateItemsByOccurrence,
  itemKey,
  documentNumber,
  documentKind,
} = await import("../../modules/ai-assistant/email-items");

/** Verbatim text of a real EDC RFQ attachment (26R011954). */
const RFQ_TEXT = `Page 1 of 1
REQUEST FOR QUOTE
RFQ number: 26R011954
Date: 23-SEP-26
Response date: 26-SEP-26
Supplier Name: 12134 - CORTOBA FOR SUPPLIES - EMAN Place of delivery: CAIRO-BASE
Supplier Quote Ref. Quote Expire date Currency Lead Time Disc % Inco-terms
USD
PR Number: E02260636   -   RIG2-RCV
Machinery/ Make/ Main Reference/ Type / Comment : air condition /  /  /  / 0 -
Line Quantity UOM Part No Line Item Unit Price Comment:
No.
1 1 Each 5.70243E+ 1854.027. P/N : 5702428662864 , DANFOSS
12 GENRAL.0 RECIPROCATING COMPRESSOR , MODEL :
084 MT100HS4EVE , POWER SUPPLY [V/PH/HZ]
400/3/50 460/3/60, REFRIGERANT R22,
NOMINAL COOLING CAPACITY AT 60HZ 28.1
KW FOR CENTRAL ACCOMMODATION AIR
CONDITION
1
Note:
Phrases:
Send all correspondence to:
Buyer Name: Omar Mohamed Abdel Maaboud Mohamed`;

/** Verbatim text of a real EDC PO attachment (P26E14630), both pages. */
const PO_TEXT = `P26E14630
Page 1 of 2
PURCHASE ORDER
PO number: P26E14630(RIG58)
Issue Date: 23-SEP-2026
Supplier Name: 12134 - CORTOBA FOR SUPPLIES - EMAN Place of Delivery: CAIRO-BASE
Note to supplier:
Exchange Rate : .01924
Line
No.
Quantity UOM Part No Line Item Delivery Date Unit Price Total (EGP)
1 12 Piece 05-OCT-2026 75.00 900.00
0666.000.GENRAL.0006
2 INCH BRASS LONG SHACKLE PADLOCK WITH
3 KEYS-CHINA MADE-GOOD QUALITY
2 1 Piece 05-OCT-2026 126.00 126.00
0600.000.GENRAL.0005
VALUE ADDED TAX LOCAL
Total Price 1,026.00
Total Tax 0.00
Grand Total 1,026.00

P26E14630
Page 2 of 2
Purchase Order Distribution List
Line Quote
No. Ref.
PR Ref. Quantity UOM Part No Line Item Unit Price Total
2 1 Piece 06.00.000 0600.000.GENRAL.0005 126.00 126.00
VALUE ADDED TAX LOCAL
Supplier Quote No:
Sub Total : 126.00
Phrases:
ATTENTION!`;

describe("parseLineItems — EDC RFQ layout", () => {
  it("reads the item whose Part No cell overflowed, via the description P/N", () => {
    const items = parseLineItems(RFQ_TEXT);
    expect(items).toHaveLength(1);
    expect(items[0].lineNo).toBe(1);
    expect(items[0].qty).toBe(1);
    expect(items[0].uom).toBe("Each");
    // The part number is only recoverable from `P/N : 5702428662864`; the Part No
    // column itself contains the overflow junk `5.70243E+` / `1854.027.`.
    expect(items[0].partNo).toBe("5702428662864");
    expect(items[0].description).toContain("DANFOSS");
    expect(items[0].description).toContain("RECIPROCATING COMPRESSOR");
    // The wrapped part-number fragment must not leak into the description.
    expect(items[0].description).not.toContain("GENRAL");
    expect(items[0].description).not.toContain("5.70243E+");
  });

  it("does not read the header or the page furniture as items", () => {
    const items = parseLineItems(RFQ_TEXT);
    const described = items.map((i) => i.description).join(" ");
    expect(described).not.toContain("Quote Expire date");
    expect(described).not.toContain("Phrases");
    expect(described).not.toContain("Send all correspondence");
  });
});

describe("parseLineItems — the printed date/price tail", () => {
  it("keeps the date and money OUT of the description", () => {
    // The embedded columns are separate only visually; pdf.js appends them to the
    // prose, so the live description read
    // «TANK PRO RO WATER FILTER + UV - WALL 05-OCT-2026 5,100.00 10,200.00».
    // Those figures are the row's price columns (already parsed) and the delivery
    // date is its own column — not part of the item's name.
    const text = `PURCHASE ORDER
PO number: P26E14373(RIG58)
Line
No.
Quantity UOM Part No Line Item Delivery Date Unit Price Total (EGP)
1 2 Each 05-OCT-2026 5,100.00 10,200.00
1822.008.GENRAL.0069
TANK PRO RO WATER FILTER + UV - WALL 05-OCT-2026 5,100.00 10,200.00
Total Price 10,200.00`;
    const items = parseLineItems(text);
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe("TANK PRO RO WATER FILTER + UV - WALL");
    expect(items[0].description).not.toContain("05-OCT-2026");
    expect(items[0].description).not.toContain("5,100.00");
    // …while the money is still parsed as the row's price, not discarded.
    expect(items[0].unitPrice).toBe(5100);
    expect(items[0].lineTotal).toBe(10200);
  });
});

describe("parseLineItems — EDC PO layout", () => {
  it("reads the real line and drops the ERP's VAT pseudo-line", () => {
    const items = parseLineItems(PO_TEXT);
    // Exactly ONE: the page-2 «Purchase Order Distribution List» restates line 2,
    // and line 2 itself is not stock — the ERP prints «VALUE ADDED TAX LOCAL» as
    // a part-numbered row (0600.000.GENRAL.0005, qty 1) right before the totals.
    // Counting it put a tax row atop "most repeated" across 134 live orders.
    expect(items).toHaveLength(1);
    // The ERP's `Line Item` code is what the operator calls a Line Item; the
    // Part No column is EMPTY on this row, so `partNo` must stay null rather
    // than being filled with the Line Item code.
    expect(items.map((i) => i.lineItemNo)).toEqual(["0666.000.GENRAL.0006"]);
    expect(items[0].partNo).toBeNull();
    expect(items[0].qty).toBe(12);
    expect(items[0].description).toContain("PADLOCK");
    expect(items[0].description).toContain("KEYS-CHINA");
    expect(items.some((i) => i.lineItemNo === "0600.000.GENRAL.0005")).toBe(false);
  });

  it("does not read a page stamp as the description (the «Page 2 of 4» row)", () => {
    // The exact live shape: the extractor placed the document number and the
    // running footer BETWEEN the row's part number and its real description, so
    // the item surfaced as «P26E11255 Page 2 of 4» — a top-ranked row that says
    // nothing. The stamp must be skipped, not used as the description.
    const text = `PURCHASE ORDER
PO number: P26E11255(RIG58)
Line
No.
Quantity UOM Part No Line Item Delivery Date Unit Price Total (EGP)
1 25 Piece 05-OCT-2026 10.00 250.00
0600.000.GENRAL.0005
P26E11255
Page 2 of 4
BRASS LONG SHACKLE PADLOCK WITH 3 KEYS
Total Price 250.00`;
    const items = parseLineItems(text);
    expect(items).toHaveLength(1);
    expect(items[0].description).toContain("PADLOCK");
    expect(items[0].description).not.toContain("Page 2 of 4");
    expect(items[0].description).not.toContain("P26E11255");
  });

  it("does not double-count the restatement page", () => {
    const agg = aggregateItems(parseLineItems(PO_TEXT));
    const padlock = agg.find((a) => a.lineItemNos.includes("0666.000.GENRAL.0006"));
    expect(padlock?.occurrences).toBe(1);
    expect(padlock?.qty).toBe(12);
  });

  it("does not treat the totals rows as items", () => {
    const items = parseLineItems(PO_TEXT);
    expect(items.some((i) => /Grand Total|VALUE ADDED TAX/i.test(i.description))).toBe(false);
  });

  it("drops a described-less row that precedes the totals marker", () => {
    // The live top row: a real-looking part number with no prose, immediately
    // before «VALUE ADDED TAX LOCAL». It counted as an order for a tax line.
    const text = `Line
No.
Quantity UOM Part No Line Item Delivery Date Unit Price Total (EGP)
1 4 Each 05-OCT-2026 10.00 40.00
1111.111.GENRAL.0001
STEEL PIPE 2 INCH
2 1 Each 05-OCT-2026 6.00 6.00
0600.000.GENRAL.0005
VALUE ADDED TAX LOCAL
Total Price 46.00`;
    const items = parseLineItems(text);
    expect(items).toHaveLength(1);
    expect(items[0].lineItemNo).toBe("1111.111.GENRAL.0001");
  });
});

describe("parseLineItems — robustness", () => {
  it("returns nothing for prose that merely starts with a number", () => {
    const prose = `2 people attended the meeting.
1 2 Each of the boxes was damaged in transit.`;
    // No table header and no part number → not a table.
    expect(parseLineItems(prose)).toEqual([]);
  });

  it("does not invent an item when the table header exists but no rows do", () => {
    const headerOnly = `Line Quantity UOM Part No Line Item Unit Price
Total Price 0.00`;
    expect(parseLineItems(headerOnly)).toEqual([]);
  });

  it("returns nothing for empty input rather than throwing", () => {
    expect(parseLineItems("")).toEqual([]);
  });
});

describe("aggregateItems", () => {
  it("sums quantity and counts occurrences per part number", () => {
    const agg = aggregateItems([
      { lineNo: 1, partNo: "A.1", description: "x", qty: 2, uom: "Each" },
      { lineNo: 2, partNo: "A.1", description: "x", qty: 3, uom: "Each" },
      { lineNo: 3, partNo: "B.2", description: "y", qty: 1, uom: "Piece" },
    ]);
    expect(agg[0]).toMatchObject({ partNo: "A.1", qty: 5, occurrences: 2 });
    expect(agg[1]).toMatchObject({ partNo: "B.2", qty: 1, occurrences: 1 });
  });

  it("falls back to the description when a document has no part number", () => {
    const agg = aggregateItems([
      { lineNo: 1, partNo: null, description: "UNKNOWN PART", qty: 4, uom: "Each" },
      { lineNo: 2, partNo: null, description: "UNKNOWN PART", qty: 1, uom: "Each" },
    ]);
    expect(agg).toHaveLength(1);
    expect(agg[0].qty).toBe(5);
  });

  it("does not let a 3-character description fragment top the list", () => {
    // Observed on live EDC mail: the id-less description cell held just «RCV»
    // (a location tag) on 33 lines, out-ranking every real part. An
    // implausibly short description is page furniture, not an item.
    const agg = aggregateItems([
      ...Array.from({ length: 9 }, (_, i) => ({
        lineNo: i + 1,
        partNo: null,
        description: "RCV",
        qty: 1,
        uom: "Each",
      })),
      { lineNo: 10, partNo: null, description: "REAL PART NAME", qty: 2, uom: "Each" },
    ]);
    expect(agg).toHaveLength(1);
    expect(agg[0].description).toBe("REAL PART NAME");
  });

  it("carries the printed Line Item numbers without using them for identity", () => {
    // The operator asked for the Line Item column by name. Reporting «غير متوفر»
    // for a value the documents DO print is a false absence — but the number
    // differs PO by PO, so it must never drive the grouping. The same part on
    // line 1 of one order and line 2 of the next is ONE item, with both numbers.
    const agg = aggregateItems([
      { lineNo: 1, partNo: "A.1", description: "x", qty: 2, uom: "Each", docId: "PO-1" },
      { lineNo: 2, partNo: "A.1", description: "x", qty: 3, uom: "Each", docId: "PO-2" },
    ]);
    expect(agg).toHaveLength(1);
    expect(agg[0].lineItems).toEqual([1, 2]);
    expect(agg[0].occurrences).toBe(2);
  });

  it("reports an empty Line Item list when the document prints none", () => {
    const agg = aggregateItems([
      { lineNo: null, partNo: "A.1", description: "x", qty: 1, uom: "Each" },
    ]);
    expect(agg[0].lineItems).toEqual([]);
  });
});

describe("itemKey", () => {
  it("prefers the part number and case-folds it", () => {
    expect(itemKey({ lineNo: 1, partNo: "abc-1", description: "", qty: 1, uom: null })).toBe(
      "ABC-1",
    );
  });

  it("uses the description when there is no part number", () => {
    expect(itemKey({ lineNo: 1, partNo: null, description: "Real Part", qty: 1, uom: null })).toBe(
      "REAL PART",
    );
  });

  it("drops an implausibly short description and an empty line", () => {
    expect(itemKey({ lineNo: 1, partNo: null, description: "RCV", qty: 1, uom: null })).toBe("");
    expect(itemKey({ lineNo: 1, partNo: null, description: "", qty: 1, uom: null })).toBe("");
    expect(itemKey({ lineNo: 1, partNo: "  ", description: "", qty: 1, uom: null })).toBe("");
  });

  it("does not merge genuinely different parts that differ only by number", () => {
    // Only the partNo wins the key; descriptions are never number-stripped.
    const a = itemKey({ lineNo: 1, partNo: null, description: "CABLE 50 MM", qty: 1, uom: null });
    const b = itemKey({ lineNo: 2, partNo: null, description: "CABLE 70 MM", qty: 1, uom: null });
    expect(a).not.toBe(b);
  });
});

describe("aggregateItemsByOccurrence", () => {
  it("leads with the most repeated part, not the largest quantity", () => {
    const items = [
      // small part ordered on three separate documents
      { lineNo: 1, partNo: "SMALL", description: "s", qty: 1, uom: "Each" },
      { lineNo: 2, partNo: "SMALL", description: "s", qty: 1, uom: "Each" },
      { lineNo: 3, partNo: "SMALL", description: "s", qty: 1, uom: "Each" },
      // one huge one-off order
      { lineNo: 4, partNo: "BIG", description: "b", qty: 5000, uom: "Each" },
    ];
    const byOcc = aggregateItemsByOccurrence(items);
    expect(byOcc[0].partNo).toBe("SMALL");
    expect(byOcc[0].occurrences).toBe(3);
    // The quantity view still leads with the big one — different question.
    expect(aggregateItems(items)[0].partNo).toBe("BIG");
  });

  it("excludes a part seen on a single order, however large its quantity", () => {
    // The operator's rule, stated verbatim: a part that appeared once with a
    // huge quantity is excluded from a "most repeated" list.
    const items = [
      { lineNo: 1, partNo: "REPEAT", description: "r", qty: 5, uom: "Each", docId: "P1" },
      { lineNo: 2, partNo: "REPEAT", description: "r", qty: 5, uom: "Each", docId: "P2" },
      { lineNo: 3, partNo: "HUGEONCE", description: "h", qty: 7000, uom: "Each", docId: "P3" },
    ];
    const byOcc = aggregateItemsByOccurrence(items, 2);
    expect(byOcc.map((p) => p.partNo)).toEqual(["REPEAT"]);
    // minOrders=1 is the escape hatch that brings it back.
    expect(aggregateItemsByOccurrence(items, 1).map((p) => p.partNo)).toContain("HUGEONCE");
  });
});

describe("occurrences count ORDERS, not printed lines", () => {
  it("counts one PO once even when it prints the part on several lines", () => {
    // A single PO can list the same part on multiple lines. Counting lines would
    // let one noisy document top the frequency ranking.
    const items = [
      { lineNo: 1, partNo: "A.1", description: "x", qty: 1, uom: "Each", docId: "P26E001" },
      { lineNo: 2, partNo: "A.1", description: "x", qty: 1, uom: "Each", docId: "P26E001" },
      { lineNo: 3, partNo: "A.1", description: "x", qty: 1, uom: "Each", docId: "P26E001" },
      { lineNo: 4, partNo: "A.1", description: "x", qty: 1, uom: "Each", docId: "P26E002" },
    ];
    const agg = aggregateItems(items);
    expect(agg[0].occurrences).toBe(2);
    expect(agg[0].qty).toBe(4);
    expect(agg[0].documents).toEqual(["P26E001", "P26E002"]);
  });

  it("reads the document number printed in the attachment", () => {
    expect(documentNumber(PO_TEXT)).toBe("P26E14630");
    expect(documentNumber(RFQ_TEXT)).toBe("26R011954");
    expect(documentNumber("no number here")).toBeNull();
  });

  it("recovers a description whose Part No cell overflowed onto its first line", () => {
    // Live EDC PO P26E13704: the generator pushes the Part No cell onto the NEXT
    // visual line, glued ahead of the description —
    //   `3RV20214AA P/N : 3RV20214AA10 , CIRCUIT BREAKER, 460V,`
    // The line then OPENS with a digit, so it was taken for a new table row and
    // the item was reported with an EMPTY description — the very field the
    // operator audits by. The overflow fragment is dropped when the remainder
    // still carries a `P/N :` whose value it prefixes.
    const text = `PURCHASE ORDER
PO number: P26E13704
Line
No.
Quantity UOM Part No Line Item Delivery Date Unit Price Total (EGP)
1 25 Each 27-SEP-2026 2,650.00 66,250.00
3RV20214AA P/N : 3RV20214AA10 , CIRCUIT BREAKER, 460V,
10 10HP, SIEMENS  OLD PN. 3RV1021-4AA10 ( REF
2211.003.GENRAL.0110
CODE 1001.001.USED.0360 ) FOR ELECTRICAL
GENERAL USE
Total Price 223,725.00`;
    const items = parseLineItems(text, "P26E13704");
    expect(items).toHaveLength(1);
    const it0 = items[0];
    expect(it0.lineItemNo).toBe("2211.003.GENRAL.0110");
    // The whole description, including the wrapped lines that OPEN with digits
    // («10 10HP, SIEMENS …», «CODE 1001.001.USED.0360 ) FOR ELECTRICAL»).
    expect(it0.description).toContain("CIRCUIT BREAKER, 460V,");
    expect(it0.description).toContain("10HP, SIEMENS");
    expect(it0.description).toContain("OLD PN. 3RV1021-4AA10");
    expect(it0.description).toContain("FOR ELECTRICAL GENERAL USE");
    // The overflow fragment is not left in the description as prose.
    expect(it0.description.startsWith("3RV20214AA")).toBe(false);
    // The Line Item code is a column, not description prose.
    expect(it0.description).not.toContain("2211.003.GENRAL.0110");
    expect(it0.unitPrice).toBe(2650);
    expect(it0.lineTotal).toBe(66250);
  });

  it("leaves a description that merely begins with a code-shaped word intact", () => {
    // The overflow fix must not eat the first word of ordinary prose: with no
    // `P/N :` to corroborate it, a leading token is part of the description.
    const text = `PURCHASE ORDER
PO number: P26E13705
Line
No.
Quantity UOM Part No Line Item Delivery Date Unit Price Total (EGP)
1 2 Each 27-SEP-2026 10.00 20.00
A9R41440 CONTACTOR 220V SIEMENS
2201.003.GENRAL.0110
Total Price 20.00`;
    const items = parseLineItems(text, "P26E13705");
    expect(items).toHaveLength(1);
    expect(items[0].description).toContain("A9R41440");
    expect(items[0].description).toContain("CONTACTOR 220V SIEMENS");
  });

  it("classifies a document from its SUBJECT when the text layer lost the title", () => {
    // An EDC scanned copy whose text layer dropped the heading has no
    // `PURCHASE ORDER` and no `PO number:` marker, but the mail is titled
    // «EDC PO No P26E14708». Without the subject it counts as an unidentified
    // document and inflates the PO census; with it, the RFQ/PO split stays true.
    const noTitle = "Quantity UOM Part No Line Item\n1 5 Each SOME PART\n";
    expect(documentKind(noTitle, "EDC PO No P26E14708")).toBe("po");
    expect(documentKind(noTitle, "EDC RFQ No 26R011900")).toBe("rfq");
    // No signal anywhere: still honestly unknown.
    expect(documentKind(noTitle, "EDC mail")).toBe("unknown");
    // The title in the TEXT still wins, so a subject typo cannot misclassify.
    expect(documentKind(PO_TEXT, "EDC RFQ No 26R011900")).toBe("po");
  });
});

describe("prices come from the PO rows", () => {
  it("extracts unit price and line total, and aggregates them", () => {
    const items = parseLineItems(PO_TEXT, "P26E14630");
    const padlock = items.find((i) => i.lineItemNo === "0666.000.GENRAL.0006");
    expect(padlock?.unitPrice).toBe(75);
    expect(padlock?.lineTotal).toBe(900);
    expect(padlock?.docId).toBe("P26E14630");

    const agg = aggregateItems(items);
    const a = agg.find((p) => p.lineItemNos.includes("0666.000.GENRAL.0006"));
    expect(a?.avgUnitPrice).toBe(75);
    expect(a?.totalValue).toBe(900);
  });

  it("reports no price rather than inventing one when the row prints none", () => {
    const rfqItems = parseLineItems(RFQ_TEXT, "26R011954");
    const agg = aggregateItems(rfqItems);
    expect(agg.every((p) => p.avgUnitPrice === null && p.totalValue === null)).toBe(true);
  });

  it("keeps the longest description seen for a part", () => {
    const agg = aggregateItems([
      { lineNo: 1, partNo: "A.1", description: "SHORT", qty: 1, uom: "Each", docId: "P1" },
      {
        lineNo: 2,
        partNo: "A.1",
        description: "SHORT WITH THE FULL DESCRIPTION TEXT",
        qty: 1,
        uom: "Each",
        docId: "P2",
      },
    ]);
    expect(agg[0].description).toBe("SHORT WITH THE FULL DESCRIPTION TEXT");
  });
});
