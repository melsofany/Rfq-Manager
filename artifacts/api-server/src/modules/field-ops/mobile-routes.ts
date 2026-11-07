/**
 * الاستلامات والتسليمات — /api/mobile/pickups · /api/mobile/deliveries
 *
 * All quantity rules, ownership rules and idempotency checks are enforced HERE,
 * never in the Android UI. The app only renders what these routes allow.
 *
 *   GET  /pickups                 assigned supplier pickups (consolidated items)
 *   GET  /pickups/:id             one pickup task with its items
 *   POST /pickups/:id/confirm     record a receipt (full or partial)
 *   GET  /deliveries              assigned customer deliveries
 *   GET  /deliveries/:id          one delivery task with its items
 *   POST /deliveries/:id/confirm  record a delivery (full or partial)
 *   GET  /history                 the employee's own operation history
 */
import { Router } from "express";
import crypto from "node:crypto";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db,
  purchaseOrdersTable,
  purchaseOrderItemsTable,
  suppliersTable,
  customerPosTable,
  customerPoItemsTable,
  poItemReceiptsTable,
  customerPoItemDeliveriesTable,
  workOrderAssignmentsTable,
  customersTable,
  hrEmployeesTable,
  WORK_ORDER_KIND,
} from "@workspace/db";
import { requireMobileAuth, requireMobileOperationsEnabled, actorOf } from "./mobile-auth";
import {
  authorizeTaskExecution,
  checkReceiptQuantities,
  checkDeliveryQuantities,
  type DelegationRow,
} from "./assignment-logic";
import {
  consolidatePickupLines,
  customerPoNosOf,
  hasOutstandingQty,
  type PickupLine,
} from "./consolidation";
import {
  hasActiveFieldAssignment,
  visibleAssignmentsFor,
  notify,
  auditFieldOperation,
  loadFieldOpsSettings,
} from "./service";
import { paymentStatusByPair } from "./payment-status";
import { recomputeItemTotals } from "../po/receipts";
import {
  acceptedQtyFromSupplier,
  recomputeItemTotals as recomputeDeliveryTotals,
} from "../customer-po/deliveries";
import { applyDeliverySideEffects, applyReceiptSideEffects } from "../communications/routes";
import { workOrderDelegationsTable } from "@workspace/db";
import { logger } from "../../shared/logger";

const router = Router();
router.use(requireMobileAuth);
router.use(requireMobileOperationsEnabled);

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/** Load the delegations for an assignment and shape them for the pure logic. */
async function delegationsFor(assignmentId: number) {
  const rows = await db
    .select()
    .from(workOrderDelegationsTable)
    .where(eq(workOrderDelegationsTable.assignmentId, assignmentId));
  return rows.map((d) => ({
    id: d.id,
    toHrEmployeeId: d.toHrEmployeeId,
    status: d.status,
    scope: d.scope,
    startsAt: d.startsAt,
    endsAt: d.endsAt,
  })) as (DelegationRow & { toHrEmployeeId: number; id: number })[];
}

/** Fetch one assignment, or null. */
async function loadAssignment(id: number) {
  const [row] = await db
    .select()
    .from(workOrderAssignmentsTable)
    .where(eq(workOrderAssignmentsTable.id, id))
    .limit(1);
  return row ?? null;
}

/** Authorise the caller against an assignment, returning 403 payload on failure. */
async function authorize(
  req: Parameters<typeof actorOf>[0],
  assignment: {
    id: number;
    kind: string;
    hrEmployeeId: number | null;
  },
) {
  const actor = actorOf(req);
  const [hasAssignment, delegations] = await Promise.all([
    hasActiveFieldAssignment(actor.hrEmployeeId),
    delegationsFor(assignment.id),
  ]);
  return authorizeTaskExecution({
    employeeId: actor.hrEmployeeId,
    kind: assignment.kind,
    assignmentHrEmployeeId: assignment.hrEmployeeId,
    hasActiveFieldAssignment: hasAssignment,
    delegations,
    now: new Date(),
  });
}

// ── Pickups ─────────────────────────────────────────────────────────────────

