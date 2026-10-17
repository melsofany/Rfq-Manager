/**
 * Category catalogue reconciliation — the live-data guard.
 *
 * The fixtures below are the REAL production snapshot (38 supplier categories,
 * 50 item categories, 37 of the supplier categories linked to a supplier), read
 * from the Render database before the fix. They reproduce the operator's report
 * exactly:
 *
 *   • «مشروبات ومواد غذائية» and «كاوتش معدات ثقيلة» exist on `/suppliers` only;
 *   • «أجهزة», «قطع غيار», «مقاومة حريق» and «ELEC» exist on the item side only;
 *   • «إضاءة» is a `subcategory` while 14 suppliers filter by it as a trade;
 *   • «قواطع» was seeded as a specialisation but its live row is `functional`.
 *
 * The suite fails against the pre-fix behaviour (the two lists differ) and
 * passes once `reconcileCatalog` + `projectCatalog` are applied.
 */
import { describe, it, expect } from "vitest";
import {
  isTradeCategory,
  reconcileCatalog,
  projectCatalog,
  type CatalogCategory,
  type ReconcileInput,
} from "../../shared/category-catalog";

// ── Live snapshot: supplier_categories (38 rows, plus the leaked mirror row) ──
// `قواطع` (id 1314, zero links) is present because the FIRST cut of this fix
// mirrored every active functional item category into `supplier_categories`, and
// it shipped. Reproducing it here is what makes the ordering guard real: with the
// row present, a demotion that consults `supplierByName` refuses to hide قواطع,
// and the two lists stay 41 vs 40.
const SUPPLIER_CATEGORIES: Array<{ id: number; name: string; linkCount?: number }> = [
  { id: 1, name: "كهرباء" },
  { id: 2, name: "معدات  فندقيه" },
  { id: 3, name: "الصحة والسلامة ومقاومة الحريق" },
  { id: 4, name: "الميكانيكا" },
  { id: 5, name: "الإلكترونيات" },
  { id: 6, name: "أدوات النظافة" },
  { id: 7, name: "معدات المطابخ الكبيرة الفندقية" },
  { id: 8, name: "تكنولوجيا المعلومات (IT)" },
  { id: 10, name: "اسطوانات غاز وادوات لحام  وتنكات" },
  { id: 11, name: "رولمان بلي وشحوم" },
  { id: 12, name: "مضخات مياه   ومعالجه مياة" },
  { id: 13, name: "بطاريات UPS" },
  { id: 14, name: "إضاءة" },
  { id: 15, name: "office furniture" },
  { id: 16, name: "شنايدر" },
  { id: 17, name: "3m   schotch" },
  { id: 18, name: "اتوميشن" },
  { id: 19, name: "اجهزه منزلية" },
  { id: 20, name: "مسامير" },
  { id: 21, name: "حدايد وبوايات" },
  { id: 23, name: "عدد و ادوات" },
  { id: 24, name: "لواصق  شحوم  وسيلكون و  CRC" },
  { id: 25, name: "مشروبات ومواد غذائية" },
  { id: 26, name: "قطع غيار  معدات  فندقية" },
  { id: 27, name: "معدات مضادة للانفجار" },
  { id: 28, name: "كاوتش معدات ثقيلة" },
  { id: 29, name: "قطع غيار Dewalt" },
  { id: 30, name: "اجهزة قياس  وتحكم" },
  { id: 32, name: "معدات البترول" },
  { id: 197, name: "اكياس بلاستيك" },
  { id: 198, name: "محولات - Transformers" },
  { id: 433, name: "قطع غيار lowara" },
  { id: 446, name: "مواد عازل - دهانات" },
  { id: 1148, name: "طباعة وورق" },
  { id: 1149, name: "سباكة" },
  { id: 1182, name: "قطع غيار معدات ثقيلة" },
  { id: 1183, name: "كابلات متخصصة" },
  { id: 1223, name: "دهانات" },
  // Leaked by the first cut of the reconciliation (see the header comment).
  { id: 1314, name: "قواطع", linkCount: 0 },
];

