/**
 * Email accounts module — read-only view of Workspace mailboxes per employee.
 *
 * Routes mounted:
 *   GET /email-accounts   (admin only)
 */
import { Router, type IRouter } from "express";
import { db, employeesTable } from "@workspace/db";
import { requireRole } from "../../middlewares/auth";
import { logger } from "../../shared/logger";
import { buildEmailAccountsView, type EmployeeRef } from "./accounts";
import { DirectoryNotConfiguredError, listDomainUsers, workspaceDomain } from "./directory";

const router: IRouter = Router();

router.get("/email-accounts", requireRole("admin"), async (_req, res): Promise<void> => {
  const employees: EmployeeRef[] = await db
    .select({
      id: employeesTable.id,
      name: employeesTable.name,
      email: employeesTable.email,
      role: employeesTable.role,
      isActive: employeesTable.isActive,
      permissions: employeesTable.permissions,
    })
    .from(employeesTable);

  try {
    const users = await listDomainUsers();
    res.json(buildEmailAccountsView(workspaceDomain(), users, employees));
  } catch (err) {
    if (err instanceof DirectoryNotConfiguredError) {
      res.status(503).json({ error: err.message });
      return;
    }
    logger.error({ err }, "email-accounts: Google Directory request failed");
    res.status(502).json({ error: "Google Directory request failed" });
  }
});

export default router;
