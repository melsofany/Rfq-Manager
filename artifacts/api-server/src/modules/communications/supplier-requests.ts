import { db, suppliersTable, sentLogTable, rfqTable, employeesTable } from "@workspace/db";
import { and, eq, ne, ilike } from "drizzle-orm";
import { logger } from "../../shared/logger";

/**
 * Supplier-facing request lookups, shared by the WhatsApp bot.
 *
 * These are BUSINESS logic, not console plumbing: which requests a supplier has
 * open, which employee owns one, and which request a reply answers. They lived
 * These drive the supplier bot, so they must not live in the console layer.
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

export interface OpenRequest {
  rfqId: number;
  internalRfqNo: string;
  employeeId: number | null;
  employeeName: string | null;
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

/**
 * Open pricing requests for a supplier: sent to them, not yet answered, and not
 * failed. This is the list the console bot offers as buttons, and what decides
 * which conversation an inbound message belongs to.
 */
export async function openPricingRequestsForSupplier(supplierId: number): Promise<OpenRequest[]> {
  try {
    const rows = await db
      .select({
        rfqId: sentLogTable.rfqId,
        internalRfqNo: rfqTable.internalRfqNo,
        employeeId: sentLogTable.employeeId,
        employeeName: employeesTable.name,
      })
      .from(sentLogTable)
      .innerJoin(rfqTable, eq(sentLogTable.rfqId, rfqTable.id))
      .leftJoin(employeesTable, eq(sentLogTable.employeeId, employeesTable.id))
      .where(
        and(
          eq(sentLogTable.supplierId, supplierId),
          eq(sentLogTable.offerSubmitted, false),
          ne(rfqTable.status, "FAILED"),
        ),
      );
    return rows.map((r) => ({
      rfqId: r.rfqId,
      internalRfqNo: r.internalRfqNo,
      employeeId: r.employeeId ?? null,
      employeeName: r.employeeName ?? null,
    }));
  } catch (err) {
    logger.warn({ err, supplierId }, "Open-request lookup failed");
    return [];
  }
}

/**
 * The employee responsible for one request sent to one supplier.
 *
 * The bot needs this to hand a conversation over: the same `sent_log` row that
 * authorises the supplier also names the owner. A missing owner is not an error
 * — it means the request was sent without an employee attached, and the reply
 * still belongs in the thread.
 */
export async function responsibleEmployeeFor(
  supplierId: number,
  rfqId: number,
): Promise<{ employeeId: number | null; employeeName: string | null } | null> {
  try {
    const [row] = await db
      .select({ employeeId: sentLogTable.employeeId, employeeName: employeesTable.name })
      .from(sentLogTable)
      .leftJoin(employeesTable, eq(sentLogTable.employeeId, employeesTable.id))
      .where(and(eq(sentLogTable.supplierId, supplierId), eq(sentLogTable.rfqId, rfqId)))
      .limit(1);
    if (!row) return null;
    return { employeeId: row.employeeId ?? null, employeeName: row.employeeName ?? null };
  } catch (err) {
    logger.warn({ err, supplierId, rfqId }, "Responsible-employee lookup failed");
    return null;
  }
}

/**
 * Decide which request an inbound supplier message answers.
 *
 * Order matters. An explicit request number in the text is authoritative — the
 * supplier telling us which request they mean must never be overruled. Failing
 * that, a supplier with exactly ONE open request is unambiguous. Anything else
 * is ambiguous on purpose: the caller must ask rather than guess, because
 * attributing a reply to the wrong request silently misfiles a price.
 */
export function pickRequestFromText(
  text: string,
  open: OpenRequest[],
): { rfqId: number; ambiguous: false } | { rfqId: null; ambiguous: true } {
  // Compare on alphanumerics only: a supplier retyping the number in WhatsApp
  // drops the separators («RFQ 2026 000222» for «RFQ-2026-000222»), and a
  // separator-sensitive match would miss the very reply naming its request.
  const squeeze = (s: string) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const norm = squeeze(text);
  const explicit = open.find((r) => norm.includes(squeeze(r.internalRfqNo)));
  if (explicit) return { rfqId: explicit.rfqId, ambiguous: false };
  if (open.length === 1) return { rfqId: open[0].rfqId, ambiguous: false };
  return { rfqId: null, ambiguous: true };
}
