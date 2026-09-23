/**
 * Part / brand alias resolution (P5).
 *
 * The operator asks in Arabic for a brand that the document prints in its own
 * (often misspelled) Latin form — the recorded failure was «السخانات الأريستون»
 * not matching a part coded `...ARSTON...`. These tests pin the expansion and,
 * just as importantly, that a non-brand query is NOT broadened: an over-eager
 * alias would attribute one brand's part to another, which is worse for a
 * purchasing decision than an honest miss.
 */
import { describe, it, expect } from "vitest";
import {
  canonicalBrand,
  brandVariants,
  expandQueryTokens,
  matchesPartQuery,
  matchesWithAliases,
} from "../../modules/ai-assistant/part-aliases";

describe("canonicalBrand", () => {
  it("folds the printed misspelling onto the real brand", () => {
    expect(canonicalBrand("arston")).toBe("ariston");
    expect(canonicalBrand("genral")).toBe("general");
  });

  it("folds the Arabic name, with and without the definite article", () => {
    expect(canonicalBrand("أريستون")).toBe("ariston");
    expect(canonicalBrand("الأريستون")).toBe("ariston");
  });

  it("returns null for a word that is not a known brand", () => {
    expect(canonicalBrand("صمام")).toBeNull();
    expect(canonicalBrand("")).toBeNull();
  });
});

describe("brandVariants", () => {
  it("returns every spelling for a brand", () => {
    const v = brandVariants("أريستون");
    expect(v).toContain("ariston");
    expect(v).toContain("arston");
  });

  it("returns nothing for a non-brand word", () => {
    expect(brandVariants("صمام")).toEqual([]);
  });
});

describe("matchesWithAliases", () => {
  it("finds the Arabic brand inside an English part number", () => {
    // The exact recorded failure: the part exists, the query was Arabic.
    expect(matchesWithAliases("0600.000.ARSTON.0004", "الأريستون")).toBe(true);
  });

  it("matches an ordinary query exactly as before", () => {
    expect(matchesWithAliases("صمام نحاس 50 مم", "صمام")).toBe(true);
    expect(matchesWithAliases("صمام نحاس 50 مم", "مضخة")).toBe(false);
  });

  it("still requires EVERY token (an alias must not broaden an AND)", () => {
    // «ariston» matches but «filter» does not, so the pair must fail.
    expect(matchesWithAliases("0600.000.ARSTON.0004 سخان", "أريستون فلتر")).toBe(false);
  });

  it("matches a multi-token query when all tokens are present", () => {
    expect(matchesWithAliases("سخان ARSTON 50 لتر", "أريستون 50")).toBe(true);
  });

  it("returns false for an empty query", () => {
    expect(matchesWithAliases("anything", "")).toBe(false);
  });
});

describe("expandQueryTokens", () => {
  it("keeps the literal token first for a brand", () => {
    const groups = expandQueryTokens("أريستون");
    expect(groups).toHaveLength(1);
    expect(groups[0][0]).toBe("اريستون");
    expect(groups[0]).toContain("arston");
  });

  it("leaves a non-brand token as a single alternative", () => {
    expect(expandQueryTokens("فلتر")).toEqual([["فلتر"]]);
  });
});

describe("matchesPartQuery", () => {
  it("handles a null field without throwing", () => {
    expect(matchesPartQuery(null, "ariston")).toBe(false);
  });

  it("is alias-aware on a part-number field", () => {
    expect(matchesPartQuery("0600.000.GENRAL.0005", "جنرال")).toBe(true);
  });
});
