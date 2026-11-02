import { describe, expect, it } from "vitest";
import { canAccessPath, resolvePermissions } from "../lib/permissions";

describe("email pages in the permission catalog", () => {
  it("mailbox is open to every non-admin role by default", () => {
    for (const role of ["manager", "purchasing", "data_entry"]) {
      expect(canAccessPath(role, {}, "/mailbox")).toBe(true);
    }
  });

  it("email settings is admin-only by default", () => {
    for (const role of ["manager", "purchasing", "data_entry"]) {
      expect(canAccessPath(role, {}, "/email-settings")).toBe(false);
    }
    expect(canAccessPath("admin", {}, "/email-settings")).toBe(true);
  });

  it("email settings can be granted explicitly to one employee", () => {
    expect(canAccessPath("data_entry", { "email-settings": true }, "/email-settings")).toBe(true);
    expect(resolvePermissions("data_entry", { "email-settings": true }).has("email-settings")).toBe(true);
  });

  it("an explicit map without mailbox hides the mailbox page", () => {
    expect(canAccessPath("manager", { dashboard: true }, "/mailbox")).toBe(false);
  });
});
