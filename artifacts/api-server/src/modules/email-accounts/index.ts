/**
 * Email accounts module — read-only view of Workspace mailboxes per employee.
 *
 * Routes mounted (all admin only, all read-only):
 *   GET /email-accounts                          directory + employee links
 *   GET /email-accounts/:mailbox/labels          folders and user labels
 *   GET /email-accounts/:mailbox/messages        messages (metadata, paged)
 *   GET /email-accounts/:mailbox/messages/:id    one message (body)
 */
import { Router, type IRouter, type Request } from "express";
import { db, employeesTable } from "@workspace/db";
import { requireRole } from "../../middlewares/auth";
import { logger } from "../../shared/logger";
import { buildEmailAccountsView, type EmployeeRef } from "./accounts";
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

router.get("/email-accounts/:mailbox/labels", requireRole("admin"), async (req, res): Promise<void> => {
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
  requireRole("admin"),
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

router.get(
  "/email-accounts/:mailbox/messages/:id/attachments/:attachmentId",
  requireRole("admin"),
  async (req, res): Promise<void> => {
    const mailbox = domainMailbox(String(req.params.mailbox));
    const id = String(req.params.id);
    const attachmentId = String(req.params.attachmentId);
    if (!mailbox) {
      res.status(400).json({ error: "Mailbox must be an address on the company domain" });
      return;
    }
    if (!/^[a-f0-9]{6,32}$/i.test(id) || !/^[A-Za-z0-9_-]{8,2000}$/.test(attachmentId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    logger.info(
      { by: actorId(req), mailbox, messageId: id, action: "download-attachment" },
      "email-accounts: mailbox read",
    );
    try {
      const file = await getAttachment(mailbox, id, attachmentId);
      if (!file) {
        res.status(404).json({ error: "Attachment not found" });
        return;
      }
      res.setHeader("Content-Type", file.mimeType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(file.data);
    } catch (err) {
      handleMailError(err, res, "download attachment");
    }
  },
);

export default router;
