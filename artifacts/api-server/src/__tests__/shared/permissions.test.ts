import { describe, it, expect } from "vitest";
import { accessFor, allowsAny, ROUTE_GUARDS } from "../../shared/permissions";

describe("API page permissions", () => {
  it("admin passes everything", () => {
    expect(allowsAny(accessFor("admin", null), ["backup"])).toBe(true);
  });

  it("purchasing has suppliers but not backup by default", () => {
    const a = accessFor("purchasing", null);
    expect(allowsAny(a, ["suppliers"])).toBe(true);
    expect(allowsAny(a, ["backup"])).toBe(false);
  });

  it("data entry has customers and mailbox only", () => {
    const a = accessFor("data_entry", null);
    expect(allowsAny(a, ["customers"])).toBe(true);
    expect(allowsAny(a, ["suppliers"])).toBe(false);
  });

  it("explicit map wins over role default", () => {
    const a = accessFor("manager", { suppliers: true });
    expect(allowsAny(a, ["suppliers"])).toBe(true);
    expect(allowsAny(a, ["accounts"])).toBe(false);
  });

  it("any-of matches a sub-key", () => {
    const a = accessFor("data_entry", { "accounts:expenses": true });
    expect(allowsAny(a, ["accounts", "accounts:expenses"])).toBe(true);
  });

  it("a supplier-only viewer may READ the item-category catalogue", () => {
    // The /suppliers screen renders the «يورّد بنود» filter from
    // GET /item-categories. Without `suppliers` in that route's read list the
    // catalogue 403s for a supplier viewer and the filter silently vanishes —
    // a capability the screen shows but the API refuses.
    const guard = ROUTE_GUARDS["/item-categories"];
    const a = accessFor("viewer", { suppliers: true });
    expect(allowsAny(a, guard.read)).toBe(true);
    // …while the WRITE side stays restricted to items:edit.
    expect(allowsAny(a, guard.write)).toBe(false);
  });
});
