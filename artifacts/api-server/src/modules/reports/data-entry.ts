/**
 * Data-Entry Sessions Module — جلسات إدخال البيانات
 *
 * Tracks the real time an operator spends filling a "new" form, from the
 * moment they open it (startedAt) to the moment they save it successfully
 * (endedAt). Powers per-employee data-entry KPIs: number of RFQs/POs entered,
 * number of line items, total/avg entry time, weekly + monthly rollups.
 *
 * Routes mounted (behind requireAuth):
 *   POST   /data-entry-sessions            → start a session (form opened)
 *   PATCH  /data-entry-sessions/:id/end    → end a session (saved successfully)
 *   PATCH  /data-entry-sessions/:id/abandon→ mark abandoned (closed without save)
 *   GET    /analytics/data-entry           → per-employee KPIs (counts, items, durations)
 */
import { Router } from "express";
import {
  db,
  dataEntrySessionsTable,
  employeesTable,
  rfqTable,
  rfqItemsTable,
  purchaseOrdersTable,
  purchaseOrderItemsTable,
  customerRfqsTable,
  customerRfqItemsTable,
  customerPosTable,
  customerPoItemsTable,
} from "@workspace/db";
import { eq, and, gte, lte, isNotNull, sql, desc } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";

const router = Router();

const VALID_TYPES = new Set([
  "supplier_rfq",
  "customer_rfq",
  "supplier_po",
  "customer_po",
]);

/** POST /data-entry-sessions — record that the operator opened a "new" form. */
router.post("/data-entry-sessions", requireAuth, async (req, res): Promise<void> => {
  const { type } = req.body as { type?: string };
  if (!type || !VALID_TYPES.has(type)) {
    res.status(400).json({ error: "نوع الإدخال غير صالح" });
    return;
  }
  const [session] = await db
    .insert(dataEntrySessionsTable)
    .values({
      employeeId: req.session.employeeId!,
      type,
    })
    .returning();
  res.status(201).json({ id: session.id, type: session.type, startedAt: session.startedAt });
});

/** PATCH /data-entry-sessions/:id/end — mark a session as saved successfully. */
router.patch("/data-entry-sessions/:id/end", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const { entityId } = req.body as { entityId?: number };

  const [existing] = await db
    .select()
    .from(dataEntrySessionsTable)
    .where(eq(dataEntrySessionsTable.id, id))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "الجلسة غير موجودة" });
    return;
  }
  // Only the owner may end their own session.
  if (existing.employeeId !== req.session.employeeId) {
    res.status(403).json({ error: "غير مصرح" });
    return;
  }
  if (existing.endedAt) {
    res.json({ id: existing.id, endedAt: existing.endedAt });
    return;
  }

  const patch: Record<string, unknown> = { endedAt: new Date() };
  if (entityId != null) {
    if (existing.type === "supplier_rfq") patch.rfqId = entityId;
    else if (existing.type === "supplier_po") patch.purchaseOrderId = entityId;
    else if (existing.type === "customer_rfq") patch.customerRfqId = entityId;
    else if (existing.type === "customer_po") patch.customerPoId = entityId;
  }

  const [updated] = await db
    .update(dataEntrySessionsTable)
    .set(patch)
    .where(eq(dataEntrySessionsTable.id, id))
    .returning();
  res.json({ id: updated.id, endedAt: updated.endedAt });
});

/** POST /data-entry-sessions/:id/abandon — mark closed without saving. */
router.post(
  "/data-entry-sessions/:id/abandon",
  requireAuth,
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(raw, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "معرّف غير صالح" });
      return;
    }
    const [existing] = await db
      .select()
      .from(dataEntrySessionsTable)
      .where(eq(dataEntrySessionsTable.id, id))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "الجلسة غير موجودة" });
      return;
    }
    if (existing.employeeId !== req.session.employeeId) {
      res.status(403).json({ error: "غير مصرح" });
      return;
    }
    if (existing.endedAt) {
      res.json({ id: existing.id, abandoned: existing.abandoned });
      return;
    }
    const [updated] = await db
      .update(dataEntrySessionsTable)
      .set({ abandoned: true, endedAt: new Date() })
      .where(eq(dataEntrySessionsTable.id, id))
      .returning();
    res.json({ id: updated.id, abandoned: updated.abandoned });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// GET /analytics/data-entry — per-employee data-entry operator KPIs
