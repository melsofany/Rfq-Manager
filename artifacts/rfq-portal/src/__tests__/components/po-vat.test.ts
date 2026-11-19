import { describe, expect, it } from "vitest";
import { addVat, applyManualPrice, applyTaxToggle, needsVatConfirm } from "@/modules/po/vat";

describe("PO VAT handling", () => {
  it("adds 14% to a VAT-exclusive quote when the line is marked tax-inclusive", () => {
    const line = {
      unitPrice: "100",
      taxIncluded: false,
      quotedPrice: "100",
      quotedTaxIncluded: false,
    };
    const next = applyTaxToggle(line, true);
    expect(next.taxIncluded).toBe(true);
    expect(next.unitPrice).toBe("114.00");
  });

  it("restores the quoted price when the tax box is unticked again", () => {
    const line = {
      unitPrice: "114.00",
      taxIncluded: true,
      quotedPrice: "100",
      quotedTaxIncluded: false,
    };
    const next = applyTaxToggle(line, false);
    expect(next.taxIncluded).toBe(false);
    expect(next.unitPrice).toBe("100");
  });

  it("leaves a VAT-inclusive quote unchanged", () => {
    const line = {
      unitPrice: "114",
      taxIncluded: true,
      quotedPrice: "114",
      quotedTaxIncluded: true,
    };
    const next = applyTaxToggle({ ...line, taxIncluded: false }, true);
    expect(next.unitPrice).toBe("114");
  });

  it("only changes the checkbox when there is no quoted price", () => {
    const line = { unitPrice: "", taxIncluded: false, quotedPrice: null, quotedTaxIncluded: false };
    const next = applyTaxToggle(line, true);
    expect(next.taxIncluded).toBe(true);
    expect(next.unitPrice).toBe("");
  });

  it("rounds to two decimals", () => {
    expect(addVat("33.33")).toBe("38.00");
  });

  it("asks for confirmation when a typed price on an adjusted tax-marked line differs", () => {
    const line = {
      unitPrice: "114.00",
      taxIncluded: true,
      quotedPrice: "100",
      quotedTaxIncluded: false,
    };
    expect(needsVatConfirm(line, "120")).toBe(true);
    expect(needsVatConfirm(line, "114.00")).toBe(false);
  });

  it("does not ask when the tax box is off or the quote already included tax", () => {
    expect(
      needsVatConfirm(
        { unitPrice: "100", taxIncluded: false, quotedPrice: "100", quotedTaxIncluded: false },
        "120",
      ),
    ).toBe(false);
    expect(
      needsVatConfirm(
        { unitPrice: "114", taxIncluded: true, quotedPrice: "114", quotedTaxIncluded: true },
        "120",
      ),
    ).toBe(false);
  });

  it("'yes' treats the typed price as VAT-exclusive and adds 14%", () => {
    const line = {
      unitPrice: "114.00",
      taxIncluded: true,
      quotedPrice: "100",
      quotedTaxIncluded: false,
    };
    const next = applyManualPrice(line, "120", true);
    expect(next.unitPrice).toBe("136.80");
    expect(next.quotedPrice).toBe("120");
    expect(needsVatConfirm(next, "136.80")).toBe(false);
  });

  it("'no' keeps the typed price as VAT-inclusive and stops further automatic VAT", () => {
    const line = {
      unitPrice: "114.00",
      taxIncluded: true,
      quotedPrice: "100",
      quotedTaxIncluded: false,
    };
    const next = applyManualPrice(line, "120", false);
    expect(next.unitPrice).toBe("120");
    expect(next.quotedTaxIncluded).toBe(true);
    // Unticking afterwards must not reset the price back to an old quote.
    expect(applyTaxToggle(next, false).unitPrice).toBe("120");
  });
});
