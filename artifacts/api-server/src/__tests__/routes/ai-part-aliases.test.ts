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
  matchesItemQuery,
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

/**
 * The row-level lookup the operator actually triggers with `contains`.
 *
 * The live failure: a part's full description names the Part Number in one
 * column and the prose in another, so a per-FIELD match that requires every
 * token in ONE field reported «not found» for an item that was in the mail.
 * The operator's example was a Maico fan, but the defect is generality itself —
 * the NEXT item they type must work too, in whatever form they know it by.
 */
describe("matchesItemQuery (the operator's lookup, any item)", () => {
  /** A realistic parsed EDC row: description and part number in separate fields. */
  const row = {
    description:
      "PN: 1000108319 , EZQ 20/4 E Ex e MAICO FAN 440 M3 45 WATT 50HZ 230VAC FOR USED IN HAZARDOUS LOCATION ZONE 1",
    partNo: "1000108319",
    lineItemNo: "5720.011.GENRAL.2806",
  };

  it("finds the row when the query is LONGER than the row (the live failure)", () => {
    // The stored row stops at «HAZARDOU» (the PDF's own truncation) while the
    // operator typed the description out in full, adding specifications the
    // document never carried. Requiring every token — the old rule — reported
    // «not found» for an item that was right there. This is the exact pair of
    // strings measured live: 12 of the query's 18 identity tokens matched, and
    // no distinguishing value disagreed.
    const stored = {
      description:
        "PN: 1000108319 , EZQ 20/4 E Ex e MAICO FAN 440 M3 45 WATT 50HZ 230VAC FOR USED IN HAZARDOU",
      partNo: "1000108319",
      lineItemNo: "5720.011.GENRAL.2806",
    };
    const asTyped =
      "PN: 1000108319 , EZQ 20/4 E Ex e MAICO FAN 440 M3 45 WATT 50HZ 230VAC FOR USED IN HAZARDOUS LOCATION ZONE 1, MAX. AMBIENT TEMPERATURE +55 DEG C";
    expect(matchesItemQuery(stored, asTyped)).toBe(true);
  });

  it("finds the row by its bare part number", () => {
    expect(matchesItemQuery(row, "1000108319")).toBe(true);
  });

  it("finds the row by the model code alone", () => {
    expect(matchesItemQuery(row, "EZQ 20/4")).toBe(true);
    expect(matchesItemQuery(row, "MAICO FAN")).toBe(true);
  });

  it("finds the row by the Line Item code EDC prints", () => {
    expect(matchesItemQuery(row, "5720.011.GENRAL.2806")).toBe(true);
  });

  it("matches a part number that is split across the query and the column", () => {
    // The description carries `PN: 1000108319` while `partNo` holds it bare;
    // a per-field rule cannot see the pair, a per-row rule must.
    const split = { description: "PN: 1000108319 , FAN", partNo: null, lineItemNo: null };
    expect(matchesItemQuery(split, "PN 1000108319")).toBe(true);
  });

  it("is GENERIC: every kind of item the operator might ask for next", () => {
    const rows = [
      { description: "LED FLOOD LIGHT 200 W IP65", partNo: "LL-200", lineItemNo: "10.01" },
      { description: "CABLE 50 MM CU/PVC", partNo: "CBL50", lineItemNo: "10.02" },
      {
        description: "WATER HEATER ARISTON RUBIS PRO 40 V EG",
        partNo: "ARSTON-40",
        lineItemNo: "10.03",
      },
      { description: "NON RETURN VALVE 3/4 INCH BRASS", partNo: "NRV-075", lineItemNo: "10.04" },
    ];
    const find = (q: string) => rows.filter((r) => matchesItemQuery(r, q)).map((r) => r.partNo);

    expect(find("LL-200")).toEqual(["LL-200"]); // part number
    expect(find("LED FLOOD LIGHT 200 W IP65")).toEqual(["LL-200"]); // full description
    expect(find("flood light")).toEqual(["LL-200"]); // prose fragment
    expect(find("أريستون")).toEqual(["ARSTON-40"]); // Arabic brand
    expect(find("50 mm cable")).toEqual(["CBL50"]); // measured value
    expect(find("cable")).toEqual(["CBL50"]);
    expect(find("3/4 inch")).toEqual(["NRV-075"]); // fractional size
  });

  it("never matches a DIFFERENT size (a wrong match is worse than none)", () => {
    const cable50 = { description: "CABLE 50 MM", partNo: "CBL50", lineItemNo: null };
    const cable70 = { description: "CABLE 70 MM", partNo: "CBL70", lineItemNo: null };
    expect(matchesItemQuery(cable50, "CABLE 70 MM")).toBe(false);
    expect(matchesItemQuery(cable70, "CABLE 70 MM")).toBe(true);
  });

  it("refuses a different size even when MOST tokens match (the conflict guard)", () => {
    // 2 of 3 tokens match, so the coverage share ALONE would accept it — this
    // case exists so the attribute-conflict guard is exercised, not shadowed.
    // A purchasing decision made on the wrong size is worse than an honest miss.
    const cable50 = {
      description: "CABLE XLPE 50 MM ARMOURED",
      partNo: "CBL50",
      lineItemNo: null,
    };
    expect(matchesItemQuery(cable50, "CABLE XLPE 70 MM")).toBe(false);
    expect(matchesItemQuery(cable50, "CABLE XLPE 50 MM")).toBe(true);
  });

  it("rejects an item that shares no token, and an empty query", () => {
    expect(matchesItemQuery(row, "شركة نقل")).toBe(false);
    expect(matchesItemQuery(row, "   ")).toBe(false);
    expect(matchesItemQuery(row, "")).toBe(false);
  });
});