// ── Live snapshot: item_categories (50 rows) ─────────────────────────────────
const ITEM_CATEGORIES: CatalogCategory[] = [
  { id: 1, name: "أجهزة", code: "equipment", kind: "functional", isActive: true },
  { id: 2, name: "قطع غيار", code: "spare_parts", kind: "functional", isActive: true },
  { id: 3, name: "كهرباء", code: "electrical", kind: "functional", isActive: true },
  { id: 4, name: "قواطع", code: "breakers", kind: "functional", isActive: true },
  { id: 5, name: "مقاومة حريق", code: "fire_resistance", kind: "functional", isActive: true },
  { id: 26, name: "ELEC", code: null, kind: "functional", isActive: true },
  { id: 27, name: "معدات  فندقيه", code: null, kind: "functional", isActive: true },
  { id: 28, name: "الصحة والسلامة ومقاومة الحريق", code: null, kind: "functional", isActive: true },
  { id: 29, name: "الميكانيكا", code: null, kind: "functional", isActive: true },
  { id: 30, name: "الإلكترونيات", code: null, kind: "functional", isActive: true },
  { id: 31, name: "أدوات النظافة", code: null, kind: "functional", isActive: true },
  {
    id: 32,
    name: "معدات المطابخ الكبيرة الفندقية",
    code: null,
    kind: "functional",
    isActive: true,
  },
  { id: 33, name: "تكنولوجيا المعلومات (IT)", code: null, kind: "functional", isActive: true },
  {
    id: 34,
    name: "اسطوانات غاز وادوات لحام  وتنكات",
    code: null,
    kind: "functional",
    isActive: true,
  },
  { id: 35, name: "رولمان بلي وشحوم", code: null, kind: "functional", isActive: true },
  { id: 36, name: "مضخات مياه   ومعالجه مياة", code: null, kind: "functional", isActive: true },
  { id: 37, name: "بطاريات UPS", code: null, kind: "functional", isActive: true },
  { id: 38, name: "اضاءة", code: null, kind: "functional", isActive: false },
  { id: 39, name: "office furniture", code: null, kind: "functional", isActive: true },
  { id: 40, name: "شنايدر", code: null, kind: "functional", isActive: true },
  { id: 41, name: "3m   schotch", code: null, kind: "functional", isActive: true },
  { id: 42, name: "اتوميشن", code: null, kind: "functional", isActive: true },
  { id: 43, name: "اجهزه منزلية", code: null, kind: "functional", isActive: true },
  { id: 44, name: "مسامير", code: null, kind: "functional", isActive: true },
  { id: 45, name: "عدد و ادوات", code: null, kind: "functional", isActive: true },
  { id: 46, name: "لواصق  شحوم  وسيلكون و  CRC", code: null, kind: "functional", isActive: true },
  { id: 48, name: "قطع غيار  معدات  فندقية", code: null, kind: "functional", isActive: true },
  { id: 49, name: "معدات مضادة للانفجار", code: null, kind: "functional", isActive: true },
  { id: 51, name: "قطع غيار Dewalt", code: null, kind: "functional", isActive: true },
  { id: 52, name: "اجهزة قياس  وتحكم", code: null, kind: "functional", isActive: true },
  { id: 53, name: "معدات البترول", code: null, kind: "functional", isActive: true },
  { id: 54, name: "اكياس بلاستيك", code: null, kind: "functional", isActive: true },
  { id: 55, name: "محولات - Transformers", code: null, kind: "functional", isActive: true },
  { id: 56, name: "حدايد وبوايات", code: null, kind: "functional", isActive: true },
  { id: 57, name: "قطع غيار lowara", code: null, kind: "functional", isActive: true },
  { id: 58, name: "مواد عازل - دهانات", code: null, kind: "functional", isActive: true },
  { id: 59, name: "طباعة وورق", code: null, kind: "functional", isActive: true },
  { id: 60, name: "سباكة", code: null, kind: "functional", isActive: true },
  { id: 61, name: "قطع غيار معدات ثقيلة", code: null, kind: "functional", isActive: true },
  { id: 62, name: "كابلات متخصصة", code: null, kind: "functional", isActive: true },
  { id: 404, name: "كونتاكتورات", code: "contactors", kind: "subcategory", isActive: true },
  { id: 405, name: "كابلات", code: "cables", kind: "subcategory", isActive: true },
  { id: 406, name: "لوحات كهربائية", code: "panels", kind: "subcategory", isActive: true },
  { id: 407, name: "PLC", code: "plc", kind: "subcategory", isActive: true },
  { id: 408, name: "Automation", code: "automation", kind: "subcategory", isActive: true },
  { id: 409, name: "Encoders", code: "encoders", kind: "subcategory", isActive: true },
  {
    id: 410,
    name: "Control Systems",
    code: "control_systems",
    kind: "subcategory",
    isActive: true,
  },
  {
    id: 411,
    name: "Electrical Instruments",
    code: "instruments",
    kind: "subcategory",
    isActive: true,
  },
  { id: 750, name: "دهانات", code: null, kind: "functional", isActive: true },
  { id: 871, name: "إضاءة", code: "lighting", kind: "subcategory", isActive: true },
];

