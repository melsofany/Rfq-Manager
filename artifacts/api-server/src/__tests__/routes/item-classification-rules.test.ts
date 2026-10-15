import { describe, it, expect } from "vitest";
import { classifyItem, resolveDomainId, type CategorySeed } from "../../modules/rfq/classification";

// The reorganized catalogue: a functional domain (كهرباء) with a nested
// subcategory chain (Automation ← Encoders) and a lighting subcategory, plus the
// generic spare-parts domain the operator warned must not swallow everything.
const CATS: CategorySeed[] = [
  { id: 1, code: "equipment", name: "أجهزة", kind: "functional" },
  { id: 2, code: "spare_parts", name: "قطع غيار", kind: "functional" },
  { id: 3, code: "electrical", name: "كهرباء", kind: "functional" },
  { id: 4, code: "breakers", name: "قواطع", kind: "subcategory", parentId: 3 },
  { id: 10, code: "lighting", name: "إضاءة", kind: "subcategory", parentId: 3 },
  { id: 11, code: "automation", name: "Automation", kind: "subcategory", parentId: 3 },
  { id: 12, code: "encoders", name: "Encoders", kind: "subcategory", parentId: 11 },
  { id: 13, code: "plc", name: "PLC", kind: "subcategory", parentId: 11 },
  { id: 5, code: "fire_resistance", name: "مقاومة حريق", kind: "functional" },
  { id: 20, code: "siemens", name: "Siemens", kind: "brand" },
];

describe("item classification rules — lighting is a subcategory of electricity", () => {
  it("classifies a LED lamp as its DOMAIN (كهرباء), suggesting إضاءة", () => {
    const r = classifyItem({ description: "LED TUBE LAMP 120CM 18W" }, CATS);
    expect(r.categoryId).toBe(3); // كهرباء owns responsibility
    expect(r.subcategoryIds).toContain(10); // إضاءة suggested
  });

  it("classifies a flood light as its domain, suggesting إضاءة", () => {
    const r = classifyItem({ description: "FLOOD LIGHT 200W IP66" }, CATS);
    expect(r.categoryId).toBe(3);
    expect(r.subcategoryIds).toContain(10);
  });

  it("classifies a lighting panel as its domain", () => {
    const r = classifyItem({ description: "LIGHTING PANEL 12 WAY" }, CATS);
    expect(r.categoryId).toBe(3);
  });
});

describe("item classification rules — nested automation instruments", () => {
  it("resolves an Encoder to the FUNCTIONAL domain via the full parent chain", () => {
    // كهرباء ← Automation ← Encoders — two hops. Responsibility is كهرباء.
    expect(resolveDomainId(12, CATS)).toBe(3);
    const r = classifyItem({ description: "SIEMENS ENCODER 6FX2001" }, CATS);
    expect(r.categoryId).toBe(3);
    expect(r.subcategoryIds).toContain(12); // Encoders
    expect(r.subcategoryIds).toContain(11); // and its parent Automation
  });

  it("resolves a PLC to the functional domain and records the chain", () => {
    const r = classifyItem({ description: "SIEMENS PLC S7-1200" }, CATS);
    expect(r.categoryId).toBe(3);
    expect(r.subcategoryIds).toContain(13);
  });
});

describe("item classification rules — a brand never decides the domain", () => {
  it("does not classify on a brand name alone", () => {
    // "Siemens" ships breakers, encoders AND PLCs, so it must not pick one.
    const r = classifyItem({ description: "SIEMENS" }, CATS);
    expect(r.categoryId).toBeNull();
  });

  it("classifies a Siemens circuit breaker by its product family, not the brand", () => {
    const r = classifyItem({ description: "SIEMENS CIRCUIT BREAKER 3P 30A" }, CATS);
    expect(r.categoryId).toBe(3); // كهرباء
    expect(r.subcategoryIds).toContain(4); // قواطع
  });
});

describe("item classification rules — spare parts is not a generic bucket", () => {
  it("prefers the specific technical domain over the generic spare-parts domain", () => {
    // A description that matches BOTH «قطع غيار» (spare parts) and a specific
    // product family (قواطع) must land on the specific domain, per the operator's
    // rule that spare parts must not receive any item just because it is a part.
    const r = classifyItem({ description: "قطعة غيار قاطع كهرباء 3P" }, CATS);
    expect(r.categoryId).toBe(3); // كهرباء, not قطع غيار
    expect(r.subcategoryIds).toContain(4);
  });

  it("still classifies a plain bearing as spare parts (no specific family)", () => {
    const r = classifyItem({ description: "BEARING 6205 2RS" }, CATS);
    expect(r.categoryId).toBe(2);
  });
});
