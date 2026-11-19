// Validation for notes recorded against a supplier. Pure, so it can be tested
// without a database. The route still checks that a PO line belongs to the supplier.
export const SUPPLIER_NOTE_REASONS = [
  "wrong_price",
  "unrequested_item",
  "wrong_qty",
  "late_delivery",
  "quality",
  "other",
] as const;

export type SupplierNoteReason = (typeof SUPPLIER_NOTE_REASONS)[number];

export type SupplierNoteInput = {
  reason: SupplierNoteReason;
  poItemId: number | null;
  text: string | null;
};

export function parseSupplierNoteInput(
  body: unknown,
): { ok: true; value: SupplierNoteInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const reason = typeof b.reason === "string" ? b.reason : "";
  if (!(SUPPLIER_NOTE_REASONS as readonly string[]).includes(reason)) {
    return { ok: false, error: "reason is invalid" };
  }

  let poItemId: number | null = null;
  if (b.poItemId != null && b.poItemId !== "") {
    const n = Number(b.poItemId);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, error: "poItemId must be a positive integer" };
    }
    poItemId = n;
  }

  const text = typeof b.text === "string" && b.text.trim() ? b.text.trim().slice(0, 2000) : null;
  return { ok: true, value: { reason: reason as SupplierNoteReason, poItemId, text } };
}
