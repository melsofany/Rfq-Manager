/**
 * Item assignment routes — إسناد البنود
 *
 *   GET   /rfq/:id/assignments              — assignments for an RFQ's items
 *   POST  /rfq/:id/assignments/ensure       — (re)run auto-classify + assign
 *   PATCH /rfq/items/:itemId/assignment     — manual override (audited)
 *
 * Read routes need only requireAuth; the manual override is available to any
 * authenticated procurement user (they own the decision) and is audited.
 */
import { Router } from "express";
import {
  db,
  rfqItemsTable,
  rfqItemAssignmentsTable,
  customerRfqItemsTable,
  customerRfqItemAssignmentsTable,
  itemCategoriesTable,
  employeesTable,
  auditLogTable,
} from "@workspace/db";
import { and, eq, inArray, asc, isNull } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import {
  assignItemManually,
  ensureAssignmentsForRfq,
  ensureAssignmentsForRfqSafe,
} from "./assignment";
import {
  assignCustomerItemManually,
  ensureCustomerAssignments,
  responsibleForRfqItem,
} from "./customer-assignment";

const router = Router();

const ASSIGN_PERM_KEY = "rfq:assign";
// Mirrors the portal's ROLE_DEFAULTS: manager + purchasing own the decision.
const ASSIGN_ROLE_DEFAULT: Record<string, boolean> = { manager: true, purchasing: true };

/**
 * Whether the requester may assign / re-assign an RFQ item. Admin is always
 * privileged; otherwise an explicit `rfq:assign` grant is authoritative, else
 * the role default. Reads permissions fresh so a grant/revoke applies without a
 * re-login. Kept in sync with `artifacts/rfq-portal/src/lib/permissions.ts`.
 */
export async function hasAssignAccess(req: any): Promise<boolean> {
  if (req.session?.role === "admin") return true;
  const employeeId = req.session?.employeeId;
  if (!employeeId) return false;
  const [emp] = await db
    .select({ permissions: employeesTable.permissions })
    .from(employeesTable)
    .where(eq(employeesTable.id, employeeId));
  const explicit = emp?.permissions as Record<string, boolean> | null | undefined;
  if (explicit && typeof explicit === "object" && Object.keys(explicit).length) {
    return explicit[ASSIGN_PERM_KEY] === true;
  }
  return ASSIGN_ROLE_DEFAULT[req.session?.role ?? ""] === true;
}

router.get("/rfq/:id/assignments", requireAuth, async (req, res): Promise<void> => {
  const rfqId = parseInt(req.params.id as string, 10);

  const items = await db
    .select({
      id: rfqItemsTable.id,
      lineItem: rfqItemsTable.lineItem,
      partNo: rfqItemsTable.partNo,
      description: rfqItemsTable.description,
      categoryId: rfqItemsTable.categoryId,
    })
    .from(rfqItemsTable)
    .where(eq(rfqItemsTable.rfqId, rfqId))
    .orderBy(asc(rfqItemsTable.id));

  if (items.length === 0) {
    res.json([]);
    return;
  }

  const itemIds = items.map((i) => i.id);
  const assignmentRows = await db
    .select({
      rfqItemId: rfqItemAssignmentsTable.rfqItemId,
      categoryId: rfqItemAssignmentsTable.categoryId,
      employeeId: rfqItemAssignmentsTable.employeeId,
      source: rfqItemAssignmentsTable.source,
      confidence: rfqItemAssignmentsTable.confidence,
      employeeName: employeesTable.name,
      categoryName: itemCategoriesTable.name,
    })
    .from(rfqItemAssignmentsTable)
    .leftJoin(employeesTable, eq(rfqItemAssignmentsTable.employeeId, employeesTable.id))
    .leftJoin(itemCategoriesTable, eq(rfqItemAssignmentsTable.categoryId, itemCategoriesTable.id))
    .where(inArray(rfqItemAssignmentsTable.rfqItemId, itemIds));
  const byItem = new Map(assignmentRows.map((a) => [a.rfqItemId, a]));

  res.json(
    items.map((it) => {
      const a = byItem.get(it.id);
      const categoryId = a?.categoryId ?? it.categoryId ?? null;
      return {
        rfqItemId: it.id,
        lineItem: it.lineItem,
        partNo: it.partNo,
        description: it.description,
        categoryId,
        categoryName: a?.categoryName ?? null,
        employeeId: a?.employeeId ?? null,
        employeeName: a?.employeeName ?? null,
        source: a?.source ?? null,
        confidence: a?.confidence != null ? Number(a.confidence) : null,
        // Never assigned when the category is unknown — surfaced explicitly so
        // the UI can flag it instead of silently showing a blank cell.
        unclassified: categoryId == null,
        unassigned: (a?.employeeId ?? null) == null,
      };
    }),
  );
});

