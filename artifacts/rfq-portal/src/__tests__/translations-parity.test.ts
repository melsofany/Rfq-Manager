import { describe, it, expect } from "vitest";
import translations from "@/i18n/translations";

/**
 * The suppliers screen must work in BOTH languages — the operator asked for
 * Arabic and English explicitly. A key present in one dictionary and missing
 * from the other renders the raw key («sup.col.supplier») to the user, which is
 * exactly the «مش مفهموم» complaint. This guards the whole dictionary, not just
 * the suppliers keys, so no screen can drift.
 */
describe("translations — Arabic and English stay in step", () => {
  const en = Object.keys(translations.en);
  const ar = Object.keys(translations.ar);

  it("every English key has an Arabic translation", () => {
    const missing = en.filter((k) => !(k in translations.ar));
    expect(missing).toEqual([]);
  });

  it("every Arabic key has an English translation", () => {
    const missing = ar.filter((k) => !(k in translations.en));
    expect(missing).toEqual([]);
  });

  it("no translation is empty in either language", () => {
    const empties = [...en, ...ar].filter(
      (k) => !(translations.en[k] ?? "").trim() || !(translations.ar[k] ?? "").trim(),
    );
    expect(empties).toEqual([]);
  });

  it("the suppliers screen has both languages for every key it uses", () => {
    const supKeys = en.filter((k) => k.startsWith("sup."));
    expect(supKeys.length).toBeGreaterThan(20);
    for (const k of supKeys) {
      expect(translations.ar[k], `Arabic missing for ${k}`).toBeTruthy();
      expect(translations.en[k], `English missing for ${k}`).toBeTruthy();
    }
  });

  it("supplier evidence badges read as real words, not keys, in both languages", () => {
    for (const key of ["sup.evidence.ordered", "sup.evidence.quoted", "sup.evidence.manual"]) {
      expect(translations.en[key]).not.toBe(key);
      expect(translations.ar[key]).not.toBe(key);
      // Arabic must actually be Arabic, English must not be.
      expect(/[\u0600-\u06FF]/.test(translations.ar[key])).toBe(true);
      expect(/[\u0600-\u06FF]/.test(translations.en[key])).toBe(false);
    }
  });
});
