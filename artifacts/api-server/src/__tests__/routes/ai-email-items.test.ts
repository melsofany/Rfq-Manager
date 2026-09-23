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

const { parseLineItems, aggregateItems, aggregateItemsByOccurrence, itemKey, documentNumber } =
  await import("../../modules/ai-assistant/email-items");

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

describe("parseLineItems — EDC PO layout", () => {
  it("reads both lines, with the description from the following lines", () => {
    const items = parseLineItems(PO_TEXT);
    // Exactly two — the page-2 «Purchase Order Distribution List» restates line 2
    // and must not be counted again.
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.partNo)).toEqual(["0666.000.GENRAL.0006", "0600.000.GENRAL.0005"]);
    expect(items[0].qty).toBe(12);
    expect(items[1].qty).toBe(1);
    expect(items[0].description).toContain("PADLOCK");
    expect(items[0].description).toContain("KEYS-CHINA");
  });

  it("does not double-count the restatement page", () => {
    const agg = aggregateItems(parseLineItems(PO_TEXT));
    const padlock = agg.find((a) => a.partNo === "0666.000.GENRAL.0006");
    expect(padlock?.occurrences).toBe(1);
    expect(padlock?.qty).toBe(12);
  });

  it("does not treat the totals rows as items", () => {
    const items = parseLineItems(PO_TEXT);
    expect(items.some((i) => /Grand Total|VALUE ADDED TAX/i.test(i.description))).toBe(false);
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
});

describe("prices come from the PO rows", () => {
  it("extracts unit price and line total, and aggregates them", () => {
    const items = parseLineItems(PO_TEXT, "P26E14630");
    const padlock = items.find((i) => i.partNo === "0666.000.GENRAL.0006");
    expect(padlock?.unitPrice).toBe(75);
    expect(padlock?.lineTotal).toBe(900);
    expect(padlock?.docId).toBe("P26E14630");

    const agg = aggregateItems(items);
    const a = agg.find((p) => p.partNo === "0666.000.GENRAL.0006");
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
