import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { EGYPTIAN_BANKS, bankLogoUrl, bankInitials, findBankByName } from "@/lib/egyptian-banks";

const PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../public/bank-logos",
);

describe("EGYPTIAN_BANKS", () => {
  it("covers the major Egyptian banks", () => {
    const names = EGYPTIAN_BANKS.map((b) => b.name);
    expect(names).toContain("البنك الأهلي المصري");
    expect(names).toContain("بنك مصر");
    expect(names).toContain("البنك التجاري الدولي");
    expect(EGYPTIAN_BANKS.length).toBeGreaterThan(30);
  });

  it("has no duplicate names (a duplicate would render twice in the picker)", () => {
    const names = EGYPTIAN_BANKS.map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every bank an English name for search", () => {
    for (const b of EGYPTIAN_BANKS) expect(b.nameEn.trim().length).toBeGreaterThan(0);
  });

  // الحارس الأهم: لا يجوز أن يشير بنك إلى ملف شعار غير موجود — هذا هو سبب
  // «بنوك بدون لوجو» الذي أبلغ عنه المستخدم.
  it("every declared logo file exists on disk", () => {
    const missing: string[] = [];
    for (const b of EGYPTIAN_BANKS) {
      const url = bankLogoUrl(b);
      if (!url) continue;
      const file = path.join(PUBLIC_DIR, path.basename(url));
      if (!existsSync(file)) missing.push(`${b.name} -> ${url}`);
    }
    expect(missing).toEqual([]);
  });
});

describe("bankLogoUrl", () => {
  it("builds a LOCAL path from the bank's logo key (no external CDN)", () => {
    const nbe = EGYPTIAN_BANKS.find((b) => b.logo === "nbe")!;
    expect(bankLogoUrl(nbe)).toBe("/bank-logos/nbe.png");
  });

  it("uses the correct extension for non-png logos", () => {
    expect(bankLogoUrl(EGYPTIAN_BANKS.find((b) => b.logo === "qnb")!)).toBe("/bank-logos/qnb.svg");
    expect(bankLogoUrl(EGYPTIAN_BANKS.find((b) => b.logo === "banquemisr")!)).toBe(
      "/bank-logos/banquemisr.ico",
    );
    expect(bankLogoUrl(EGYPTIAN_BANKS.find((b) => b.logo === "creditagricole")!)).toBe(
      "/bank-logos/creditagricole.gif",
    );
  });

  it("returns null when the bank has no logo (falls back to initials)", () => {
    expect(bankLogoUrl(EGYPTIAN_BANKS.find((b) => b.nameEn === "Bank NXT")!)).toBeNull();
    expect(bankLogoUrl(null)).toBeNull();
    expect(bankLogoUrl(undefined)).toBeNull();
  });

  it("never returns an external URL", () => {
    for (const b of EGYPTIAN_BANKS) {
      const url = bankLogoUrl(b);
      if (url) expect(url.startsWith("/bank-logos/")).toBe(true);
    }
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
