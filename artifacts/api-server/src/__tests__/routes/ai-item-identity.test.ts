/**
 * Item identity — the operator's rule that a Part Number is NOT the identity.
 *
 * The live failure this guards: the same breaker was counted as two items
 * because one PO printed `P/N : A9R41440` and another identified it by
 * description alone, and a `0600.000.GENRAL.0005` VAT pseudo-line climbed to the
 * top of a frequency ranking because a part-number-shaped token was treated as
 * proof of an item.
 *
 * Each test below fails against a part-number-keyed implementation, which is the
 * point: they pin the behaviour, not the code path.
 */
import { describe, it, expect } from "vitest";

const {
  canonicalPartNo,
  itemTokens,
  itemAttributes,
  hasConflictingAttributes,
  buildItemIdentity,
  itemsEquivalent,
  groupByItemIdentity,
  hasConfidentIdentity,
} = await import("../../modules/ai-assistant/item-identity");

describe("canonicalPartNo", () => {
  it("folds separators and case so one code has one identity", () => {
    expect(canonicalPartNo("680-632")).toBe(canonicalPartNo("680 632"));
    expect(canonicalPartNo("a.1")).toBe(canonicalPartNo("A1"));
    expect(canonicalPartNo(null)).toBe("");
  });
});

describe("itemTokens", () => {
  it("drops stopwords, filler and bare numbers", () => {
    const t = itemTokens("2 INCH BRASS LONG SHACKLE PADLOCK WITH 3 KEYS");
    expect(t).toContain("brass");
    expect(t).toContain("shackle");
    // "with" is filler; "2" and "3" are quantities, not identity.
    expect(t).not.toContain("with");
    expect(t).not.toContain("2");
    expect(t).not.toContain("3");
  });

  it("folds unit spellings so LITERS and LTR compare equal", () => {
    const a = itemTokens("WATER HEATER 50 LITERS");
    const b = itemTokens("WATER HEATER 50 LTR");
    expect(a.sort()).toEqual(b.sort());
  });

  it("is order-independent — the same item written two ways", () => {
    const a = itemTokens("LED 120 CM WATERPROOF");
    const b = itemTokens("WATERPROOF LED 120 CM");
    expect(a.sort()).toEqual(b.sort());
  });

  it("normalises Arabic spelling variants", () => {
    const a = itemTokens("سخان أريستون");
    const b = itemTokens("سخان اريستون");
    expect(a.sort()).toEqual(b.sort());
  });
});

describe("itemAttributes", () => {
  it("extracts a measured value with its unit", () => {
    const attrs = itemAttributes(itemTokens("CABLE 50 MM"));
    expect(attrs.measured.get("length")).toEqual(new Set(["50mm"]));
  });

  it("extracts a model-like code", () => {
    const attrs = itemAttributes(itemTokens("CONTACTOR LC1D32Q7 SCHNEIDER"));
    expect([...attrs.models]).toContain("lc1d32q7");
  });

  it("does not read a bare number as a model", () => {
    const attrs = itemAttributes(itemTokens("PADLOCK 12 PIECE"));
    expect(attrs.models.size).toBe(0);
  });
});

describe("hasConflictingAttributes", () => {
  it("treats two different sizes as a conflict", () => {
    const a = itemAttributes(itemTokens("CABLE 50 MM"));
    const b = itemAttributes(itemTokens("CABLE 70 MM"));
    expect(hasConflictingAttributes(a, b)).toBe(true);
  });

  it("treats two different models as a conflict", () => {
    const a = itemAttributes(itemTokens("CONTACTOR LC1D32Q7"));
    const b = itemAttributes(itemTokens("CONTACTOR LC1D25Q7"));
    expect(hasConflictingAttributes(a, b)).toBe(true);
  });

  it("does not conflict when only one side states the attribute", () => {
    const a = itemAttributes(itemTokens("CABLE 50 MM"));
    const b = itemAttributes(itemTokens("CABLE"));
    expect(hasConflictingAttributes(a, b)).toBe(false);
  });
});