//
// For each active employee returns:
//   - rfqCount / rfqItemCount / customerRfqCount / customerRfqItemCount
//   - poCount / poItemCount / customerPoCount / customerPoItemCount
//   - completedSessions / abandonedSessions / avgSessionSeconds / totalSessionSeconds
// Plus weekly + monthly totals (sessions completed in the last 7 / 30 days).
// Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD filters the entity-creation window.
// ═══════════════════════════════════════════════════════════════════════════
router.get("/analytics/data-entry", requireAuth, async (req, res): Promise<void> => {
  const fromStr = req.query.from as string | undefined;
  const toStr = req.query.to as string | undefined;
  const fromDate = fromStr ? new Date(fromStr + "T00:00:00Z") : null;
  const toDate = toStr ? new Date(toStr + "T23:59:59Z") : null;

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const employees = await db
    .select()
    .from(employeesTable)
    .where(eq(employeesTable.isActive, true));

  // Entity-creation date filter helper
  const inRange = (d: Date): boolean => {
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    return true;
  };

  // ── Load all sessions for these employees (for duration + rollups) ───────
  const empIds = employees.map((e) => e.id);
  const allSessions =
    empIds.length > 0
      ? await db
          .select()
          .from(dataEntrySessionsTable)
          .where(
            sql`${dataEntrySessionsTable.employeeId} = ANY(ARRAY[${sql.raw(
              empIds.join(",") || "0",
            )}]::int[])`,
          )
      : [];

  // ── Load entities + items created by these employees ────────────────────
  const rfqs = empIds.length
    ? await db
        .select({ id: rfqTable.id, employeeId: rfqTable.employeeId, createdAt: rfqTable.createdAt })
        .from(rfqTable)
        .where(
          sql`${rfqTable.employeeId} = ANY(ARRAY[${sql.raw(empIds.join(",") || "0")}]::int[])`,
        )
    : [];
  const poEntities = empIds.length
    ? await db
        .select({
          id: purchaseOrdersTable.id,
          employeeId: purchaseOrdersTable.employeeId,
          createdAt: purchaseOrdersTable.createdAt,
        })
        .from(purchaseOrdersTable)
        .where(
          sql`${purchaseOrdersTable.employeeId} = ANY(ARRAY[${sql.raw(
            empIds.join(",") || "0",
          )}]::int[])`,
        )
    : [];
  const customerRfqs = empIds.length
    ? await db
        .select({
          id: customerRfqsTable.id,
          employeeId: customerRfqsTable.employeeId,
          createdAt: customerRfqsTable.createdAt,
        })
        .from(customerRfqsTable)
        .where(
          sql`${customerRfqsTable.employeeId} = ANY(ARRAY[${sql.raw(
            empIds.join(",") || "0",
          )}]::int[])`,
        )
    : [];
  const customerPoEntities = empIds.length
    ? await db
        .select({
          id: customerPosTable.id,
          employeeId: customerPosTable.employeeId,
          createdAt: customerPosTable.createdAt,
        })
        .from(customerPosTable)
        .where(
          sql`${customerPosTable.employeeId} = ANY(ARRAY[${sql.raw(
            empIds.join(",") || "0",
          )}]::int[])`,
        )
    : [];

  // Item counts per parent (createdAt on items mirrors parent, so reuse parent range)
  const rfqIds = rfqs.map((r) => r.id);
  const poIds = poEntities.map((p) => p.id);
  const cRfqIds = customerRfqs.map((r) => r.id);
  const cPoIds = customerPoEntities.map((p) => p.id);

  const [rfqItemCountRow, poItemCountRow, cRfqItemCountRow, cPoItemCountRow] = await Promise.all([
    rfqIds.length
      ? db.select({ cnt: sql<number>`count(*)` }).from(rfqItemsTable).where(
          sql`${rfqItemsTable.rfqId} = ANY(ARRAY[${sql.raw(rfqIds.join(",") || "0")}]::int[])`,
        )
      : Promise.resolve([{ cnt: 0 }]),
    poIds.length
      ? db
          .select({ cnt: sql<number>`count(*)` })
          .from(purchaseOrderItemsTable)
          .where(
            sql`${purchaseOrderItemsTable.poId} = ANY(ARRAY[${sql.raw(
              poIds.join(",") || "0",
            )}]::int[])`,
          )
      : Promise.resolve([{ cnt: 0 }]),
    cRfqIds.length
      ? db
          .select({ cnt: sql<number>`count(*)` })
          .from(customerRfqItemsTable)
          .where(
            sql`${customerRfqItemsTable.customerRfqId} = ANY(ARRAY[${sql.raw(
              cRfqIds.join(",") || "0",
            )}]::int[])`,
          )
      : Promise.resolve([{ cnt: 0 }]),
    cPoIds.length
      ? db
          .select({ cnt: sql<number>`count(*)` })
          .from(customerPoItemsTable)
          .where(
            sql`${customerPoItemsTable.customerPoId} = ANY(ARRAY[${sql.raw(
              cPoIds.join(",") || "0",
            )}]::int[])`,
          )
      : Promise.resolve([{ cnt: 0 }]),
  ]);

  // We need per-employee item counts, so fetch them grouped.
  const rfqItemsByRfq = rfqIds.length
    ? await db
        .select({ rfqId: rfqItemsTable.rfqId })
        .from(rfqItemsTable)
        .where(
          sql`${rfqItemsTable.rfqId} = ANY(ARRAY[${sql.raw(rfqIds.join(",") || "0")}]::int[])`,
        )
    : [];
  const poItemsByPo = poIds.length
    ? await db
        .select({ poId: purchaseOrderItemsTable.poId })
        .from(purchaseOrderItemsTable)
        .where(
          sql`${purchaseOrderItemsTable.poId} = ANY(ARRAY[${sql.raw(
            poIds.join(",") || "0",
          )}]::int[])`,
        )
    : [];
  const cRfqItemsByRfq = cRfqIds.length
    ? await db
        .select({ customerRfqId: customerRfqItemsTable.customerRfqId })
        .from(customerRfqItemsTable)
        .where(
          sql`${customerRfqItemsTable.customerRfqId} = ANY(ARRAY[${sql.raw(
            cRfqIds.join(",") || "0",
          )}]::int[])`,
        )
    : [];
  const cPoItemsByPo = cPoIds.length
    ? await db
        .select({ customerPoId: customerPoItemsTable.customerPoId })
        .from(customerPoItemsTable)
        .where(
          sql`${customerPoItemsTable.customerPoId} = ANY(ARRAY[${sql.raw(
            cPoIds.join(",") || "0",
          )}]::int[])`,
        )
    : [];

  // Map parent → item count
  const rfqItemCount = new Map<number, number>();
  for (const r of rfqItemsByRfq) rfqItemCount.set(r.rfqId, (rfqItemCount.get(r.rfqId) ?? 0) + 1);
  const poItemCount = new Map<number, number>();
  for (const r of poItemsByPo) poItemCount.set(r.poId, (poItemCount.get(r.poId) ?? 0) + 1);
  const cRfqItemCount = new Map<number, number>();
  for (const r of cRfqItemsByRfq)
    cRfqItemCount.set(r.customerRfqId, (cRfqItemCount.get(r.customerRfqId) ?? 0) + 1);
  const cPoItemCount = new Map<number, number>();
  for (const r of cPoItemsByPo) {
    if (r.customerPoId == null) continue; // detached (removed) row — not counted on any PO
    cPoItemCount.set(r.customerPoId, (cPoItemCount.get(r.customerPoId) ?? 0) + 1);
  }

  // Map employee → their entity ids
  const rfqsByEmp = new Map<number, typeof rfqs>();
  for (const r of rfqs) {
    if (!inRange(r.createdAt)) continue;
    const arr = rfqsByEmp.get(r.employeeId!) ?? [];
    arr.push(r);
    rfqsByEmp.set(r.employeeId!, arr);
  }
  const posByEmp = new Map<number, typeof poEntities>();
  for (const p of poEntities) {
    if (!inRange(p.createdAt)) continue;
    const arr = posByEmp.get(p.employeeId!) ?? [];
    arr.push(p);
    posByEmp.set(p.employeeId!, arr);
  }
  const cRfqsByEmp = new Map<number, typeof customerRfqs>();
  for (const r of customerRfqs) {
    if (!inRange(r.createdAt)) continue;
    const arr = cRfqsByEmp.get(r.employeeId!) ?? [];
    arr.push(r);
    cRfqsByEmp.set(r.employeeId!, arr);
  }
  const cPosByEmp = new Map<number, typeof customerPoEntities>();
  for (const p of customerPoEntities) {
    if (!inRange(p.createdAt)) continue;
    const arr = cPosByEmp.get(p.employeeId!) ?? [];
    arr.push(p);
    cPosByEmp.set(p.employeeId!, arr);
  }

  // Sessions grouped by employee
  const sessionsByEmp = new Map<number, typeof allSessions>();
  for (const s of allSessions) {
    const arr = sessionsByEmp.get(s.employeeId) ?? [];
    arr.push(s);
    sessionsByEmp.set(s.employeeId, arr);
  }

  const fmtDuration = (seconds: number): string => {
    if (seconds <= 0) return "0";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}س ${m}د`;
    if (m > 0) return `${m}د ${s}ث`;
    return `${s}ث`;
  };

  const employees_kpis = employees
    .filter((e) => e.role === "data_entry" || e.role === "purchasing" || e.role === "admin" || e.role === "manager")
    .map((emp) => {
      const myRfqs = rfqsByEmp.get(emp.id) ?? [];
      const myPos = posByEmp.get(emp.id) ?? [];
      const myCRfqs = cRfqsByEmp.get(emp.id) ?? [];
      const myCPos = cPosByEmp.get(emp.id) ?? [];

      const myRfqItems = myRfqs.reduce((s, r) => s + (rfqItemCount.get(r.id) ?? 0), 0);
      const myPoItems = myPos.reduce((s, p) => s + (poItemCount.get(p.id) ?? 0), 0);
      const myCRfqItems = myCRfqs.reduce((s, r) => s + (cRfqItemCount.get(r.id) ?? 0), 0);
      const myCPoItems = myCPos.reduce((s, p) => s + (cPoItemCount.get(p.id) ?? 0), 0);

      const sessions = sessionsByEmp.get(emp.id) ?? [];
      const completed = sessions.filter((s) => s.endedAt && !s.abandoned);
      const abandoned = sessions.filter((s) => s.abandoned);

      const durations = completed.map((s) => {
        const start = s.startedAt.getTime();
        const end = s.endedAt!.getTime();
        return Math.max(0, Math.round((end - start) / 1000));
      });
      const totalSeconds = durations.reduce((a, b) => a + b, 0);
      const avgSeconds = durations.length > 0 ? Math.round(totalSeconds / durations.length) : 0;

      // Weekly + monthly rollups (sessions completed in last 7 / 30 days)
      const weeklySessions = completed.filter((s) => s.endedAt! >= weekAgo);
      const monthlySessions = completed.filter((s) => s.endedAt! >= monthAgo);
      const weeklySeconds = weeklySessions
        .map((s) => Math.max(0, Math.round((s.endedAt!.getTime() - s.startedAt.getTime()) / 1000)))
        .reduce((a, b) => a + b, 0);
      const monthlySeconds = monthlySessions
        .map((s) => Math.max(0, Math.round((s.endedAt!.getTime() - s.startedAt.getTime()) / 1000)))
        .reduce((a, b) => a + b, 0);

      return {
        employeeId: emp.id,
        employeeName: emp.name,
        role: emp.role,
        counts: {
          rfqs: myRfqs.length,
          rfqItems: myRfqItems,
          customerRfqs: myCRfqs.length,
          customerRfqItems: myCRfqItems,
          pos: myPos.length,
          poItems: myPoItems,
          customerPos: myCPos.length,
          customerPoItems: myCPoItems,
          completedSessions: completed.length,
          abandonedSessions: abandoned.length,
        },
        durations: {
          totalSeconds,
          avgSeconds,
          totalFormatted: fmtDuration(totalSeconds),
          avgFormatted: fmtDuration(avgSeconds),
          weeklySeconds,
          monthlySeconds,
          weeklyFormatted: fmtDuration(weeklySeconds),
          monthlyFormatted: fmtDuration(monthlySeconds),
          weeklySessions: weeklySessions.length,
          monthlySessions: monthlySessions.length,
        },
      };
    })
    .filter((e) => e.counts.completedSessions > 0 || e.counts.rfqs > 0 || e.counts.pos > 0 || e.counts.customerRfqs > 0 || e.counts.customerPos > 0);

  // ── Company-wide totals ─────────────────────────────────────────────────
  const allCompleted = allSessions.filter((s) => s.endedAt && !s.abandoned);
  const totalActiveSeconds = allCompleted
    .map((s) => Math.max(0, Math.round((s.endedAt!.getTime() - s.startedAt.getTime()) / 1000)))
    .reduce((a, b) => a + b, 0);
  const weeklyTotal = allCompleted
    .filter((s) => s.endedAt! >= weekAgo)
    .map((s) => Math.max(0, Math.round((s.endedAt!.getTime() - s.startedAt.getTime()) / 1000)))
    .reduce((a, b) => a + b, 0);
  const monthlyTotal = allCompleted
    .filter((s) => s.endedAt! >= monthAgo)
    .map((s) => Math.max(0, Math.round((s.endedAt!.getTime() - s.startedAt.getTime()) / 1000)))
    .reduce((a, b) => a + b, 0);

  res.json({
    period: { from: fromStr ?? null, to: toStr ?? null },
    employees: employees_kpis,
    totals: {
      totalActiveSeconds,
      weeklySeconds: weeklyTotal,
      monthlySeconds: monthlyTotal,
      totalFormatted: fmtDuration(totalActiveSeconds),
      weeklyFormatted: fmtDuration(weeklyTotal),
      monthlyFormatted: fmtDuration(monthlyTotal),
      completedSessions: allCompleted.length,
      abandonedSessions: allSessions.filter((s) => s.abandoned).length,
    },
  });
});

export default router;
