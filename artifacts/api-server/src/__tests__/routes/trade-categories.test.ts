import { describe, it, expect } from "vitest";
import { isTradeCategory, tradeNameSet } from "../../modules/rfq/trade-categories";

// The rule that keeps «تصنيفات البنود» from showing more or fewer categories than
// the supplier page. It is pure, so it is tested directly rather than only
// through a route whose DB mock cannot see a SQL filter.
describe("trade-category rule (تصنيف مورد)", () => {
  const names = tradeNameSet([{ name: "كهرباء" }, { name: "أجهزة" }]);

  it("accepts a live functional category the supplier page also lists", () => {
    expect(
      isTradeCategory({ id: 3, name: "كهرباء", kind: "functional", isActive: true }, names),
    ).toBe(true);
  });

  it("rejects a subcategory even when its name is a supplier category", () => {
    // قواطع/PLC/كابلات are refinements INSIDE a domain: they never own work and
    // are not a category a supplier registers under.
    expect(
      isTradeCategory({ id: 4, name: "كهرباء", kind: "subcategory", isActive: true }, names),
    ).toBe(false);
  });

  it("rejects a brand", () => {
    expect(isTradeCategory({ id: 40, name: "شنايدر", kind: "brand", isActive: true }, names)).toBe(
      false,
    );
  });

  it("rejects a category absent from the supplier list", () => {
    // The drift the operator reported: an item category with no counterpart on
    // /suppliers must never be offered as a trade category.
    expect(
      isTradeCategory({ id: 9, name: "تصنيف مجهول", kind: "functional", isActive: true }, names),
    ).toBe(false);
  });

  it("rejects a deactivated category", () => {
    expect(
      isTradeCategory({ id: 38, name: "كهرباء", kind: "functional", isActive: false }, names),
    ).toBe(false);
  });

  it("treats a NULL kind as functional (the column is nullable)", () => {
    expect(isTradeCategory({ id: 3, name: "كهرباء", kind: null, isActive: true }, names)).toBe(
      true,
    );
  });

  it("folds Arabic spelling differences when matching names", () => {
    // «إضاءة» and «اضاءه» are the same word; a raw comparison would report a
    // phantom category the supplier page does not have.
    const set = tradeNameSet([{ name: "إضاءة" }]);
    expect(
      isTradeCategory({ id: 871, name: "اضاءه", kind: "functional", isActive: true }, set),
    ).toBe(true);
  });
});
