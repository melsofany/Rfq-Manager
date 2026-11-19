import { describe, expect, it } from "vitest";
import { parseSupplierNoteInput } from "../../shared/supplier-notes";

describe("parseSupplierNoteInput", () => {
  it("rejects an unknown or missing reason", () => {
    expect(parseSupplierNoteInput({}).ok).toBe(false);
    expect(parseSupplierNoteInput({ reason: "rude" }).ok).toBe(false);
  });

  it("accepts a supplier-level note with no line", () => {
    expect(parseSupplierNoteInput({ reason: "quality" })).toEqual({
      ok: true,
      value: { reason: "quality", poItemId: null, text: null },
    });
  });

  it("parses a line id and trims the text", () => {
    expect(
      parseSupplierNoteInput({ reason: "wrong_price", poItemId: "42", text: "  السعر غلط  " }),
    ).toEqual({
      ok: true,
      value: { reason: "wrong_price", poItemId: 42, text: "السعر غلط" },
    });
  });

  it("treats blank text and an empty line as absent", () => {
    expect(parseSupplierNoteInput({ reason: "other", poItemId: "", text: "   " })).toEqual({
      ok: true,
      value: { reason: "other", poItemId: null, text: null },
    });
  });

  it("rejects a line id that is not a positive integer", () => {
    expect(parseSupplierNoteInput({ reason: "other", poItemId: "abc" }).ok).toBe(false);
    expect(parseSupplierNoteInput({ reason: "other", poItemId: 1.5 }).ok).toBe(false);
    expect(parseSupplierNoteInput({ reason: "other", poItemId: 0 }).ok).toBe(false);
  });

  it("caps the text at 2000 characters", () => {
    const r = parseSupplierNoteInput({ reason: "other", text: "x".repeat(3000) });
    expect(r.ok && r.value.text?.length).toBe(2000);
  });
});
