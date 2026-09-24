/**
 * A description must never be cut mid-text.
 *
 * Reported live: «وصف البند والـ line item كانوا مش بيجو كاملين في التقرير،
 * مقصوص». Two independent causes, both reproduced from real EDC attachments:
 *
 *  1. `collectDescription` stopped at a wrapped `Part No` cell. The text layer
 *     pushes that cell onto its own line (`SFCTR3P30` / `A24VSA2L`) when it
 *     overflows; such a line has no 4-letter word, so it was read as the END of
 *     the description and all the prose after it was dropped.
 *  2. A low line cap (7) could end a long description early.
 *
 * Both fixtures below are verbatim extracts of real EDC purchase orders.
 */
import { describe, it, expect } from "vitest";

const { parseLineItems } = await import("../../modules/ai-assistant/email-items");

describe("a wrapped Part No cell does not end the description", () => {
  // Verbatim EDC PO P26E09609. Row 2's Part No cell (`SFCTR3P30A24VSA2L`)
  // overflowed onto the two lines after the row, and the prose continued after
  // them. The old collector returned only «, CONTACTOR ,3P».
  const PO_WRAPPED_PART_NO = `P26E09609
Page 1 of 1
PURCHASE ORDER
PO number: P26E09609
Line
No.
Quantity UOM Part No Line Item Delivery Date Unit Price Total (EGP)
1 2 Each 20-JUL-2026 6,300.00 12,600.00
1511.002.GENRAL.0412
FREON 407 G/ USE, ( REF. GRAINGER CAT.)
2 1 Each P/N : SFCTR3P30A24VSA2L , CONTACTOR ,3P 20-JUL-2026 575.00 575.00
SFCTR3P30
A24VSA2L
1854.022.TRANE.0217
,30A 24VAC / SCREWS,24V COIL FOR TRANE
SCR HVAC , ( OLD P/N : CTR02575 )
3 1 Piece 20-JUL-2026 1,844.50 1,844.50
0600.000.GENRAL.0005
VALUE ADDED TAX LOCAL
Total Price 20,744.50`;

  it("keeps the prose that follows the wrapped fragments", () => {
    const items = parseLineItems(PO_WRAPPED_PART_NO, "P26E09609");
    const row = items.find((i) => i.lineItemNo === "1854.022.TRANE.0217");
    expect(row).toBeDefined();
    const desc = row!.description;
    // The prose AFTER the block of wrapped fragments must survive.
    expect(desc).toContain("30A 24VAC");
    expect(desc).toContain("SCREWS,24V COIL FOR TRANE SCR HVAC");
    expect(desc).toContain("CTR02575");
    // The whole tail is present, not just its beginning.
    expect(desc.trim().endsWith(")")).toBe(true);
  });

  it("keeps a full long description (more than 7 continuation lines)", () => {
    // The old 7-line cap cut anything longer. 12 wrapped lines of prose.
    const longProse = Array.from({ length: 12 }, (_, i) => `WRAPPED SEGMENT NUMBER ${i} OF PROSE`);
    const text = [
      "P26E99999",
      "PURCHASE ORDER",
      "Quantity UOM Part No Line Item Delivery Date Unit Price Total (EGP)",
      "1 1 Each 01-JAN-2026 10.00 10.00",
      "1531.032.GENRAL.7538",
      ...longProse,
      "Total Price 10.00",
    ].join("\n");
    const items = parseLineItems(text, "P26E99999");
    const desc = items[0]?.description ?? "";
    expect(desc).toContain("WRAPPED SEGMENT NUMBER 0 OF PROSE");
    expect(desc).toContain("WRAPPED SEGMENT NUMBER 11 OF PROSE");
  });
});