/** Build consolidated pickup groups for the given assignments. */
async function buildPickupGroups(
  assignmentIds: number[],
  opts: { includeCompleted?: boolean } = {},
) {
  if (!assignmentIds.length) return [];
  const assignments = await db
    .select()
    .from(workOrderAssignmentsTable)
    .where(
      and(
        eq(workOrderAssignmentsTable.kind, WORK_ORDER_KIND.RECEIPT),
        inArray(workOrderAssignmentsTable.id, assignmentIds),
      ),
    );
  const poItemIds = assignments.map((a) => a.poItemId).filter((x): x is number => x != null);
  if (!poItemIds.length) return [];

  const lines = await db
    .select({
      poItemId: purchaseOrderItemsTable.id,
      poId: purchaseOrderItemsTable.poId,
      poNo: purchaseOrdersTable.internalPoNo,
      supplierId: purchaseOrderItemsTable.supplierId,
      supplierName: suppliersTable.name,
      itemId: purchaseOrderItemsTable.itemId,
      lineItem: purchaseOrderItemsTable.lineItem,
      partNo: purchaseOrderItemsTable.partNo,
      description: purchaseOrderItemsTable.description,
      uom: purchaseOrderItemsTable.uom,
      qty: purchaseOrderItemsTable.qty,
      accepted: purchaseOrderItemsTable.totalAcceptedQty,
      lineStatus: purchaseOrderItemsTable.lineStatus,
      customerPoItemId: purchaseOrderItemsTable.customerPoItemId,
    })
    .from(purchaseOrderItemsTable)
    .innerJoin(purchaseOrdersTable, eq(purchaseOrderItemsTable.poId, purchaseOrdersTable.id))
    .leftJoin(suppliersTable, eq(purchaseOrderItemsTable.supplierId, suppliersTable.id))
    .where(inArray(purchaseOrderItemsTable.id, poItemIds));

  // A line whose ordered quantity is fully accepted has nothing left to receive.
  // Keeping it in the list left a confirmed task looking outstanding forever,
  // so the rep could re-open it and be told there was nothing to receive. The
  // assignment row is untouched — history and the detail screen still see it.
  const activeLines = opts.includeCompleted
    ? lines
    : lines.filter((l) => hasOutstandingQty(toNum(l.qty), toNum(l.accepted) ?? 0));
  if (!activeLines.length) return [];

  // Resolve the customer PO numbers for the linked customer PO items, so the
  // allocation line shows «SPO-001 → P26E001 → 2» without extra round-trips.
  const customerPoItemIds = activeLines
    .map((l) => l.customerPoItemId)
    .filter((x): x is number => x != null);
  const cpMap = new Map<number, string>();
  if (customerPoItemIds.length) {
    const rows = await db
      .select({
        id: customerPoItemsTable.id,
        poNo: customerPosTable.customerPoNo,
      })
      .from(customerPoItemsTable)
      .innerJoin(customerPosTable, eq(customerPoItemsTable.customerPoId, customerPosTable.id))
      .where(inArray(customerPoItemsTable.id, customerPoItemIds));
    for (const r of rows) cpMap.set(r.id, r.poNo);
  }

  const pickupLines: PickupLine[] = activeLines.map((l) => {
    const qty = toNum(l.qty) ?? 0;
    const accepted = toNum(l.accepted) ?? 0;
    const cpNo = l.customerPoItemId != null ? cpMap.get(l.customerPoItemId) : undefined;
    return {
      poItemId: l.poItemId,
      poId: l.poId,
      poNo: l.poNo,
      supplierId: l.supplierId,
      itemId: l.itemId,
      lineItem: l.lineItem,
      partNo: l.partNo,
      description: l.description,
      uom: l.uom,
      qty,
      acceptedQty: accepted,
      remainingQty: Math.max(0, Math.round((qty - accepted) * 10000) / 10000),
      lineStatus: l.lineStatus,
      customerPoNos: cpNo ? [cpNo] : [],
      customerPoItemIds: l.customerPoItemId != null ? [l.customerPoItemId] : [],
    };
  });

  return consolidatePickupLines(pickupLines).map((g) => ({
    ...g,
    customerPoNos: customerPoNosOf(g),
  }));
}

/**
 * After a receipt, tell the representative(s) who own the delivery tasks for the
 * customer lines that were just fulfilled. Only tasks that actually became
 * deliverable (accepted qty > 0 on a linked customer line) are notified, so a
 * rejected-only receipt never produces a phantom "ready to deliver" message.
 */
async function notifyDeliveryAvailability(
  assignment: { poId: number },
  executorName: string,
  enabled: boolean,
): Promise<void> {
  if (!enabled) return;
  // Customer lines fulfilled by this supplier PO's received items.
  const lines = await db
    .select({ customerPoItemId: purchaseOrderItemsTable.customerPoItemId })
    .from(purchaseOrderItemsTable)
    .where(
      and(
        eq(purchaseOrderItemsTable.poId, assignment.poId),
        isNotNull(purchaseOrderItemsTable.customerPoItemId),
      ),
    );
  const customerItemIds = lines
    .map((l) => l.customerPoItemId)
    .filter((x): x is number => x != null);
  if (!customerItemIds.length) return;

  const deliveryTasks = await db
    .select({
      id: workOrderAssignmentsTable.id,
      hrEmployeeId: workOrderAssignmentsTable.hrEmployeeId,
      status: workOrderAssignmentsTable.status,
    })
    .from(workOrderAssignmentsTable)
    .where(
      and(
        eq(workOrderAssignmentsTable.kind, WORK_ORDER_KIND.DELIVERY),
        inArray(workOrderAssignmentsTable.customerPoItemId, customerItemIds),
        inArray(workOrderAssignmentsTable.status, ["sent", "assigned", "pending"]),
      ),
    );

  const notified = new Set<number>();
  for (const t of deliveryTasks) {
    if (!t.hrEmployeeId || notified.has(t.hrEmployeeId)) continue;
    notified.add(t.hrEmployeeId);
    await notify(t.hrEmployeeId, {
      kind: "delivery_available",
      title: "أصبح هناك بند متاح للتسليم",
      body: `تم استلام بند من المورد بواسطة ${executorName} وأصبح متاحاً للتسليم للعميل`,
      entityType: "assignment",
      entityId: t.id,
    });
  }
}

