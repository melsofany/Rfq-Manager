import { describe, it, expect } from "vitest";
import {
  classificationIdentityKey,
  descriptionSignature,
  MIN_SIGNATURE_TOKENS,
} from "../../modules/rfq/item-identity";

describe("item classification identity", () => {
  it("uses the Part Number as a strong identity when present", () => {
    const a = classificationIdentityKey({ partNo: "680-632", description: "anything" });
    const b = classificationIdentityKey({ partNo: "680 632", description: "different wording" });
    expect(a).toBe(b); // separators folded
    expect(a?.startsWith("pn:")).toBe(true);
  });

  it("never merges two DIFFERENT part numbers", () => {
    const a = classificationIdentityKey({ partNo: "A9R41440", description: "SAME DESC" });
    const b = classificationIdentityKey({ partNo: "B1C22222", description: "SAME DESC" });
    expect(a).not.toBe(b);
  });

  it("falls back to a description signature when there is no part number", () => {
    const a = classificationIdentityKey({ description: "LED TUBE LAMP 120CM 18W EL SEWEEDY" });
    const b = classificationIdentityKey({ description: "LED TUBE LAMP 120CM 18W EL SEWEEDY" });
    expect(a).toBe(b);
    expect(a?.startsWith("ds:")).toBe(true);
  });

  it("matches the same item worded in a different order", () => {
    const a = classificationIdentityKey({ description: "CABLE 3X2.5 MM COPPER" });
    const b = classificationIdentityKey({ description: "COPPER CABLE 3X2.5 MM" });
    expect(a).toBe(b); // tokens are sorted
  });

  it("keeps a size difference as two distinct identities", () => {
    const a = classificationIdentityKey({ description: "CABLE 50 MM COPPER CORE" });
    const b = classificationIdentityKey({ description: "CABLE 70 MM COPPER CORE" });
    expect(a).not.toBe(b); // a 50mm cable is not a 70mm cable
  });

  it("refuses a signature when the description is too short to identify", () => {
    // «CABLE» alone says nothing about WHICH cable — no memory may be keyed on it.
    expect(descriptionSignature("CABLE")).toBeNull();
    expect(classificationIdentityKey({ description: "CABLE" })).toBeNull();
  });

  it("needs at least MIN_SIGNATURE_TOKENS content tokens", () => {
    expect(MIN_SIGNATURE_TOKENS).toBeGreaterThanOrEqual(3);
    expect(descriptionSignature("A B")).toBeNull();
    expect(descriptionSignature("A B C")).not.toBeNull();
  });

  it("uses the line item only as a namespaced last resort", () => {
    const k = classificationIdentityKey({ lineItem: "5720.010.GENRAL.7054" });
    expect(k?.startsWith("li:")).toBe(true);
    // A line-item key is namespaced so it can never collide with a part number.
    const pn = classificationIdentityKey({ partNo: "5720010GENRAL7054" });
    expect(pn).not.toBe(k);
  });

  it("prefers a STRUCTURED line item over a drifting description", () => {
    // The operator's LED-lamp case: no part number, identical line item, but the
    // printed description differs by a letter — the two rows MUST share a key, or
    // memory can never unify them.
    const a = classificationIdentityKey({
      partNo: null,
      lineItem: "5720.010.GENRAL.7054",
      description: "LED TUBE LAMP 120CM, 18W, 1750LM ( EL SEWEEDY )",
    });
    const b = classificationIdentityKey({
      partNo: null,
      lineItem: "5720.010.GENRAL.7054",
      description: "LED TUBE LAMP 120CM, 18W, 1750LM ( ELSEWEEDY )",
    });
    expect(a).toBe(b);
    expect(a?.startsWith("li:")).toBe(true);
  });

  it("keeps the description identity for free prose (no structured line item)", () => {
    const a = classificationIdentityKey({
      partNo: null,
      lineItem: "1",
      description: "CABLE 3X2.5 MM COPPER",
    });
    expect(a?.startsWith("ds:")).toBe(true);
  });

  it("returns null when the item carries no usable identity at all", () => {
    expect(classificationIdentityKey({})).toBeNull();
    expect(classificationIdentityKey({ description: "  " })).toBeNull();
  });
});
