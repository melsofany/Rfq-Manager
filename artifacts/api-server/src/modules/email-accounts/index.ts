/**
 * Email accounts module — read-only view of Workspace mailboxes per employee.
 *
 * Routes mounted (all read-only; gated by page permission):
 *   GET /email-accounts                          directory + employee links
 *   GET /email-accounts/:mailbox/labels          folders and user labels
 *   GET /email-accounts/:mailbox/messages        messages (metadata, paged)
 *   GET /email-accounts/:mailbox/messages/:id    one message (body)
 */
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, employeesTable, mailboxAccessTable } from "@workspace/db";
import { requireAuth } from "../../middlewares/auth";
import { logger } from "../../shared/logger";
import { buildEmailAccountsView, type EmployeeRef } from "./accounts";
import {
  canReadMailbox,
  EMAIL_SETTINGS_PAGE,
  hasPagePermission,
  MAILBOX_PAGE,
  mailboxesFor,
  type Session,
} from "./access";
import { DirectoryNotConfiguredError, listDomainUsers, workspaceDomain } from "./directory";
import {
  getAttachment,
  getMessage,
  listLabels,
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

/**
 * Gate for every route that reads one mailbox: an admin, or an employee the
 * admin granted this mailbox. Read-only either way.
 */
/** Gate a route on one page permission (admin always passes). */
function requirePage(key: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const session = (req as Request & { session?: Session }).session;
      if (!session?.employeeId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (!(await hasPagePermission(session.employeeId, key))) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

async function requireMailboxReader(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const session = (req as Request & { session?: Session }).session;
  if (!session?.employeeId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const mailbox = domainMailbox(String(req.params.mailbox));
  if (!mailbox) {
    res.status(400).json({ error: "Mailbox must be an address on the company domain" });
    return;
  }
  if (!(await hasPagePermission(session.employeeId, MAILBOX_PAGE))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (!(await canReadMailbox(session, mailbox))) {
    res.status(403).json({ error: "No access to this mailbox" });
    return;
  }
  next();
}

router.get("/email-accounts", requirePage(EMAIL_SETTINGS_PAGE), async (_req, res): Promise<void> => {
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

router.get("/email-accounts/:mailbox/labels", requireMailboxReader, async (req, res): Promise<void> => {
  const mailbox = domainMailbox(String(req.params.mailbox));
  if (!mailbox) {
    res.status(400).json({ error: "Mailbox must be an address on the company domain" });
    return;
  }
  try {
    res.json({ mailbox, labels: await listLabels(mailbox) });
  } catch (err) {
    handleMailError(err, res, "list labels");
  }
});

router.get(
  "/email-accounts/:mailbox/messages",
  requireMailboxReader,
  async (req, res): Promise<void> => {
    const mailbox = domainMailbox(String(req.params.mailbox));
    if (!mailbox) {
      res.status(400).json({ error: "Mailbox must be an address on the company domain" });
      return;
    }
    const query = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : undefined;
    const max = Math.min(Math.max(parseInt(String(req.query.max ?? "20"), 10) || 20, 1), 50);
    const labelRaw = typeof req.query.label === "string" ? req.query.label : "";
    if (labelRaw && !/^[A-Za-z0-9_.\-]{1,100}$/.test(labelRaw)) {
      res.status(400).json({ error: "Invalid folder" });
      return;
    }
    const pageToken =
      typeof req.query.pageToken === "string" && /^[A-Za-z0-9_\-]{1,500}$/.test(req.query.pageToken)
        ? req.query.pageToken
        : undefined;
    logger.info({ by: actorId(req), mailbox, action: "list" }, "email-accounts: mailbox read");
    try {
      const page = await listMessages(mailbox, {
        query,
        max,
        labelId: labelRaw || undefined,
        pageToken,
      });
      res.json({ mailbox, ...page });
    } catch (err) {
      handleMailError(err, res, "list messages");
    }
  },
);

router.get(
  "/email-accounts/:mailbox/messages/:id",
  requireMailboxReader,
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

router.get(
  "/email-accounts/:mailbox/messages/:id/attachments/:index",
  requireMailboxReader,
  async (req, res): Promise<void> => {
    const mailbox = domainMailbox(String(req.params.mailbox));
    const id = String(req.params.id);
    const index = String(req.params.index);
    if (!mailbox) {
      res.status(400).json({ error: "Mailbox must be an address on the company domain" });
      return;
    }
    if (!/^[a-f0-9]{6,32}$/i.test(id) || !/^\d{1,3}$/.test(index)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    logger.info(
      { by: actorId(req), mailbox, messageId: id, action: "download-attachment" },
      "email-accounts: mailbox read",
    );
    try {
      const file = await getAttachment(mailbox, id, parseInt(index, 10));
      if (!file) {
        res.status(404).json({ error: "Attachment not found" });
        return;
      }
      // Images and PDFs open in the browser. Everything else is a download,
      // so an HTML or script attachment never runs on this site.
      const viewable = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(file.mimeType);
      res.setHeader("Content-Type", viewable ? file.mimeType : "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `${viewable ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "sandbox");
      res.send(file.data);
    } catch (err) {
      handleMailError(err, res, "download attachment");
    }
  },
);

/** Mailboxes this employee may read: their own company address and grants. */
router.get("/my-mailboxes", requireAuth, async (req, res): Promise<void> => {
  const session = (req as Request & { session?: Session }).session;
  if (!session?.employeeId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!(await hasPagePermission(session.employeeId, MAILBOX_PAGE))) {
    res.json({ mailboxes: [] });
    return;
  }
  res.json({ mailboxes: await mailboxesFor(session.employeeId) });
});

/** Admin: current read grants and the employee list to pick from. */
router.get("/mailbox-access", requirePage(EMAIL_SETTINGS_PAGE), async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: mailboxAccessTable.id,
      mailbox: mailboxAccessTable.mailbox,
      employeeId: mailboxAccessTable.employeeId,
      employeeName: employeesTable.name,
      employeeEmail: employeesTable.email,
    })
    .from(mailboxAccessTable)
    .innerJoin(employeesTable, eq(mailboxAccessTable.employeeId, employeesTable.id))
    .orderBy(mailboxAccessTable.mailbox);
  const employees = await db
    .select({ id: employeesTable.id, name: employeesTable.name, email: employeesTable.email })
    .from(employeesTable)
    .where(eq(employeesTable.isActive, true))
    .orderBy(employeesTable.name);
  res.json({ grants: rows, employees });
});

/** Admin: grant an employee read access to a mailbox. */
router.post("/mailbox-access", requirePage(EMAIL_SETTINGS_PAGE), async (req, res): Promise<void> => {
  const mailbox = domainMailbox(String((req.body as { mailbox?: unknown })?.mailbox ?? ""));
  const employeeId = Number((req.body as { employeeId?: unknown })?.employeeId);
  if (!mailbox) {
    res.status(400).json({ error: "Mailbox must be an address on the company domain" });
    return;
  }
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    res.status(400).json({ error: "Invalid employee" });
    return;
  }
  const [emp] = await db
    .select({ id: employeesTable.id })
    .from(employeesTable)
    .where(eq(employeesTable.id, employeeId));
  if (!emp) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }
  await db
    .insert(mailboxAccessTable)
    .values({ mailbox, employeeId })
    .onConflictDoNothing();
  logger.info({ by: actorId(req), mailbox, employeeId, action: "grant-read" }, "email-accounts: access changed");
  res.status(201).json({ ok: true });
});

/** Admin: remove a read grant. */
router.delete("/mailbox-access/:id", requirePage(EMAIL_SETTINGS_PAGE), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const removed = await db
    .delete(mailboxAccessTable)
    .where(eq(mailboxAccessTable.id, id))
    .returning({ mailbox: mailboxAccessTable.mailbox, employeeId: mailboxAccessTable.employeeId });
  if (removed.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  logger.info({ by: actorId(req), ...removed[0], action: "revoke-read" }, "email-accounts: access changed");
  res.status(204).end();
});

export default router;
