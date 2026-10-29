/**
 * The bridge's tax arithmetic is the money-critical part of the mapping, so it
 * is pinned here independently of Odoo: 14% VAT (Law 67/2016) and 3% withholding
 * (خصم تحت حساب المورد), on both VAT-exclusive and VAT-inclusive supplier costs.
 *
 * These tests fail if either rate, the net/gross convention, or the
 * "net + vat reproduces the original amount" invariant drifts.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_TAX_RATES,
  DEFAULT_VAT_RATE,
  DEFAULT_WITHHOLDING_RATE,
  ratesFrom,
  rateOf,
  round2,
  vatComponents,
  withholdingOn,
  vendorBillTotals,
} from "../../modules/accounts-bridge/tax";

describe("statutory rates", () => {
  it("defaults to the Egyptian 14% VAT and 3% withholding", () => {
    expect(DEFAULT_VAT_RATE).toBe(14);
    expect(DEFAULT_WITHHOLDING_RATE).toBe(3);
    expect(DEFAULT_TAX_RATES).toEqual({ vatRate: 14, withholdingRate: 3 });
  });

  it("reads the rates from a tax_settings row, falling back on garbage", () => {
    expect(ratesFrom({ vatRate: "14", withholdingRate: "3" })).toEqual({
      vatRate: 14,
      withholdingRate: 3,
    });
    expect(ratesFrom(null)).toEqual({ vatRate: 14, withholdingRate: 3 });
    expect(ratesFrom({ vatRate: "not-a-number", withholdingRate: -5 })).toEqual({
      vatRate: 14,
      withholdingRate: 3,
    });
  });

  it("rateOf rejects negative, empty and non-finite values", () => {
    expect(rateOf("14", 3)).toBe(14);
    // Empty / missing must take the fallback, NOT 0 — a blank rate field would
    // otherwise silently mean "no VAT".
    expect(rateOf("", 3)).toBe(3);
    expect(rateOf("-1", 3)).toBe(3);
    expect(rateOf(Infinity, 3)).toBe(3);
    expect(rateOf(null, 3)).toBe(3);
  });
});

describe("vatComponents", () => {
  it("applies 14% on a VAT-exclusive base", () => {
    expect(vatComponents(1000, 14, false)).toEqual({ net: 1000, vat: 140, gross: 1140 });
  });

  it("strips 14% out of a VAT-inclusive amount", () => {
    // 1140 inclusive → net 1000, vat 140.
    expect(vatComponents(1140, 14, true)).toEqual({ net: 1000, vat: 140, gross: 1140 });
  });

  it("net + vat always reproduces the original amount (no lost cent)", () => {
    for (const amount of [1, 9.99, 123.45, 1000, 7777.77, 123456.78]) {
      const { net, vat, gross } = vatComponents(amount, 14, true);
      expect(round2(net + vat)).toBe(round2(amount));
      expect(gross).toBe(round2(amount));
    }
  });

  it("treats a zero rate as no VAT", () => {
    expect(vatComponents(500, 0, false)).toEqual({ net: 500, vat: 0, gross: 500 });
    expect(vatComponents(500, 0, true)).toEqual({ net: 500, vat: 0, gross: 500 });
  });
});

describe("withholdingOn", () => {
  it("withholds 3% of the net supply value", () => {
    expect(withholdingOn(1000, 3)).toBe(30);
    expect(withholdingOn(333.33, 3)).toBe(10);
  });

  it("withholds nothing at a zero rate", () => {
    expect(withholdingOn(1000, 0)).toBe(0);
  });
});

describe("vendorBillTotals — net + 14% VAT − 3% withholding", () => {
  it("computes the payable to the supplier on a VAT-exclusive cost", () => {
    // net 1000, vat 140, gross 1140, wh 30, payable 1110.
    expect(vendorBillTotals(1000, DEFAULT_TAX_RATES, false)).toEqual({
      net: 1000,
      vat: 140,
      gross: 1140,
      withholding: 30,
      payableToSupplier: 1110,
    });
  });

  it("computes the payable on a VAT-inclusive cost", () => {
    // gross 1140 → net 1000, vat 140, wh 30, payable 1110.
    expect(vendorBillTotals(1140, DEFAULT_TAX_RATES, true)).toEqual({
      net: 1000,
      vat: 140,
      gross: 1140,
      withholding: 30,
      payableToSupplier: 1110,
    });
  });

  it("withholding is taken on the NET, never on the VAT-inclusive amount", () => {
    const t = vendorBillTotals(1140, DEFAULT_TAX_RATES, true);
    // 3% of 1140 would be 34.2 — that would be the bug.
    expect(t.withholding).toBe(30);
    expect(t.withholding).not.toBe(round2(1140 * 0.03));
  });
});