/** The seed's own declarations — mirrors `init-db.ts`. */
const INPUT: ReconcileInput = {
  supplierCategories: SUPPLIER_CATEGORIES,
  itemCategories: ITEM_CATEGORIES,
  declaredSubcategories: [
    { name: "قواطع", parent: "كهرباء" },
    { name: "كونتاكتورات", parent: "كهرباء" },
    { name: "كابلات", parent: "كهرباء" },
    { name: "لوحات كهربائية", parent: "كهرباء" },
    { name: "Automation", parent: "كهرباء" },
    { name: "PLC", parent: "Automation" },
    { name: "Encoders", parent: "Automation" },
    { name: "Control Systems", parent: "Automation" },
    { name: "Electrical Instruments", parent: "كهرباء" },
  ],
  declaredAliases: [
    { alias: "ELEC", canonical: "كهرباء" },
    { alias: "اضاءة", canonical: "إضاءة" },
  ],
  declaredFunctional: ["إضاءة"],
};

function tradeNames(items: CatalogCategory[]): string[] {
  return items.filter(isTradeCategory).map((c) => c.name);
}

describe("isTradeCategory", () => {
  it("accepts an active functional domain and a legacy row with no kind", () => {
    expect(
      isTradeCategory({
        id: 1,
        name: "كهرباء",
        code: "electrical",
        kind: "functional",
        isActive: true,
      }),
    ).toBe(true);
    expect(isTradeCategory({ id: 2, name: "سباكة", code: null, kind: null, isActive: true })).toBe(
      true,
    );
  });

  it("rejects a subcategory, a brand and an inactive row", () => {
    expect(
      isTradeCategory({
        id: 1,
        name: "قواطع",
        code: "breakers",
        kind: "subcategory",
        isActive: true,
      }),
    ).toBe(false);
    expect(
      isTradeCategory({ id: 2, name: "شنايدر", code: null, kind: "brand", isActive: true }),
    ).toBe(false);
    expect(
      isTradeCategory({ id: 3, name: "اضاءة", code: null, kind: "functional", isActive: false }),
    ).toBe(false);
  });
});

describe("the live drift this fix removes", () => {
  it("BEFORE the plan the two lists differ — the operator's report", () => {
    const supplier = [...SUPPLIER_CATEGORIES.map((s) => s.name)].sort();
    const item = tradeNames(ITEM_CATEGORIES).sort();

    const supplierOnly = supplier.filter((n) => !item.includes(n));
    const itemOnly = item.filter((n) => !supplier.includes(n));

    // «إضاءة» is a subcategory on the item side while 14 suppliers filter by it.
    expect(supplierOnly).toEqual(
      expect.arrayContaining(["مشروبات ومواد غذائية", "كاوتش معدات ثقيلة", "إضاءة"]),
    );
    expect(itemOnly).toEqual(expect.arrayContaining(["أجهزة", "قطع غيار", "ELEC"]));
    expect(supplier.length).not.toBe(item.length);
  });
});

