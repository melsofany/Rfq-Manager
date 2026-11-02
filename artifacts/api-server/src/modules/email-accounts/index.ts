/**
 * Email accounts module — read-only view of Workspace mailboxes per employee.
 *
 * Routes mounted (all admin only, all read-only):
 *   GET /email-accounts                          directory + employee links
 *   GET /email-accounts/:mailbox/messages        recent messages (metadata)
 *   GET /email-accounts/:mailbox/messages/:id    one message (body)
 */
import { Router, type IRouter, type Request } from "express";
import { db, employeesTable } from "@workspace/db";
import { requireRole } from "../../middlewares/auth";
import { logger } from "../../shared/logger";
import { buildEmailAccountsView, type EmployeeRef } from "./accounts";
import { DirectoryNotConfiguredError, listDomainUsers, workspaceDomain } from "./directory";
import {
  getMessage,
  listMessages,
  MailReadNotConfiguredError,
} from "./gmail";

const router: IRouter = Router();

/** Only this domain's mailboxes are readable — no arbitrary impersonation. */
function domainMailbox(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || email.slice(at + 1) !== workspaceDomain()) return null;
  return email;
}

function actorId(req: Request): number | undefined {
  return (req as Request & { session?: { employeeId?: number } }).session?.employeeId;
}

function handleMailError(err: unknown, res: import("express").Response, what: string): void {
  if (err instanceof MailReadNotConfiguredError) {
    res.status(503).json({ error: err.message });
    return;
  }
  logger.error({ err }, `email-accounts: ${what} failed`);
  res.status(502).json({ error: "Gmail request failed" });
}

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

router.get(
  "/email-accounts/:mailbox/messages",
  requireRole("admin"),
  async (req, res): Promise<void> => {
    const mailbox = domainMailbox(String(req.params.mailbox));
    if (!mailbox) {
      res.status(400).json({ error: "Mailbox must be an address on the company domain" });
      return;
    }
    const query = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : undefined;
    const max = Math.min(Math.max(parseInt(String(req.query.max ?? "20"), 10) || 20, 1), 50);
    logger.info({ by: actorId(req), mailbox, action: "list" }, "email-accounts: mailbox read");
    try {
      res.json({ mailbox, messages: await listMessages(mailbox, { query, max }) });
    } catch (err) {
      handleMailError(err, res, "list messages");
    }
  },
);

router.get(
  "/email-accounts/:mailbox/messages/:id",
  requireRole("admin"),
  async (req, res): Promise<void> => {
    const mailbox = domainMailbox(String(req.params.mailbox));
    const id = String(req.params.id);
    if (!mailbox) {
      res.status(400).json({ error: "Mailbox must be an address on the company domain" });
      return;
    }
    if (!/^[a-f0-9]{6,32}$/i.test(id)) {
      res.status(400).json({ error: "Invalid message id" });
      return;
    }
    logger.info({ by: actorId(req), mailbox, messageId: id, action: "open" }, "email-accounts: mailbox read");
    try {
      res.json(await getMessage(mailbox, id));
    } catch (err) {
      handleMailError(err, res, "get message");
    }
  },
);

export default router;
