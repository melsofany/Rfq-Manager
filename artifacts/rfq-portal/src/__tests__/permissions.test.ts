import { describe, it, expect } from "vitest";
import {
  PERMISSION_CATALOG,
  ALL_PERMISSION_KEYS,
  PAGE_KEYS,
  ROLE_DEFAULTS,
  EDIT_PERM,
  PRICE_PERM,
  resolvePermissions,
  hasPermission,
  canEditCustomerDoc,
  canPriceCustomerRfq,
  canAssignItems,
  ASSIGN_PERM,
  EXPLICIT_ONLY_PERMS,
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

describe("item categories live under the items page", () => {
  it("registers items:categories as a tab of the items group", () => {
    const node = PERMISSION_CATALOG.find((n) => n.key === "items");
    expect(node?.children?.map((c) => c.key)).toContain("items:categories");
    expect(ALL_PERMISSION_KEYS).toContain("items:categories");
  });

  it("no longer exposes item-categories as a standalone page", () => {
    expect(PAGE_KEYS).not.toContain("item-categories");
    expect(PERMISSION_CATALOG.some((n) => n.href === "/item-categories")).toBe(false);
  });

  it("grants the categories tab to manager + purchasing by default, not data_entry", () => {
    expect(ROLE_DEFAULTS.manager).toContain("items:categories");
    expect(ROLE_DEFAULTS.purchasing).toContain("items:categories");
    expect(ROLE_DEFAULTS.data_entry).not.toContain("items:categories");
  });

  it("grants the whole items tab bar together so navigation is never a dead end", () => {
    for (const role of ["manager", "purchasing"] as const) {
      for (const tab of ["items:search", "items:sheet", "items:categories"]) {
        expect(ROLE_DEFAULTS[role]).toContain(tab);
      }
    }
  });
});

describe("item-assignment permission (rfq:assign)", () => {
  it("registers rfq:assign under the rfq group and is explicit-only", () => {
    const node = PERMISSION_CATALOG.find((n) => n.key === "rfq");
    expect(node?.children?.map((c) => c.key)).toContain(ASSIGN_PERM.itemAssign);
    expect(ALL_PERMISSION_KEYS).toContain(ASSIGN_PERM.itemAssign);
    // Ticking the «rfq» page must not hand out the assign action by accident.
    expect(EXPLICIT_ONLY_PERMS).toContain(ASSIGN_PERM.itemAssign);
  });

  it("grants assignment to manager + purchasing by default, not data_entry", () => {
    expect(ROLE_DEFAULTS.manager).toContain(ASSIGN_PERM.itemAssign);
    expect(ROLE_DEFAULTS.purchasing).toContain(ASSIGN_PERM.itemAssign);
    expect(ROLE_DEFAULTS.data_entry).not.toContain(ASSIGN_PERM.itemAssign);
  });

  it("canAssignItems: admin always, role default, explicit grant/revoke", () => {
    expect(canAssignItems("admin", null)).toBe(true);
    expect(canAssignItems("purchasing", null)).toBe(true);
    expect(canAssignItems("manager", null)).toBe(true);
    expect(canAssignItems("data_entry", null)).toBe(false);
    // Explicit grant.
    expect(canAssignItems("data_entry", { rfq: true, "rfq:assign": true })).toBe(true);
    // Explicit map omitting the key revokes even for a role that defaults on.
    expect(canAssignItems("purchasing", { rfq: true })).toBe(false);
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
