import { db, suppliersTable } from "@workspace/db";
import { ilike } from "drizzle-orm";
import { logger } from "../../shared/logger";

/**
 * Resolve the supplier behind an inbound phone number.
 *
 * Shared by the inbound webhook and the representative bot (a number that is
 * both a rep and a supplier keeps its rep behaviour). The supplier-facing bot
 * that used to browse a supplier's open requests was removed; this lookup
 * remains because identifying the sender is not a bot feature.
 */

/** Digits-only canonical phone, matching the form Meta sends. */
export function canonicalPhone(phone: string): string {
  let c = (phone || "").replace(/[^\d]/g, "");
  if (c.startsWith("00")) c = c.slice(2);
  // A LOCAL Egyptian number: mobile `010…` (11 digits) and landline `02…`
  // (10 digits) both carry a trunk `0`, which is dropped in the international
  // form. The landline branch was missing, so `0227538195` stayed local and
  // Meta sends the international form, so a local number must be widened.
  if (c.startsWith("0")) c = "2" + c;
  // A bare mobile without the trunk zero (`1000000000`).
  else if (c.length === 10 && c.startsWith("1")) c = "20" + c;
  return c;
}

/** Resolve the supplier behind a phone number, comparing canonical forms. */
export async function supplierByPhone(phone: string): Promise<{
  id: number;
  name: string;
  phone: string | null;
} | null> {
  const target = canonicalPhone(phone);
  if (!target) return null;
  const tail = target.slice(-9);
  try {
    const rows = await db
      .select({ id: suppliersTable.id, name: suppliersTable.name, phone: suppliersTable.phone })
      .from(suppliersTable)
      .where(ilike(suppliersTable.phone, `%${tail}%`))
      .limit(5);
    return rows.find((r) => canonicalPhone(r.phone ?? "") === target) ?? null;
  } catch (err) {
    logger.warn({ err, phone }, "Supplier lookup by phone failed");
    return null;
  }
}
