import { Router } from "express";
import { db, auditLogTable, employeesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";

const router = Router();

router.get("/audit", requireAuth, async (req, res): Promise<void> => {
  const { rfqId, employeeId, limit } = req.query as Record<string, string>;

  const rows = await db.select({ log: auditLogTable, employeeName: employeesTable.name })
    .from(auditLogTable)
    .leftJoin(employeesTable, eq(auditLogTable.employeeId, employeesTable.id))
    .orderBy(desc(auditLogTable.createdAt))
    .limit(limit ? parseInt(limit, 10) : 100);

  let filtered = rows;
  if (rfqId) filtered = filtered.filter(r => r.log.entityId === parseInt(rfqId, 10) && r.log.entityType === "rfq");
  if (employeeId) filtered = filtered.filter(r => r.log.employeeId === parseInt(employeeId, 10));

  res.json(filtered.map(r => ({
    id: r.log.id, action: r.log.action, entityType: r.log.entityType, entityId: r.log.entityId,
    employeeId: r.log.employeeId, employeeName: r.employeeName,
    description: r.log.description, ipAddress: r.log.ipAddress,
    userAgent: r.log.userAgent, createdAt: r.log.createdAt.toISOString(),
  })));
});

export default router;
