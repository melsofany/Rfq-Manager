import { describe, it, expect } from "vitest";
import { customerItemIdentityKey, customerScopeOf } from "../../modules/rfq/item-identity";

describe("customer-scoped item identity — the customer's line item is the key", () => {
  const scope = customerScopeOf({ customerId: 7, customerName: "Acme" });

  it("the same line item from the same customer is the SAME identity", () => {
    const a = customerItemIdentityKey(scope, {
      lineItem: "5730.021.GENRAL.0702",
      description: "X",
    });
    const b = customerItemIdentityKey(scope, {
      lineItem: "5730.021.GENRAL.0702",
      description: "Y",
    });
    expect(a).toBe(b);
  });

  it("the same line item from two DIFFERENT customers never shares a decision", () => {
    const other = customerScopeOf({ customerId: 8, customerName: "Beta" });
    expect(customerItemIdentityKey(scope, { lineItem: "1854.027.X.0001" })).not.toBe(
      customerItemIdentityKey(other, { lineItem: "1854.027.X.0001" }),
    );
  });

  it("falls back to part number / text when there is no line item, still customer-scoped", () => {
    const k = customerItemIdentityKey(scope, { partNo: "440F", description: "solder rod" });
    expect(k).not.toBeNull();
    expect(k!.startsWith(`cust:${scope}|`)).toBe(true);
  });

  it("scope falls back to the customer name when there is no customer row", () => {
    expect(customerScopeOf({ customerId: null, customerName: "Walk In" })).toBe("name:walkin");
  });
});
