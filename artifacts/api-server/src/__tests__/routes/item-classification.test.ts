import { describe, it, expect } from "vitest";
import {
  classifyItem,
  normalizeText,
  MIN_CONFIDENCE,
  categoryKeywords,
  seedKeywords,
  CATEGORY_KEYWORDS,
  type CategorySeed,
} from "../../modules/rfq/classification";

const CATS: CategorySeed[] = [
  { id: 1, code: "equipment", name: "أجهزة", kind: "functional" },
  { id: 2, code: "spare_parts", name: "قطع غيار", kind: "functional" },
  { id: 3, code: "electrical", name: "كهرباء", kind: "functional" },
  { id: 4, code: "breakers", name: "قواطع", kind: "subcategory", parentId: 3 },
  { id: 5, code: "fire_resistance", name: "مقاومة حريق", kind: "functional" },
];

describe("item classification", () => {
  it("normalises Arabic spelling variants", () => {
    expect(normalizeText("مقاومة الحريق")).toBe("مقاومه الحريق");
    expect(normalizeText("أجهزة")).toBe("اجهزه");
    expect(normalizeText("إضاءة")).toBe("اضاءه");
  });

  it("classifies an Arabic fire-resistance description", () => {
    const r = classifyItem({ description: "بند مقاومة حريق للكابل" }, CATS);
    expect(r.categoryId).toBe(5);
    expect(r.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });

  it("classifies an English circuit breaker as its DOMAIN (كهرباء), with قواطع suggested", () => {
    // قواطع is a subcategory of كهرباء, so responsibility lands on the domain
    // (كهرباء) and قواطع is returned only as a suggestion.
    const r = classifyItem({ description: "CIRCUIT BREAKER 3P 30A" }, CATS);
    expect(r.categoryId).toBe(3);
    expect(r.subcategoryIds).toContain(4);
  });

  it("classifies a water heater as equipment, not spare parts", () => {
    const r = classifyItem({ description: "WATER HEATER ARISTON 50L" }, CATS);
    expect(r.categoryId).toBe(1);
  });

  it("classifies a cable as electrical", () => {
    const r = classifyItem({ description: "CABLE 3X2.5 MM" }, CATS);
    expect(r.categoryId).toBe(3);
  });

  it("classifies a bearing as spare parts", () => {
    const r = classifyItem({ description: "BEARING 6205 2RS" }, CATS);
    expect(r.categoryId).toBe(2);
  });

  it("uses a part-number family only to corroborate, never alone", () => {
    // A 5720.* line item with a neutral description: the family hint (30) is
    // below the threshold, so the item stays unclassified rather than guessed.
    const alone = classifyItem({ description: "ITEM", lineItem: "5720.001.X.0001" }, CATS);
    expect(alone.categoryId).toBeNull();

    // With an electrical keyword, the family corroborates and the item is
    // classified.
    const corroborated = classifyItem({ description: "CABLE", lineItem: "5720.001.X.0001" }, CATS);
    expect(corroborated.categoryId).toBe(3);
  });

  it("never fabricates: an unknown description is unclassified", () => {
    const r = classifyItem({ description: "ZQX UNKNOWN PART 999" }, CATS);
    expect(r.categoryId).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it("treats an equal match as ambiguous rather than picking one", () => {
    // «قاطع» (breakers) and «حريق» (fire) both present at token level → tie.
    const r = classifyItem({ description: "قاطع حريق" }, CATS);
    expect(r.ambiguous).toBe(true);
    expect(r.categoryId).toBeNull();
  });
});

describe("admin-managed vocabulary", () => {
  it("classifies from a DB-shaped vocabulary, not just the seed", () => {
    // A term that exists ONLY in the DB vocabulary must classify the item.
    const vocab = { equipment: [{ term: "gizmo", weight: 0 }] };
    const r = classifyItem({ description: "GIZMO 3000" }, CATS, vocab);
    expect(r.categoryId).toBe(1);
  });

  it("a custom weight adds to the default, it never replaces it", () => {
    // A single weak term is enough to pass the threshold on its own, so verify
    // the weight ADDs by scoring two custom terms: base(45)+base(45)+extra.
    const withWeight = classifyItem({ description: "bearing seal" }, CATS, {
      spare_parts: [
        { term: "bearing", weight: 20 },
        { term: "seal", weight: 20 },
      ],
    });
    const withoutWeight = classifyItem({ description: "bearing seal" }, CATS, {
      spare_parts: [
        { term: "bearing", weight: 0 },
        { term: "seal", weight: 0 },
      ],
    });
    expect(withWeight.confidence).toBeGreaterThan(withoutWeight.confidence);
  });

  it("a category with NO enabled keyword produces no candidate (cannot auto-assign)", () => {
    // Vocabulary omits equipment entirely → an equipment-only description
    // stays unclassified instead of guessing.
    const vocab = { spare_parts: ["bearing"] };
    const r = classifyItem({ description: "WATER HEATER ARISTON 50L" }, CATS, vocab);
    expect(r.categoryId).toBeNull();
  });

  it("accepts both seed strings and DB {term,weight} entries", () => {
    const mixed = { electrical: ["cable", { term: "wire", weight: 5 }] };
    expect(classifyItem({ description: "CABLE 3X2.5" }, CATS, mixed).categoryId).toBe(3);
    expect(classifyItem({ description: "WIRE 2.5MM" }, CATS, mixed).categoryId).toBe(3);
  });

  it("the seed covers every category the classifier ships with (no silent drop)", () => {
    // The seed that init-db inserts must contain EVERY keyword in the built-in
    // constant, or moving terms into the DB would lower accuracy silently.
    const seed = seedKeywords();
    for (const [code, terms] of Object.entries(CATEGORY_KEYWORDS)) {
      const seeded = seed.filter((s) => s.code === code).map((s) => s.keyword);
      for (const t of terms) {
        expect(seeded).toContain(t);
      }
    }
    // And the seed is non-empty and shaped for insertion.
    expect(seed.length).toBeGreaterThan(0);
    expect(seed.every((s) => s.code && s.keyword)).toBe(true);
  });

  it("categoryKeywords() still exposes the built-in fallback", () => {
    expect(categoryKeywords().equipment).toContain("pump");
  });
});
