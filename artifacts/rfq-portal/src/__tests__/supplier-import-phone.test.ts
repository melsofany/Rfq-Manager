import { describe, it, expect } from "vitest";
import {
  parsePhoneField,
  normalizeEgyptianMobile,
  looksLikeLandline,
} from "@/modules/users/pages/suppliers/import-tab";

// A tiny stand-in for the LanguageContext `t()`: it echoes the key and
// interpolates, so the assertions read the KEY (language-independent) rather
// than a translated sentence.
const t = (key: string, vars?: Record<string, string | number>): string => {
  if (!vars) return key;
  return Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key);
};

describe("supplier import — Egyptian phone parsing", () => {
  it("normalises a local mobile to the WhatsApp international form", () => {
    expect(normalizeEgyptianMobile("01012345678")).toBe("+201012345678");
    expect(normalizeEgyptianMobile("+20 101 234 5678")).toBe("+201012345678");
    expect(normalizeEgyptianMobile("1012345678")).toBe("+201012345678");
  });

  it("keeps at most two mobiles and flags the rest", () => {
    const r = parsePhoneField("01012345678 / 01112345678 / 01234567890", t);
    expect(r.primary).toBe("+201012345678");
    expect(r.secondary).toBe("+201112345678");
    expect(r.warning).toBe("supImp.warnKeptTwo");
    expect(r.willSkip).toBe(false);
  });

  it("rejects a landline-only value and marks it for skipping", () => {
    expect(looksLikeLandline("0223456789")).toBe(true);
    const r = parsePhoneField("0223456789", t);
    expect(r.primary).toBeNull();
    expect(r.warning).toBe("supImp.warnLandlineOnly");
    // The regression this guards: a row that yields no usable phone must be
    // deselected automatically, which the UI decides from `willSkip`.
    expect(r.willSkip).toBe(true);
  });

  it("keeps the mobile and reports the dropped landline when both are present", () => {
    const r = parsePhoneField("0223456789, 01012345678", t);
    expect(r.primary).toBe("+201012345678");
    expect(r.warning).toBe("supImp.warnLandlineDropped");
    expect(r.willSkip).toBe(false);
  });

  it("marks an unrecognised format for skipping", () => {
    const r = parsePhoneField("1234567", t);
    expect(r.warning).toBe("supImp.warnUnknown");
    expect(r.willSkip).toBe(true);
  });

  it("returns no warning and no skip for an empty value", () => {
    const r = parsePhoneField("", t);
    expect(r).toEqual({ primary: null, secondary: null, warning: null, willSkip: false });
  });
});
