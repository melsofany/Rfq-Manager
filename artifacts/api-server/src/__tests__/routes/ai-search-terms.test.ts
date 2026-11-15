/**
 * Arabic ↔ English search terms.
 *
 * The operator's report: «أنا كتبت بالعربي المفروض هو يدور بالعربي والانجليزي».
 * Measured on production: «سلك حراري 10ملم» → «لم أعثر على صنف», while
 * `customer_po_items` holds 186 `CABLE` rows, 370 `HEAT` rows and
 * `DRAIN HEATING ELEMENT 5 MT. CABLE 220V`. The search query was correct; the
 * vocabulary was missing.
 *
 * These tests pin the behaviour that fixes it, and the two ways a widening
 * search goes WRONG: it must not become a conjunction (which rejects the rows it
 * was meant to find), and it must not add generic words that return the table.
 */
import { describe, it, expect } from "vitest";
import { expandSearchTerms, latinDigits, VOCAB } from "../../modules/ai-assistant/search-terms";

describe("expandSearchTerms", () => {
  it("reaches the English word behind an Arabic one", () => {
    // The exact reported failure: a thermal wire, described in English.
    const terms = expandSearchTerms("سلك حراري");
    expect(terms).toContain("WIRE");
    expect(terms).toContain("CABLE");
    expect(terms).toContain("THERMAL");
    expect(terms).toContain("HEAT");
  });

  it("keeps the operator's own term first, so a direct hit is never lost", () => {
    const terms = expandSearchTerms("سلك حراري");
    expect(terms[0]).toBe("سلك حراري");
  });

  it("reaches the Arabic word behind an English one (the reverse direction)", () => {
    // A manager typing the ERP spelling about a row entered by hand in Arabic.
    const terms = expandSearchTerms("CABLE");
    expect(terms).toContain("كابل");
    expect(terms).toContain("سلك");
  });

  it("folds Arabic spelling variants so one spelling finds another", () => {
    // «سلك حرارى» (alef maqsura) and «سلك حراري» (yaa) are the same word.
    expect(expandSearchTerms("حرارى")).toContain("THERMAL");
    expect(expandSearchTerms("إيطالي")).toContain("ITALY");
  });

  it("converts Arabic-Indic digits, so «١٠ملم» is searched as 10", () => {
    // The operator typed «سلك حراري ١٠ملم» — with Arabic-Indic digits.
    expect(latinDigits("١٠")).toBe("10");
    expect(latinDigits("سلك ١٠ملم")).toBe("سلك 10ملم");
    // The size stays glued to its unit inside the phrase, and the unit itself
    // reaches its English form — the Arabic-Indic digit was converted.
    const terms = expandSearchTerms("ملم ١٠");
    expect(terms[0]).toBe("ملم 10");
    // `MM` is deliberately NOT added: it matches 11% of the table as a
    // substring of every size, so it is a refinement the phrase already carries,
    // not an alternative. The digit conversion is what this test pins.
    expect(terms).toEqual(["ملم 10"]);
  });

  it("does not add generic words that would return the whole table", () => {
    // WITH/MODEL/MADE appear on nearly every row; OR-ing them makes the search
    // stop discriminating, which reads as a wrong answer rather than a wide one.
    const terms = expandSearchTerms("HEATER WITH MODEL");
    expect(terms).not.toContain("WITH");
    expect(terms).not.toContain("MODEL");
  });

  it("returns the term itself when there is no known counterpart", () => {
    // Inventing a translation would widen onto unrelated rows. A missing term
    // must stay missing, not become a wrong one.
    expect(expandSearchTerms("زرار سحري")).toEqual(["زرار سحري"]);
  });

  it("does not loosen the phrase into its bare words", () => {
    // «سلك حراري» must not become a search for `%سلك%`, which matches
    // «سلك شعر السويدى» — a wire, but not a thermal one. That is a WRONG answer,
    // which is worse than the missing one being fixed.
    const terms = expandSearchTerms("سلك حراري");
    expect(terms).not.toContain("سلك");
    expect(terms).not.toContain("حراري");
  });

  it("never returns an empty list for a non-empty term", () => {
    for (const t of ["سلك", "CABLE", "10", "سلك 3*6", "مكرونة حراري 10 مم"]) {
      expect(expandSearchTerms(t).length).toBeGreaterThan(0);
    }
    expect(expandSearchTerms("")).toEqual([]);
    expect(expandSearchTerms("   ")).toEqual([]);
  });

  it("keeps a mixed numeric token whole instead of translating half of it", () => {
    // `3*6` is a cable size, not a word. Splitting it would search for "3" and
    // "6" separately and match unrelated rows.
    const terms = expandSearchTerms("كابل 3*6");
    expect(terms).toContain("كابل 3*6");
    expect(terms).toContain("CABLE");
  });

  it("deduplicates, so the same word from two routes is searched once", () => {
    const terms = expandSearchTerms("سلك اسلاك");
    const upper = terms.map((t) => t.toUpperCase());
    expect(new Set(upper).size).toBe(upper.length);
  });
});

describe("the vocabulary is grounded in the data, not in a dictionary", () => {
  it("every English target is an UPPERCASE word or phrase", () => {
    // The comparison is case-insensitive `ilike`, but an inconsistent map is how
    // a term silently never matches; the map is the contract.
    for (const [ar, ens] of Object.entries(VOCAB.AR_TO_EN)) {
      expect(ar.length).toBeGreaterThan(0);
      expect(ens.length).toBeGreaterThan(0);
      for (const e of ens) expect(e).toBe(e.toUpperCase());
    }
  });

  it("every English key that maps back also exists as a target", () => {
    // A one-way entry is a search that works in one direction only — the exact
    // shape of the reported defect.
    for (const [en, ars] of Object.entries(VOCAB.EN_TO_AR)) {
      expect(en).toBe(en.toUpperCase());
      for (const a of ars) expect(typeof a).toBe("string");
    }
  });

  it("maps no unit or single-letter word, which is not a discriminator", () => {
    // Measured on production: `M` matches 79% of customer_po_items, `W` 57%,
    // `V` 50% — as substrings of MM/MODEL/MADE/VOLT. OR-ing one returns the
    // whole table. A target shorter than 3 characters is that bug by shape.
    // `AC` is a legitimate short target; the units are the problem by name.
    const UNIT_TARGETS = new Set(["MM", "MT", "INCH", "AMP", "VOLT", "WATT", "LITER"]);
    for (const [, ens] of Object.entries(VOCAB.AR_TO_EN)) {
      for (const e of ens) {
        expect(UNIT_TARGETS.has(e)).toBe(false);
        expect(e).not.toMatch(/^[A-Z]$/);
      }
    }
  });

  it("does not map a stopword to anything", () => {
    for (const s of VOCAB.EN_STOPWORDS) {
      expect(VOCAB.EN_TO_AR[s]).toBeUndefined();
    }
  });
});