describe("reconcileCatalog", () => {
  const plan = reconcileCatalog(INPUT);

  it("adds the supplier-only categories to the item catalogue", () => {
    expect(plan.addToItem).toEqual(
      expect.arrayContaining(["مشروبات ومواد غذائية", "كاوتش معدات ثقيلة"]),
    );
  });

  it("adds the item-only trade categories to the supplier catalogue", () => {
    expect(plan.addToSupplier).toEqual(
      expect.arrayContaining(["أجهزة", "قطع غيار", "مقاومة حريق"]),
    );
    // A merged alias and a hidden specialisation are never re-added.
    expect(plan.addToSupplier).not.toContain("ELEC");
    expect(plan.addToSupplier).not.toContain("قواطع");
    expect(plan.addToSupplier).not.toContain("إضاءة");
  });

  it("promotes «إضاءة» to an independent functional domain (decision أ١)", () => {
    expect(plan.promoteToFunctional).toEqual(["إضاءة"]);
  });

  it("folds ELEC into «كهرباء» and «اضاءة» into «إضاءة»", () => {
    expect(plan.merges).toEqual(
      expect.arrayContaining([
        { alias: "ELEC", canonical: "كهرباء" },
        { alias: "اضاءة", canonical: "إضاءة" },
      ]),
    );
  });

  it("demotes the specialisation whose live row is still functional", () => {
    expect(plan.demoteToSubcategory).toEqual([{ name: "قواطع", parent: "كهرباء" }]);
  });

  it("drops the UNUSED specialisation row that leaked into supplier_categories", () => {
    // The first cut mirrored every active functional item category into
    // `supplier_categories`, so `قواطع` was registered there. Left alone it makes
    // `/suppliers` list one MORE category than the item side — the exact «تزيد»
    // the operator forbade.
    expect(plan.dropFromSupplier).toEqual(["قواطع"]);
  });

  it("NEVER drops a specialisation a supplier actually links to", () => {
    // One link means the operator really filters by it, so the row is a live
    // trade and must survive even though the seed calls it a specialisation.
    const linked: ReconcileInput = {
      ...INPUT,
      supplierCategories: INPUT.supplierCategories.map((s) =>
        s.name === "قواطع" ? { ...s, linkCount: 7 } : s,
      ),
    };
    const p = reconcileCatalog(linked);
    expect(p.dropFromSupplier).toEqual([]);
    // And the demotion must then leave it alone too — it is supplier-declared.
    expect(p.demoteToSubcategory).toEqual([]);
  });
});

describe("the reconciled lists are IDENTICAL", () => {
  const plan = reconcileCatalog(INPUT);
  const { supplierNames, itemTradeNames } = projectCatalog(INPUT, plan);

  it("has no category present on only one side", () => {
    expect(itemTradeNames.filter((n) => !supplierNames.includes(n))).toEqual([]);
    expect(supplierNames.filter((n) => !itemTradeNames.includes(n))).toEqual([]);
  });

  it("has the same size and the same names", () => {
    expect(supplierNames.length).toBe(itemTradeNames.length);
    expect(supplierNames).toEqual(itemTradeNames);
  });

  it("hides every subcategory from the trade list", () => {
    for (const sub of [
      "قواطع",
      "كونتاكتورات",
      "كابلات",
      "لوحات كهربائية",
      "PLC",
      "Encoders",
      "Control Systems",
      "Electrical Instruments",
    ]) {
      expect(itemTradeNames).not.toContain(sub);
    }
    // Automation is a specialisation of كهرباء, so it is hidden too.
    expect(itemTradeNames).not.toContain("Automation");
  });

  it("keeps the 14-supplier trade category «إضاءة» on BOTH sides", () => {
    expect(supplierNames).toContain("إضاءة");
    expect(itemTradeNames).toContain("إضاءة");
  });

  it("keeps every GENUINE supplier category visible — only the leaked row goes", () => {
    // The rule is «لا تزيد ولا تنقص»: a real supplier category must never vanish,
    // but the row the first cut leaked in (`قواطع`, a specialisation with zero
    // supplier links) must go, or /suppliers lists one MORE than the item side.
    // Asserting the drop is a single, named, link-less row is the point.
    expect(plan.dropFromSupplier).toEqual(["قواطع"]);
    for (const s of SUPPLIER_CATEGORIES) {
      if (s.name === "قواطع") continue;
      expect(supplierNames, `a genuine supplier category vanished: ${s.name}`).toContain(s.name);
    }
    expect(supplierNames).not.toContain("قواطع");
  });
});
