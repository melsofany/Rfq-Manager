import { describe, expect, it } from "vitest";
import {
  describeLineExtras,
  hasLineExtras,
  matchesLineExtras,
  normalizeLineExtras,
} from "../modules/ai-assistant/item-filter";

describe("item line extras", () => {
  it("normalizes quantity and terms", () => {
    expect(normalizeLineExtras({ qty: "230", terms: ["70", " 12 ", ""] })).toEqual({
      qty: 230,
      terms: ["70", "12"],
    });
    expect(normalizeLineExtras({ terms: "70, 12" }).terms).toEqual(["70", "12"]);
    expect(normalizeLineExtras({ qty: 0 }).qty).toBeNull();
    expect(normalizeLineExtras({ qty: "abc" }).qty).toBeNull();
    expect(hasLineExtras(normalizeLineExtras({}))).toBe(false);
  });

  it("matches the exact quantity and all terms", () => {
    const e = normalizeLineExtras({ qty: 230, terms: ["70", "12"] });
    expect(matchesLineExtras({ description: "CABLE LUG 70 x 12", qty: 230 }, e)).toBe(true);
    expect(matchesLineExtras({ description: "CABLE LUG 70 x 12", qty: 229 }, e)).toBe(false);
    expect(matchesLineExtras({ description: "CABLE LUG 70", qty: 230 }, e)).toBe(false);
  });

  it("treats × and x as the same sign", () => {
    const e = normalizeLineExtras({ terms: ["70x12"] });
    expect(matchesLineExtras({ description: "CABLE LUG 70×12", qty: 1 }, e)).toBe(true);
  });

  it("describes the filter for a report header", () => {
    expect(describeLineExtras(normalizeLineExtras({ qty: 230, terms: ["70"] }))).toBe(
      "كلمات: 70 · كمية 230",
    );
    expect(describeLineExtras(normalizeLineExtras({}))).toBe("");
  });
});
