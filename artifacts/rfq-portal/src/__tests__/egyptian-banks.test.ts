import { describe, it, expect } from "vitest";
import { EGYPTIAN_BANKS, bankLogoUrl, bankInitials, findBankByName } from "@/lib/egyptian-banks";

describe("EGYPTIAN_BANKS", () => {
  it("covers the major Egyptian banks", () => {
    const names = EGYPTIAN_BANKS.map((b) => b.name);
    expect(names).toContain("البنك الأهلي المصري");
    expect(names).toContain("بنك مصر");
    expect(names).toContain("البنك التجاري الدولي");
    expect(EGYPTIAN_BANKS.length).toBeGreaterThan(25);
  });

  it("has no duplicate names (a duplicate would render twice in the picker)", () => {
    const names = EGYPTIAN_BANKS.map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every bank an English name for search", () => {
    for (const b of EGYPTIAN_BANKS) expect(b.nameEn.trim().length).toBeGreaterThan(0);
  });
});

describe("bankLogoUrl", () => {
  it("builds a favicon URL from the domain", () => {
    expect(bankLogoUrl("nbe.com.eg")).toBe(
      "https://www.google.com/s2/favicons?domain=nbe.com.eg&sz=128",
    );
  });

  it("returns null when there is no domain (falls back to initials)", () => {
    expect(bankLogoUrl(undefined)).toBeNull();
  });
});

describe("findBankByName", () => {
  it("matches an exact Arabic name", () => {
    expect(findBankByName("بنك مصر")?.nameEn).toBe("Banque Misr");
  });

  it("matches a partial name so a hand-typed value still gets a logo", () => {
    expect(findBankByName("الأهلي")?.name).toBe("البنك الأهلي المصري");
  });

  it("matches the English name", () => {
    expect(findBankByName("Commercial International")?.name).toBe("البنك التجاري الدولي");
  });

  it("returns null for an unknown bank rather than guessing", () => {
    expect(findBankByName("بنك غير موجود")).toBeNull();
    expect(findBankByName("")).toBeNull();
    expect(findBankByName(null)).toBeNull();
  });
});

describe("bankInitials", () => {
  it("uses the first two words, skipping the definite article", () => {
    expect(bankInitials("البنك الأهلي المصري")).toBe("با");
  });

  it("falls back to two chars of a single word", () => {
    expect(bankInitials("مصر")).toBe("مص");
  });
});
