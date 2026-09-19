import { describe, it, expect } from "vitest";
import {
  PERMISSION_CATALOG,
  ALL_PERMISSION_KEYS,
  ROLE_DEFAULTS,
  EDIT_PERM,
  PRICE_PERM,
  resolvePermissions,
  hasPermission,
  canEditCustomerDoc,
  canPriceCustomerRfq,
  hasCustomPermissions,
} from "@/lib/permissions";

describe("customer edit permissions catalog", () => {
  it("registers customer-rfq:edit under the customer-rfq group", () => {
    const node = PERMISSION_CATALOG.find((n) => n.key === "customer-rfq");
    expect(node?.children?.map((c) => c.key)).toContain(EDIT_PERM.customerRfq);
    expect(ALL_PERMISSION_KEYS).toContain(EDIT_PERM.customerRfq);
  });

  it("registers customer-rfq:price under the customer-rfq group", () => {
    const node = PERMISSION_CATALOG.find((n) => n.key === "customer-rfq");
    expect(node?.children?.map((c) => c.key)).toContain(PRICE_PERM.customerRfq);
    expect(ALL_PERMISSION_KEYS).toContain(PRICE_PERM.customerRfq);
  });

  it("registers customer-po:edit under the customer-po group", () => {
    const node = PERMISSION_CATALOG.find((n) => n.key === "customer-po");
    expect(node?.children?.map((c) => c.key)).toContain(EDIT_PERM.customerPo);
    expect(ALL_PERMISSION_KEYS).toContain(EDIT_PERM.customerPo);
  });

  it("grants the edit keys to every non-admin role by default (no regression)", () => {
    for (const role of ["manager", "purchasing", "data_entry"] as const) {
      expect(ROLE_DEFAULTS[role]).toContain(EDIT_PERM.customerRfq);
      expect(ROLE_DEFAULTS[role]).toContain(EDIT_PERM.customerPo);
    }
  });

  it("grants pricing ONLY to manager by default (not lower roles)", () => {
    expect(ROLE_DEFAULTS.manager).toContain(PRICE_PERM.customerRfq);
    expect(ROLE_DEFAULTS.purchasing).not.toContain(PRICE_PERM.customerRfq);
    expect(ROLE_DEFAULTS.data_entry).not.toContain(PRICE_PERM.customerRfq);
  });
});

describe("canPriceCustomerRfq", () => {
  it("admin is always privileged", () => {
    expect(canPriceCustomerRfq("admin", null)).toBe(true);
    expect(canPriceCustomerRfq("admin", {})).toBe(true);
  });

  it("role-default manager can price; data_entry / purchasing cannot", () => {
    expect(canPriceCustomerRfq("manager", null)).toBe(true);
    expect(canPriceCustomerRfq("data_entry", null)).toBe(false);
    expect(canPriceCustomerRfq("purchasing", null)).toBe(false);
  });

  it("a data_entry granted the price key can price", () => {
    const map = { "customer-rfq": true, "customer-rfq:price": true };
    expect(canPriceCustomerRfq("data_entry", map)).toBe(true);
  });

  it("a role-default manager whose explicit map omits the key cannot price (revoked)", () => {
    const map = { "customer-rfq": true, "customer-rfq:edit": true };
    expect(canPriceCustomerRfq("manager", map)).toBe(false);
  });
});

describe("canEditCustomerDoc", () => {
  it("admin can always edit", () => {
    expect(canEditCustomerDoc("admin", null, EDIT_PERM.customerPo)).toBe(true);
    expect(canEditCustomerDoc("admin", {}, EDIT_PERM.customerRfq)).toBe(true);
  });

  it("role-default employees can edit (default-on)", () => {
    expect(canEditCustomerDoc("data_entry", null, EDIT_PERM.customerPo)).toBe(true);
    expect(canEditCustomerDoc("manager", null, EDIT_PERM.customerRfq)).toBe(true);
    expect(canEditCustomerDoc("purchasing", null, EDIT_PERM.customerPo)).toBe(true);
  });

  it("a custom map that revokes the edit key forbids editing", () => {
    // Only page access granted, edit key absent from an explicit map → NOT granted
    // (the include model: an explicit map must list the keys it grants).
    const map = { "customer-po": true, "customer-po:orders": true }; // no :edit
    expect(hasCustomPermissions(map)).toBe(true);
    expect(canEditCustomerDoc("data_entry", map, EDIT_PERM.customerPo)).toBe(false);
  });

  it("a custom map that grants the edit key allows editing", () => {
    const map = { "customer-po": true, "customer-po:edit": true };
    expect(canEditCustomerDoc("data_entry", map, EDIT_PERM.customerPo)).toBe(true);
  });

  it("resolvePermissions + hasPermission agree with canEdit for an explicit map", () => {
    const map = { "customer-rfq": true, "customer-rfq:edit": true };
    expect(hasPermission("manager", map, EDIT_PERM.customerRfq)).toBe(true);
    expect(resolvePermissions("manager", map).has(EDIT_PERM.customerRfq)).toBe(true);
  });
});
