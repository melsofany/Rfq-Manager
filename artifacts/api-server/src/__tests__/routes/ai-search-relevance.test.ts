import { it, expect, describe } from "vitest";

/**
 * The match set for a bilingual search is a UNION of every counterpart, so the
 * ORDER decides what the operator sees. «سلك حراري» expands to WIRE/CABLE/
 * THERMAL plus HEAT/HEATER/HEATING, and the newest matching row was returned
 * first — a `WATER HEATER` — while the actual `THERMAL WIRE CABLE` sat below the
 * cut. The model then reported «لا يوجد» about a part it had been handed.
 *
 * These guard the ORDERING RULE, not the SQL: a row satisfying more distinct
 * ideas must rank above one satisfying fewer.
 */
function scoreRow(description: string, families: string[][]): number {
  const hay = description.toLowerCase();
  return families.filter((f) => f.some((t) => hay.includes(t.toLowerCase()))).length;
}

/** Terms that contain one another collapse to ONE idea (HEAT/HEATER/HEATING). */
function toFamilies(terms: string[]): string[][] {
  const families: string[][] = [];
  for (const t of terms) {
    const f = families.find((g) => g.some((x) => x.includes(t) || t.includes(x)));
    if (f) f.push(t);
    else families.push([t]);
  }
  return families;
}

describe("bilingual search relevance", () => {
  const families = toFamilies(["THERMAL", "WIRE", "CABLE", "HEAT", "HEATER", "HEATING"]);

  it("collapses terms that contain one another into a single idea", () => {
    expect(families).toHaveLength(4);
    expect(families.find((f) => f.includes("HEAT"))).toEqual(["HEAT", "HEATER", "HEATING"]);
  });

  it("ranks the exact part above a row matching one family", () => {
    const target = "THERMAL WIRE CABLE SIZE 6 MM 300-500 V MADE IN ITALY";
    const heater = "WATER HEATER ARISTON RUBIS PRO 40 V EG , 40 LITER";
    expect(scoreRow(target, families)).toBe(3);
    expect(scoreRow(heater, families)).toBe(1);
    expect(scoreRow(target, families)).toBeGreaterThan(scoreRow(heater, families));
  });

  it("does not credit one word three times", () => {
    // «HEATING ELEMENT» contains HEAT, HEATER? no — but HEATING yes. Without the
    // family collapse all three terms score, inflating it above THERMAL WIRE.
    const element = "HEATING ELEMENT 1500 W";
    const naive = ["THERMAL", "WIRE", "CABLE", "HEAT", "HEATER", "HEATING"].filter((t) =>
      element.toLowerCase().includes(t.toLowerCase()),
    ).length;
    expect(naive).toBeGreaterThan(1);
    expect(scoreRow(element, families)).toBe(1);
  });

  it("still returns a single-term match (relevance must not exclude)", () => {
    expect(scoreRow("SOFT ANNEALED COPPER FINE WIRES", families)).toBe(1);
  });
});