router.post("/rfq/:id/assignments/ensure", requireAuth, async (req, res): Promise<void> => {
  if (!(await hasAssignAccess(req))) {
    res
      .status(403)
      .json({ error: "غير مصرح — إسناد البنود متاح للمشتريات أو لمن مُنح صلاحية الإسناد" });
    return;
  }
  const rfqId = parseInt(req.params.id as string, 10);
  const outcomes = await ensureAssignmentsForRfq(rfqId);
  res.json({ outcomes });
});

router.patch("/rfq/items/:itemId/assignment", requireAuth, async (req, res): Promise<void> => {
  if (!(await hasAssignAccess(req))) {
    res
      .status(403)
      .json({ error: "غير مصرح — إسناد البنود متاح للمشتريات أو لمن مُنح صلاحية الإسناد" });
    return;
  }
  const rfqItemId = parseInt(req.params.itemId as string, 10);
  const { categoryId, employeeId } = req.body as {
    categoryId?: number | null;
    employeeId?: number | null;
  };

  try {
    await assignItemManually({
      rfqItemId,
      categoryId: categoryId ?? null,
      employeeId: employeeId ?? null,
      assignedBy: req.session.employeeId ?? null,
    });
  } catch {
    res.status(404).json({ error: "البند غير موجود" });
    return;
  }

  await db.insert(auditLogTable).values({
    action: "rfq_item.assignment_changed",
    entityType: "rfq_item",
    entityId: rfqItemId,
    employeeId: req.session.employeeId,
    description: `Item ${rfqItemId} → category ${categoryId ?? "(none)"} / employee ${employeeId ?? "(none)"}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.json({ ok: true });
});

/** Convenience alias so a create flow can fire-and-forget. */
export async function ensureForRfq(rfqId: number): Promise<void> {
  return ensureAssignmentsForRfqSafe(rfqId);
}

// ── Customer-item assignments (source of truth) ─────────────────────────────

/**
 * GET /customer-rfq/:id/assignments
 * Responsibility for each of the customer RFQ's items, with an explicit status
 * so the UI never shows a blank cell for an unclassified / unassigned item.
 */
router.get("/customer-rfq/:id/assignments", requireAuth, async (req, res): Promise<void> => {
  const customerRfqId = parseInt(req.params.id as string, 10);

  const items = await db
    .select({
      id: customerRfqItemsTable.id,
      lineItem: customerRfqItemsTable.lineItem,
      partNo: customerRfqItemsTable.partNo,
      description: customerRfqItemsTable.description,
      categoryId: customerRfqItemsTable.categoryId,
    })
    .from(customerRfqItemsTable)
    .where(eq(customerRfqItemsTable.customerRfqId, customerRfqId))
    .orderBy(asc(customerRfqItemsTable.id));

  if (items.length === 0) {
    res.json([]);
    return;
  }

  const assignmentRows = await db
    .select({
      customerRfqItemId: customerRfqItemAssignmentsTable.customerRfqItemId,
      categoryId: customerRfqItemAssignmentsTable.categoryId,
      employeeId: customerRfqItemAssignmentsTable.employeeId,
      source: customerRfqItemAssignmentsTable.source,
      confidence: customerRfqItemAssignmentsTable.confidence,
      employeeName: employeesTable.name,
      categoryName: itemCategoriesTable.name,
    })
    .from(customerRfqItemAssignmentsTable)
    .leftJoin(employeesTable, eq(customerRfqItemAssignmentsTable.employeeId, employeesTable.id))
    .leftJoin(
      itemCategoriesTable,
      eq(customerRfqItemAssignmentsTable.categoryId, itemCategoriesTable.id),
    )
    .where(
      and(
        inArray(
          customerRfqItemAssignmentsTable.customerRfqItemId,
          items.map((i) => i.id),
        ),
        isNull(customerRfqItemAssignmentsTable.validTo),
      ),
    );
  const byItem = new Map(assignmentRows.map((a) => [a.customerRfqItemId, a]));

  res.json(
    items.map((it) => {
      const a = byItem.get(it.id);
      const categoryId = a?.categoryId ?? it.categoryId ?? null;
      const employeeId = a?.employeeId ?? null;
      // Four explicit states (القرار 5-ج): never a blank cell.
      let status: "unclassified" | "classified_unassigned" | "assigned" | "needs_review";
      if (categoryId == null) status = "unclassified";
      else if (employeeId == null) status = "classified_unassigned";
      else if (a?.source === "auto" && a?.confidence != null && Number(a.confidence) < 60)
        status = "needs_review";
      else status = "assigned";
      return {
        customerRfqItemId: it.id,
        lineItem: it.lineItem,
        partNo: it.partNo,
        description: it.description,
        categoryId,
        categoryName: a?.categoryName ?? null,
        employeeId,
        employeeName: a?.employeeName ?? null,
        source: a?.source ?? null,
        confidence: a?.confidence != null ? Number(a.confidence) : null,
        status,
        unclassified: categoryId == null,
        unassigned: employeeId == null,
      };
    }),
  );
});

/** POST /customer-rfq/:id/assignments/ensure — (re)run auto-classify + assign. */
router.post(
  "/customer-rfq/:id/assignments/ensure",
  requireAuth,
  async (req, res): Promise<void> => {
    if (!(await hasAssignAccess(req))) {
      res
        .status(403)
        .json({ error: "غير مصرح — إسناد البنود متاح للمشتريات أو لمن مُنح صلاحية الإسناد" });
      return;
    }
    const customerRfqId = parseInt(req.params.id as string, 10);
    const outcomes = await ensureCustomerAssignments(customerRfqId);
    res.json({ outcomes });
  },
);

/** PATCH /customer-rfq/items/:itemId/assignment — manual override (audited). */
router.patch(
  "/customer-rfq/items/:itemId/assignment",
  requireAuth,
  async (req, res): Promise<void> => {
    if (!(await hasAssignAccess(req))) {
      res
        .status(403)
        .json({ error: "غير مصرح — إسناد البنود متاح للمشتريات أو لمن مُنح صلاحية الإسناد" });
      return;
    }
    const customerRfqItemId = parseInt(req.params.itemId as string, 10);
    const { categoryId, employeeId, reason } = req.body as {
      categoryId?: number | null;
      employeeId?: number | null;
      reason?: string | null;
    };

    try {
      await assignCustomerItemManually({
        customerRfqItemId,
        categoryId: categoryId ?? null,
        employeeId: employeeId ?? null,
        assignedBy: req.session.employeeId ?? null,
        reason: reason ?? null,
      });
    } catch {
      res.status(404).json({ error: "البند غير موجود" });
      return;
    }

    await db.insert(auditLogTable).values({
      action: "customer_rfq_item.assignment_changed",
      entityType: "customer_rfq_item",
      entityId: customerRfqItemId,
      employeeId: req.session.employeeId,
      description: `Customer item ${customerRfqItemId} → category ${categoryId ?? "(none)"} / employee ${employeeId ?? "(none)"}`,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    res.json({ ok: true });
  },
);

export { responsibleForRfqItem };

export default router;
