import { describe, it, expect } from "vitest";
import { accessFor, allowsAny } from "../../shared/permissions";

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
});
