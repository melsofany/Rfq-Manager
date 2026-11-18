import { describe, expect, it } from "vitest";
import { addVat, applyTaxToggle } from "@/modules/po/vat";

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
});