router.get("/pickups", async (req, res): Promise<void> => {
  const actor = actorOf(req);
  const { assignmentIds } = await visibleAssignmentsFor(actor.hrEmployeeId, "receipt");
  const groups = await buildPickupGroups(assignmentIds);

  // Supplier headers: one card per supplier PO, as the rep actually visits.
  const assignments = assignmentIds.length
    ? await db
        .select()
        .from(workOrderAssignmentsTable)
        .where(inArray(workOrderAssignmentsTable.id, assignmentIds))
    : [];
  const poIds = [...new Set(assignments.map((a) => a.poId))];
  const poRows = poIds.length
    ? await db
        .select({
          id: purchaseOrdersTable.id,
          poNo: purchaseOrdersTable.internalPoNo,
          status: purchaseOrdersTable.status,
          createdAt: purchaseOrdersTable.createdAt,
          notes: purchaseOrdersTable.notes,
        })
        .from(purchaseOrdersTable)
        .where(inArray(purchaseOrdersTable.id, poIds))
    : [];
  const poMap = new Map(poRows.map((p) => [p.id, p]));

  // Only POs that still have something to receive become tasks. A PO whose
  // lines are all fully accepted has nothing left to collect, so showing it
  // again sent the rep back to a screen with no rows to fill.
  const activePoIds = [...new Set(groups.flatMap((g) => g.allocations).map((a) => a.poId))];

  const supplierIds = [...new Set(assignments.map((a) => a.representativePhone).filter(Boolean))];
  void supplierIds;

  const supplierRows = groups.length
    ? await db
        .select({
          id: suppliersTable.id,
          name: suppliersTable.name,
          phone: suppliersTable.phone,
          address: suppliersTable.address,
          contactPerson: suppliersTable.contactPerson,
        })
        .from(suppliersTable)
    : [];
  const supplierMap = new Map(supplierRows.map((s) => [s.id, s]));

  // One task per supplier PO that still has lines to receive.
  const activePairs = activePoIds
    .map((poId) => {
      const groupLines = groups.flatMap((g) => g.allocations).filter((a) => a.poId === poId);
      const supplierId = groupLines[0]?.supplierId ?? null;
      return { poId, supplierId };
    })
    .filter((p): p is { poId: number; supplierId: number } => p.supplierId != null);
  const paymentStatus = await paymentStatusByPair(activePairs);

  const tasks = activePoIds.map((poId) => {
    const po = poMap.get(poId);
    const groupLines = groups.flatMap((g) => g.allocations).filter((a) => a.poId === poId);
    const supplierId = groupLines[0]?.supplierId ?? null;
    const supplier = supplierId != null ? supplierMap.get(supplierId) : undefined;
    const poGroups = groups.filter((g) => g.allocations.some((a) => a.poId === poId));
    return {
      assignmentId: assignments.find((a) => a.poId === poId)?.id ?? null,
      poId,
      poNo: po?.poNo ?? "",
      status: assignments.find((a) => a.poId === poId)?.status ?? "sent",
      // Settlement state only — deliberately no due/paid amounts. The
      // representative needs to know "should I go to this supplier", not the
      // company's ledger figures.
      paymentStatus:
        supplierId != null ? (paymentStatus.get(`${poId}:${supplierId}`) ?? "unpaid") : "unpaid",
      poDate: po?.createdAt?.toISOString() ?? null,
      notes: po?.notes ?? null,
      supplier: supplier
        ? {
            id: supplier.id,
            name: supplier.name,
            phone: supplier.phone,
            address: supplier.address,
            contactPerson: supplier.contactPerson,
          }
        : null,
      distinctItemCount: poGroups.length,
      totalRequiredQty:
        Math.round(
          poGroups.reduce(
            (s, g) =>
              s + g.allocations.filter((a) => a.poId === poId).reduce((x, a) => x + a.qty, 0),
            0,
          ) * 10000,
        ) / 10000,
    };
  });

  res.json({
    tasks,
    consolidatedItems: groups,
    summary: {
      taskCount: tasks.length,
      distinctItems: groups.length,
      totalRemainingQty:
        Math.round(groups.reduce((s, g) => s + g.totalRemainingQty, 0) * 10000) / 10000,
    },
  });
});