describe("itemsEquivalent", () => {
  it("merges the same item when one PO omits the part number", () => {
    // The operator's exact case: one order prints the code, the next identifies
    // the item by description alone. A part-number-keyed grouping splits these
    // into two items and misreports the frequency.
    const withCode = buildItemIdentity({
      partNo: "A9R41440",
      description: "2 INCH BRASS LONG SHACKLE PADLOCK WITH 3 KEYS",
    });
    const without = buildItemIdentity({
      partNo: null,
      description: "2 INCH BRASS LONG SHACKLE PADLOCK WITH 3 KEYS",
    });
    expect(itemsEquivalent(withCode, without)).toBe(true);
  });

  it("merges spelling variants of the same part number", () => {
    const a = buildItemIdentity({ partNo: "680-632", description: "CLAMP" });
    const b = buildItemIdentity({ partNo: "680632", description: "CLAMP" });
    expect(itemsEquivalent(a, b)).toBe(true);
  });

  it("NEVER merges two different part numbers", () => {
    const a = buildItemIdentity({ partNo: "A1", description: "SAME WORDING HERE" });
    const b = buildItemIdentity({ partNo: "B2", description: "SAME WORDING HERE" });
    expect(itemsEquivalent(a, b)).toBe(false);
  });

  it("refuses to merge descriptions that differ only by size", () => {
    const a = buildItemIdentity({ partNo: null, description: "FLEXIBLE CABLE 50 MM COPPER" });
    const b = buildItemIdentity({ partNo: null, description: "FLEXIBLE CABLE 70 MM COPPER" });
    expect(itemsEquivalent(a, b)).toBe(false);
  });

  it("refuses to merge two items sharing only a single word", () => {
    const a = buildItemIdentity({ partNo: null, description: "WATER PUMP CENTRIFUGAL" });
    const b = buildItemIdentity({ partNo: null, description: "WATER TANK STEEL" });
    expect(itemsEquivalent(a, b)).toBe(false);
  });

  it("merges two identical descriptions with no part number", () => {
    const a = buildItemIdentity({ partNo: null, description: "UNKNOWN PART NAME" });
    const b = buildItemIdentity({ partNo: null, description: "UNKNOWN PART NAME" });
    expect(itemsEquivalent(a, b)).toBe(true);
  });
});

describe("groupByItemIdentity", () => {
  it("chains the same item across wordings into ONE cluster", () => {
    // Identity is transitive: A matches B and B matches C, so all three must
    // land in one group even though A and C were never compared directly.
    const rows = [
      { partNo: "A9R41440", description: "PADLOCK 2 INCH BRASS" },
      { partNo: null, description: "PADLOCK 2 INCH BRASS" },
      { partNo: "A9R41440", description: "PADLOCK 2 INCH BRASS LONG SHACKLE" },
    ];
    const groups = groupByItemIdentity(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(3);
  });

  it("keeps genuinely different items apart", () => {
    const rows = [
      { partNo: null, description: "CABLE 50 MM" },
      { partNo: null, description: "CABLE 70 MM" },
    ];
    expect(groupByItemIdentity(rows)).toHaveLength(2);
  });

  it("returns one cluster per distinct part number", () => {
    const rows = [
      { partNo: "A1", description: "X" },
      { partNo: "B2", description: "X" },
      { partNo: "A1", description: "X" },
    ];
    const groups = groupByItemIdentity(rows);
    expect(groups).toHaveLength(2);
  });
});

describe("hasConfidentIdentity", () => {
  it("is confident with a part number", () => {
    expect(hasConfidentIdentity(buildItemIdentity({ partNo: "A1", description: "X" }))).toBe(true);
  });

  it("is confident with a model code in the prose", () => {
    expect(
      hasConfidentIdentity(
        buildItemIdentity({ partNo: null, description: "CONTACTOR LC1D32Q7 220V" }),
      ),
    ).toBe(true);
  });

  it("is NOT confident when only prose identifies the item", () => {
    // The operator asked for this count explicitly: an item identified by prose
    // alone must be reported, not silently trusted.
    expect(
      hasConfidentIdentity(buildItemIdentity({ partNo: null, description: "SOME FITTING PART" })),
    ).toBe(false);
  });
});