router.get("/pickups/:id", async (req, res): Promise<void> => {
  const actor = actorOf(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const assignment = await loadAssignment(id);
  if (!assignment || assignment.kind !== WORK_ORDER_KIND.RECEIPT) {
    res.status(404).json({ error: "المهمة غير موجودة" });
    return;
  }
  const auth = await authorize(req, assignment);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  // includeCompleted: the detail screen is also the receipt history — a fully
  // received line must stay visible there even though the list hides it.
  const groups = await buildPickupGroups([assignment.id], { includeCompleted: true });
  const [po] = await db
    .select({
      id: purchaseOrdersTable.id,
      poNo: purchaseOrdersTable.internalPoNo,
      notes: purchaseOrdersTable.notes,
      createdAt: purchaseOrdersTable.createdAt,
    })
    .from(purchaseOrdersTable)
    .where(eq(purchaseOrdersTable.id, assignment.poId));

  // Supplier of this PO (first line's supplier).
  const supplierId = groups.flatMap((g) => g.allocations)[0]?.supplierId ?? null;
  const supplier =
    supplierId != null
      ? (
          await db
            .select({
              id: suppliersTable.id,
              name: suppliersTable.name,
              phone: suppliersTable.phone,
              address: suppliersTable.address,
              contactPerson: suppliersTable.contactPerson,
            })
            .from(suppliersTable)
            .where(eq(suppliersTable.id, supplierId))
        )[0]
      : null;

  const paymentStatus =
    supplierId != null
      ? ((await paymentStatusByPair([{ poId: assignment.poId, supplierId }])).get(
          `${assignment.poId}:${supplierId}`,
        ) ?? "unpaid")
      : "unpaid";

  res.json({
    assignmentId: assignment.id,
    status: assignment.status,
    executorRole: auth.value?.role ?? "owner",
    po: po
      ? { id: po.id, poNo: po.poNo, notes: po.notes, poDate: po.createdAt.toISOString() }
      : null,
    supplier,
    paymentStatus,
    items: groups,
    // The responsible representative, for the accountability banner.
    responsibleEmployeeId: assignment.hrEmployeeId,
    representativeName: assignment.representativeName,
  });
});

interface ReceiptItemInput {
  poItemId: number;
  receivedQty?: number | string | null;
  acceptedQty?: number | string | null;
  rejectedQty?: number | string | null;
  rejectionReason?: string | null;
  notes?: string | null;
}

router.post("/pickups/:id/confirm", async (req, res): Promise<void> => {
  const actor = actorOf(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const assignment = await loadAssignment(id);
  if (!assignment || assignment.kind !== WORK_ORDER_KIND.RECEIPT) {
    res.status(404).json({ error: "المهمة غير موجودة" });
    return;
  }
  const auth = await authorize(req, assignment);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  const body = req.body as {
    items?: ReceiptItemInput[];
    clientUuid?: string;
    gps?: { lat?: number; lng?: number };
  };
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) {
    res.status(400).json({ error: "أدخل الكميات المستلمة" });
    return;
  }

  // Idempotency: a retried offline submission (same client UUID) is a no-op.
  const clientUuid = body.clientUuid ? String(body.clientUuid) : null;
  if (clientUuid) {
    const [existing] = await db
      .select({ id: poItemReceiptsTable.id })
      .from(poItemReceiptsTable)
      .where(eq(poItemReceiptsTable.clientUuid, clientUuid))
      .limit(1);
    if (existing) {
      res.json({ success: true, duplicate: true, receiptIds: [existing.id] });
      return;
    }
  }

  // Validate EVERY line before writing ANY — a partial write would corrupt the
  // totals and leave the PO in a state no operator asked for.
  const prepared: {
    poItemId: number;
    receivedQty: number;
    acceptedQty: number;
    rejectedQty: number;
    rejectionReason: string | null;
    receiptStatus: string;
  }[] = [];

  for (const item of items) {
    const poItemId = Number(item.poItemId);
    if (!Number.isInteger(poItemId)) {
      res.status(400).json({ error: "بند غير صالح في الطلب" });
      return;
    }
    const [line] = await db
      .select({
        id: purchaseOrderItemsTable.id,
        poId: purchaseOrderItemsTable.poId,
        qty: purchaseOrderItemsTable.qty,
        accepted: purchaseOrderItemsTable.totalAcceptedQty,
      })
      .from(purchaseOrderItemsTable)
      .where(eq(purchaseOrderItemsTable.id, poItemId));
    // The line must belong to the PO of this assignment — never another PO.
    if (!line || line.poId !== assignment.poId) {
      res.status(400).json({ error: "البند لا يتبع أمر الشراء الخاص بالمهمة" });
      return;
    }
    const receivedQty = toNum(item.receivedQty) ?? 0;
    const acceptedQty = toNum(item.acceptedQty) ?? receivedQty;
    const rejectedQty = toNum(item.rejectedQty) ?? 0;
    const check = checkReceiptQuantities({
      orderedQty: toNum(line.qty),
      alreadyAccepted: toNum(line.accepted) ?? 0,
      receivedQty,
      acceptedQty,
      rejectedQty,
    });
    if (!check.ok) {
      res.status(check.status).json({ error: check.error });
      return;
    }
    const receiptStatus =
      rejectedQty > 0 && acceptedQty === 0
        ? "rejected"
        : acceptedQty < receivedQty
          ? "partial"
          : "received";
    prepared.push({
      poItemId,
      receivedQty,
      acceptedQty,
      rejectedQty,
      rejectionReason: item.rejectionReason ? String(item.rejectionReason).slice(0, 500) : null,
      receiptStatus,
    });
  }

  const payloadHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(prepared.map((p) => ({ ...p })).sort((a, b) => a.poItemId - b.poItemId)))
    .digest("hex");

  const createdIds: number[] = [];
  for (const p of prepared) {
    const [row] = await db
      .insert(poItemReceiptsTable)
      .values({
        poItemId: p.poItemId,
        poId: assignment.poId,
        assignmentId: assignment.id,
        receivedQty: String(p.receivedQty),
        acceptedQty: String(p.acceptedQty),
        rejectedQty: p.rejectedQty ? String(p.rejectedQty) : null,
        rejectionReason: p.rejectionReason,
        receiptStatus: p.receiptStatus,
        receivedBy: actor.fullName,
        receivedByHrEmployeeId: actor.hrEmployeeId,
        gpsLat: body.gps?.lat != null ? String(body.gps.lat) : null,
        gpsLng: body.gps?.lng != null ? String(body.gps.lng) : null,
        clientUuid,
        payloadHash,
      })
      .returning({ id: poItemReceiptsTable.id });
    createdIds.push(row.id);
    await recomputeItemTotals(p.poItemId);
  }

  // Mark the assignment received and record the ACTUAL executor (which differs
  // from the responsible rep when the task was delegated).
  //
  // A partial receipt must NOT close the task. If it did, the rep could never
  // come back for the outstanding quantity — and the outstanding quantity is
  // exactly what a second visit is for. It becomes PARTIALLY_RECEIVED and stays
  // visible until every line in this submission is fully accepted.
  //
  // The check is scoped to the lines just submitted, not to the whole PO: an
  // assignment covers one supplier line, so a sibling line still outstanding on
  // the same PO must not keep this task open.
  const lineStates = await db
    .select({
      id: purchaseOrderItemsTable.id,
      qty: purchaseOrderItemsTable.qty,
      accepted: purchaseOrderItemsTable.totalAcceptedQty,
    })
    .from(purchaseOrderItemsTable)
    .where(
      inArray(
        purchaseOrderItemsTable.id,
        prepared.map((p) => p.poItemId),
      ),
    );
  const anyOutstanding = lineStates.some((l) =>
    hasOutstandingQty(toNum(l.qty), toNum(l.accepted) ?? 0),
  );
  await db
    .update(workOrderAssignmentsTable)
    .set({
      status: anyOutstanding ? "partially_received" : "received",
      performedByHrEmployeeId: actor.hrEmployeeId,
      updatedAt: new Date(),
    })
    .where(eq(workOrderAssignmentsTable.id, assignment.id));

  await auditFieldOperation({
    action: "mobile.receipt_confirmed",
    entityType: "po",
    entityId: assignment.poId,
    hrEmployeeId: actor.hrEmployeeId,
    description: `Receipt confirmed for assignment ${assignment.id} (PO ${assignment.poId}) by ${actor.fullName}; executor role ${auth.value?.role}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  // Rule 4: receiving is what makes a quantity deliverable, so the receipt must
  // also create the delivery task for the linked customer line. This is the
  // same side-effect the portal and the WhatsApp bot apply — without it a rep
  // who receives through the app would never see the goods to deliver.
  for (const p of prepared) {
    if (p.acceptedQty <= 0) continue;
    const [line] = await db
      .select({ lineStatus: purchaseOrderItemsTable.lineStatus })
      .from(purchaseOrderItemsTable)
      .where(eq(purchaseOrderItemsTable.id, p.poItemId));
    try {
      await applyReceiptSideEffects(assignment.poId, p.poItemId, line?.lineStatus ?? "pending");
    } catch (err) {
      // Never block a confirmed receipt on a downstream chaining failure.
      logger.warn({ err, poItemId: p.poItemId }, "mobile receipt side-effects failed");
    }
  }

  // Tell the responsible rep if someone else executed it.
  if (assignment.hrEmployeeId && assignment.hrEmployeeId !== actor.hrEmployeeId) {
    await notify(assignment.hrEmployeeId, {
      kind: "receipt_complete",
      title: "تم تنفيذ مهمة الاستلام",
      body: `نفّذ ${actor.fullName} مهمة الاستلام المسندة إليك`,
      entityType: "assignment",
      entityId: assignment.id,
    });
  }

  // Rule 4: receiving is what makes a quantity deliverable. When the confirmed
  // receipt unlocks a delivery task, the rep who owns that task is told so —
  // gated by the control page's notification switch.
  const settings = await loadFieldOpsSettings();
  if (settings.notifyOnDeliveryAvailable && prepared.some((p) => p.acceptedQty > 0)) {
    await notifyDeliveryAvailability(
      assignment,
      actor.fullName,
      settings.notifyOnDeliveryAvailable,
    );
  }

  res.json({
    success: true,
    receiptIds: createdIds,
    // The authoritative task status. The client must not infer it: "fully
    // received" depends on accepted quantities and on sibling lines the client
    // cannot see, so a client-side guess would show a closed task for work that
    // is still outstanding.
    assignmentStatus: anyOutstanding ? "partially_received" : "received",
    // Only the quantity that was actually ACCEPTED becomes deliverable; the
    // delivery side recomputes this from the same source, so the two can never
    // disagree.
    deliverableNow: prepared.map((p) => ({ poItemId: p.poItemId, acceptedQty: p.acceptedQty })),
  });
});

// ── Deliveries ──────────────────────────────────────────────────────────────

router.get("/deliveries", async (req, res): Promise<void> => {
  const actor = actorOf(req);
  const { assignmentIds } = await visibleAssignmentsFor(actor.hrEmployeeId, "delivery");
  if (!assignmentIds.length) {
    res.json({ tasks: [], summary: { taskCount: 0, distinctItems: 0, availableQty: 0 } });
    return;
  }
  const assignments = await db
    .select()
    .from(workOrderAssignmentsTable)
    .where(inArray(workOrderAssignmentsTable.id, assignmentIds));

  const customerPoIds = assignments
    .map((a) => a.customerPoId)
    .filter((x): x is number => x != null);

  const cpoRows = customerPoIds.length
    ? await db
        .select({
          id: customerPosTable.id,
          customerPoNo: customerPosTable.customerPoNo,
          customerId: customerPosTable.customerId,
          customerName: customerPosTable.customerName,
          poDate: customerPosTable.poDate,
          notes: customerPosTable.notes,
          status: customerPosTable.status,
        })
        .from(customerPosTable)
        .where(inArray(customerPosTable.id, customerPoIds))
    : [];
  const cpoMap = new Map(cpoRows.map((c) => [c.id, c]));

  const tasks = [];
  for (const a of assignments) {
    if (a.customerPoId == null) continue;
    const cpo = cpoMap.get(a.customerPoId);
    if (!cpo) continue;
    const items = await deliveryItemsFor(a);
    tasks.push({
      assignmentId: a.id,
      customerPoId: a.customerPoId,
      customerPoNo: cpo.customerPoNo,
      customerName: cpo.customerName,
      poDate: cpo.poDate,
      notes: cpo.notes,
      status: a.status,
      distinctItemCount: items.length,
      availableQty: Math.round(items.reduce((s, i) => s + i.availableQty, 0) * 10000) / 10000,
    });
  }

  res.json({
    tasks,
    summary: {
      taskCount: tasks.length,
      distinctItems: tasks.reduce((s, t) => s + t.distinctItemCount, 0),
      availableQty: Math.round(tasks.reduce((s, t) => s + t.availableQty, 0) * 10000) / 10000,
    },
  });
});

/** Delivery line detail: ordered / accepted / delivered / available. */
async function deliveryItemsFor(assignment: {
  customerPoItemId: number | null;
  customerPoId: number | null;
}) {
  if (assignment.customerPoId == null) return [];
  const itemIds = assignment.customerPoItemId != null ? [assignment.customerPoItemId] : null;
  const rows = await db
    .select({
      id: customerPoItemsTable.id,
      partNo: customerPoItemsTable.partNo,
      lineItem: customerPoItemsTable.lineItem,
      description: customerPoItemsTable.description,
      uom: customerPoItemsTable.uom,
      qty: customerPoItemsTable.qty,
      delivered: customerPoItemsTable.totalDeliveredQty,
      deliveryStatus: customerPoItemsTable.deliveryStatus,
    })
    .from(customerPoItemsTable)
    .where(
      itemIds
        ? and(
            eq(customerPoItemsTable.customerPoId, assignment.customerPoId),
            inArray(customerPoItemsTable.id, itemIds),
          )
        : eq(customerPoItemsTable.customerPoId, assignment.customerPoId),
    );

  const out = [];
  for (const r of rows) {
    const ordered = toNum(r.qty) ?? 0;
    const delivered = toNum(r.delivered) ?? 0;
    const accepted = await acceptedQtyFromSupplier(r.id);
    const available =
      accepted == null ? Math.max(0, ordered - delivered) : Math.max(0, accepted - delivered);
    out.push({
      customerPoItemId: r.id,
      partNo: r.partNo,
      lineItem: r.lineItem,
      description: r.description,
      uom: r.uom,
      orderedQty: ordered,
      acceptedFromSupplierQty: accepted,
      deliveredQty: delivered,
      availableQty: Math.round(available * 10000) / 10000,
      deliveryStatus: r.deliveryStatus,
    });
  }
  return out;
}

router.get("/deliveries/:id", async (req, res): Promise<void> => {
  const actor = actorOf(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const assignment = await loadAssignment(id);
  if (!assignment || assignment.kind !== WORK_ORDER_KIND.DELIVERY) {
    res.status(404).json({ error: "المهمة غير موجودة" });
    return;
  }
  const auth = await authorize(req, assignment);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  const items = await deliveryItemsFor(assignment);
  const cpo =
    assignment.customerPoId != null
      ? (
          await db
            .select()
            .from(customerPosTable)
            .where(eq(customerPosTable.id, assignment.customerPoId))
        )[0]
      : undefined;

  // Customer contact details come from the customer record, never invented.
  const customer =
    cpo?.customerId != null
      ? ((
          await db
            .select({
              id: customersTable.id,
              name: customersTable.name,
              phone: customersTable.phone,
              address: customersTable.address,
              contactPerson: customersTable.contactPerson,
            })
            .from(customersTable)
            .where(eq(customersTable.id, cpo.customerId))
        )[0] ?? null)
      : null;

  res.json({
    assignmentId: assignment.id,
    status: assignment.status,
    executorRole: auth.value?.role ?? "owner",
    customerPo: cpo
      ? {
          id: cpo.id,
          customerPoNo: cpo.customerPoNo,
          customerName: cpo.customerName,
          poDate: cpo.poDate,
          notes: cpo.notes,
        }
      : null,
    customer,
    items,
    responsibleEmployeeId: assignment.hrEmployeeId,
    representativeName: assignment.representativeName,
  });
});

interface DeliveryItemInput {
  customerPoItemId: number;
  deliveredQty?: number | string | null;
  rejectedByCustomerQty?: number | string | null;
  rejectionReason?: string | null;
  notes?: string | null;
}

router.post("/deliveries/:id/confirm", async (req, res): Promise<void> => {
  const actor = actorOf(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const assignment = await loadAssignment(id);
  if (!assignment || assignment.kind !== WORK_ORDER_KIND.DELIVERY) {
    res.status(404).json({ error: "المهمة غير موجودة" });
    return;
  }
  const auth = await authorize(req, assignment);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }
  if (assignment.customerPoId == null) {
    res.status(400).json({ error: "المهمة غير مرتبطة بأمر عميل" });
    return;
  }

  const body = req.body as {
    items?: DeliveryItemInput[];
    operationKey?: string;
    clientUuid?: string;
    recipientName?: string;
    gps?: { lat?: number; lng?: number };
  };
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) {
    res.status(400).json({ error: "أدخل الكميات المسلّمة" });
    return;
  }

  // Validate all lines against the received-and-accepted quantity before any write.
  const prepared: {
    customerPoItemId: number;
    deliveredQty: number;
    rejected: number;
    reason: string | null;
  }[] = [];
  for (const item of items) {
    const customerPoItemId = Number(item.customerPoItemId);
    if (!Number.isInteger(customerPoItemId)) {
      res.status(400).json({ error: "بند غير صالح في الطلب" });
      return;
    }
    const [line] = await db
      .select({
        id: customerPoItemsTable.id,
        customerPoId: customerPoItemsTable.customerPoId,
        qty: customerPoItemsTable.qty,
        delivered: customerPoItemsTable.totalDeliveredQty,
      })
      .from(customerPoItemsTable)
      .where(eq(customerPoItemsTable.id, customerPoItemId));
    // The line must belong to THIS customer PO — never another customer's.
    if (!line || line.customerPoId !== assignment.customerPoId) {
      res.status(400).json({ error: "البند لا يتبع أمر العميل الخاص بالمهمة" });
      return;
    }
    const deliveredQty = toNum(item.deliveredQty) ?? 0;
    const accepted = await acceptedQtyFromSupplier(customerPoItemId);
    const check = checkDeliveryQuantities({
      orderedQty: toNum(line.qty),
      acceptedFromSupplier: accepted,
      alreadyDelivered: toNum(line.delivered) ?? 0,
      deliveredQty,
    });
    if (!check.ok) {
      res.status(check.status).json({ error: check.error });
      return;
    }
    prepared.push({
      customerPoItemId,
      deliveredQty,
      rejected: toNum(item.rejectedByCustomerQty) ?? 0,
      reason: item.rejectionReason ? String(item.rejectionReason).slice(0, 500) : null,
    });
  }

  const operationKey =
    (body.operationKey ? String(body.operationKey) : null) ??
    (body.clientUuid ? String(body.clientUuid) : null) ??
    crypto.randomUUID();

  const createdIds: number[] = [];
  for (const p of prepared) {
    const [row] = await db
      .insert(customerPoItemDeliveriesTable)
      .values({
        customerPoItemId: p.customerPoItemId,
        customerPoId: assignment.customerPoId,
        deliveredQty: String(p.deliveredQty),
        rejectedByCustomerQty: p.rejected ? String(p.rejected) : null,
        rejectionReason: p.reason,
        deliveryStatus: p.rejected > 0 && p.deliveredQty === 0 ? "rejected" : "delivered",
        deliveredBy: actor.fullName,
        deliveredByHrEmployeeId: actor.hrEmployeeId,
        recipientName: body.recipientName ? String(body.recipientName).slice(0, 200) : null,
        gpsLat: body.gps?.lat != null ? String(body.gps.lat) : null,
        gpsLng: body.gps?.lng != null ? String(body.gps.lng) : null,
        operationKey,
      })
      .returning({ id: customerPoItemDeliveriesTable.id });
    createdIds.push(row.id);
  }

  // Recompute the delivery totals on each line through the SAME function the
  // portal uses, then apply the rep-menu/live-event side effects.
  for (const p of prepared) {
    await recomputeDeliveryTotals(p.customerPoItemId);
    const [updated] = await db
      .select({ deliveryStatus: customerPoItemsTable.deliveryStatus })
      .from(customerPoItemsTable)
      .where(eq(customerPoItemsTable.id, p.customerPoItemId));
    try {
      await applyDeliverySideEffects(
        assignment.customerPoId,
        p.customerPoItemId,
        updated?.deliveryStatus ?? "pending",
      );
    } catch {
      // best-effort — never block the delivery if the side-effects fail
    }
  }

  await db
    .update(workOrderAssignmentsTable)
    .set({
      status: "delivered",
      performedByHrEmployeeId: actor.hrEmployeeId,
      updatedAt: new Date(),
    })
    .where(eq(workOrderAssignmentsTable.id, assignment.id));

  await auditFieldOperation({
    action: "mobile.delivery_confirmed",
    entityType: "customer_po",
    entityId: assignment.customerPoId,
    hrEmployeeId: actor.hrEmployeeId,
    description: `Delivery confirmed for assignment ${assignment.id} by ${actor.fullName}; executor role ${auth.value?.role}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  if (assignment.hrEmployeeId && assignment.hrEmployeeId !== actor.hrEmployeeId) {
    await notify(assignment.hrEmployeeId, {
      kind: "delivery_complete",
      title: "تم تنفيذ مهمة التسليم",
      body: `نفّذ ${actor.fullName} مهمة التسليم المسندة إليك`,
      entityType: "assignment",
      entityId: assignment.id,
    });
  }

  res.json({ success: true, deliveryIds: createdIds });
});

// ── History ─────────────────────────────────────────────────────────────────

router.get("/history", async (req, res): Promise<void> => {
  const actor = actorOf(req);
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);

  // The employee's own operations: everything they executed, plus everything
  // they were responsible for (even if executed by a delegate).
  const receipts = await db
    .select({
      id: poItemReceiptsTable.id,
      poId: poItemReceiptsTable.poId,
      poNo: purchaseOrdersTable.internalPoNo,
      receivedQty: poItemReceiptsTable.receivedQty,
      acceptedQty: poItemReceiptsTable.acceptedQty,
      rejectedQty: poItemReceiptsTable.rejectedQty,
      status: poItemReceiptsTable.receiptStatus,
      receivedBy: poItemReceiptsTable.receivedBy,
      receivedByHr: poItemReceiptsTable.receivedByHrEmployeeId,
      at: poItemReceiptsTable.receivedAt,
      description: purchaseOrderItemsTable.description,
      assignmentId: poItemReceiptsTable.assignmentId,
    })
    .from(poItemReceiptsTable)
    .innerJoin(purchaseOrdersTable, eq(poItemReceiptsTable.poId, purchaseOrdersTable.id))
    .leftJoin(purchaseOrderItemsTable, eq(poItemReceiptsTable.poItemId, purchaseOrderItemsTable.id))
    .orderBy(desc(poItemReceiptsTable.receivedAt))
    .limit(limit);

  const deliveries = await db
    .select({
      id: customerPoItemDeliveriesTable.id,
      customerPoId: customerPoItemDeliveriesTable.customerPoId,
      customerPoNo: customerPosTable.customerPoNo,
      deliveredQty: customerPoItemDeliveriesTable.deliveredQty,
      rejectedQty: customerPoItemDeliveriesTable.rejectedByCustomerQty,
      status: customerPoItemDeliveriesTable.deliveryStatus,
      deliveredBy: customerPoItemDeliveriesTable.deliveredBy,
      deliveredByHr: customerPoItemDeliveriesTable.deliveredByHrEmployeeId,
      at: customerPoItemDeliveriesTable.deliveredAt,
      description: customerPoItemsTable.description,
    })
    .from(customerPoItemDeliveriesTable)
    .innerJoin(
      customerPosTable,
      eq(customerPoItemDeliveriesTable.customerPoId, customerPosTable.id),
    )
    .leftJoin(
      customerPoItemsTable,
      eq(customerPoItemDeliveriesTable.customerPoItemId, customerPoItemsTable.id),
    )
    .orderBy(desc(customerPoItemDeliveriesTable.deliveredAt))
    .limit(limit);

  // Restrict to this employee (executor OR responsible), so a rep never sees
  // another rep's operations.
  const ownedAssignmentIds = (
    await db
      .select({ id: workOrderAssignmentsTable.id })
      .from(workOrderAssignmentsTable)
      .where(eq(workOrderAssignmentsTable.hrEmployeeId, actor.hrEmployeeId))
  ).map((r) => r.id);

  const mine = receipts.filter(
    (r) =>
      r.receivedByHr === actor.hrEmployeeId ||
      (r.assignmentId != null && ownedAssignmentIds.includes(r.assignmentId)),
  );
  const mineDeliveries = deliveries.filter((d) => d.deliveredByHr === actor.hrEmployeeId);

  res.json({
    receipts: mine.map((r) => ({ ...r, at: r.at.toISOString() })),
    deliveries: mineDeliveries.map((d) => ({ ...d, at: d.at.toISOString() })),
  });
});

export default router;
