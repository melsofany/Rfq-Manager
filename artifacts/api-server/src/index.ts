// Force IPv4 DNS resolution — Render does not support IPv6 outbound (ENETUNREACH)
import { setDefaultResultOrder } from "dns";
setDefaultResultOrder("ipv4first");

import app from "./app";
import { logger } from "./shared/logger";
import { runFullSync } from "./shared/sheet-sync";
import { verifyMirrorSheetAccess } from "./shared/google-sheets";
import { initDb } from "./shared/init-db";
import {
  ensureWorkOrderTemplate,
  ensurePoCancelTemplate,
  ensurePoCancelItemTemplate,
  ensurePayslipTemplate,
  ensureSupplierRegistrationTemplate,
  ensureSupplierRegistrationMismatchTemplate,
  ensureSupplierGreetingTemplate,
  ensureSupplierGreetingPreliminaryTemplate,
  ensureQuotationTemplate,
} from "./modules/communications/service";
import { scheduleDailyBackup } from "./modules/backup/service";
import { verifySenderIdentity } from "./shared/mail-identity";
import { logReadMailboxes } from "./modules/ai-assistant/mailboxes";
import { logProviderCapacity } from "./modules/ai-assistant/config";
import { engineName } from "./modules/ai-assistant/engine";
import {
  relayWebSocket,
  chatwootProxyMount,
  chatwootProxyTarget,
  chatwootOwnsPath,
} from "./modules/chatwoot/proxy";
import type { Request } from "express";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Prevent uncaught exceptions (e.g. corrupt PNG in PDF) from crashing the server
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — keeping server alive");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection — keeping server alive");
});

// Initialize DB schema and seed before starting server
initDb()
  .then(async () => {
    logger.info("DB initialized successfully");
    // Fail loudly HERE rather than in a supplier's spam folder: a sender that
    // does not match the authenticated account silently breaks DKIM alignment.
    verifySenderIdentity();
    logReadMailboxes();
    // A `running` job row whose process died (deploy/crash) would otherwise
    // promise work forever — and block a re-issued request from starting.
    const { markOrphanedJobs } = await import("./modules/ai-assistant/jobs");
    await markOrphanedJobs().catch((err) =>
      logger.warn({ err }, "AI assistant: orphan-job sweep failed (non-fatal)"),
    );
    // Repair the historical backlog of unclassified customer items with the
    // SAME deterministic rules as new items, and remember each decision by
    // identity. Idempotent (only NULL categories) and model-free, so it is safe
    // on every boot and never spends the LLM quota.
    const { backfillItemClassification } = await import("./modules/rfq/customer-assignment");
    await backfillItemClassification()
      .then((r) => {
        if (r.repairedItems > 0) {
          logger.info(
            { identities: r.repairedIdentities, items: r.repairedItems },
            "item classification conflicts unified",
          );
        }
        if (r.classified > 0) {
          logger.info(
            { scanned: r.scanned, classified: r.classified },
            "item classification backfill applied",
          );
        }
      })
      .catch((err) => logger.warn({ err }, "item classification backfill failed (non-fatal)"));
    const { runCategoryCleanupAtBoot } = await import("./modules/rfq/category-cleanup");
    await runCategoryCleanupAtBoot().catch((err) =>
      logger.warn({ err }, "category cleanup (non-fatal)"),
    );
    const { runAssignmentRepairAtBoot } = await import("./modules/rfq/assignment-repair");
    await runAssignmentRepairAtBoot().catch((err) =>
      logger.warn({ err }, "assignment repair (non-fatal)"),
    );
    logProviderCapacity();
    // Which tool-loop engine this process will use.
    //
    // There is only ONE engine now (`engine.ts` — the Mastra loop was removed
    // with its dependencies), so this reports the real engine name rather than a
    // switch that no longer exists. The old line printed "mastra" whenever the
    // vestigial enablement flag was true — and that flag had been reduced to a
    // constant `true` — so the deploy log claimed a Mastra engine while the
    // bundle contained no `@mastra` code at all. A misleading log is not harmless
    // here: it sent a verification of the reasoning-token fix to the wrong place
    // before the code path was confirmed by hand.
    logger.info(
      { engine: engineName(), env: process.env.AI_AGENT_ENGINE ?? null },
      "AI assistant: agent engine selected",
    );
    // Each template is provisioned independently: one failing (e.g. Meta
    // rejecting a call-button number) must not skip the ones after it.
    for (const [name, ensure] of [
      ["work_order", ensureWorkOrderTemplate],
      ["po_cancel", ensurePoCancelTemplate],
      ["po_cancel_item", ensurePoCancelItemTemplate],
      ["payslip", ensurePayslipTemplate],
      ["supplier_registration", ensureSupplierRegistrationTemplate],
      ["supplier_registration_mismatch", ensureSupplierRegistrationMismatchTemplate],
      ["supplier_greeting", ensureSupplierGreetingTemplate],
      ["supplier_greeting_preliminary", ensureSupplierGreetingPreliminaryTemplate],
      ["quotation", ensureQuotationTemplate],
    ] as const) {
      try {
        await ensure();
      } catch (err) {
        logger.warn({ err, template: name }, "WhatsApp template provisioning failed (non-fatal)");
      }
    }
  })
  .catch((err) => {
    // The migrations are idempotent, so a failure is never "the tables already
    // exist" — it is a real problem (e.g. a SQL syntax error rolling back a
    // whole multi-statement block). Log at error level so it is visible in the
    // Render logs instead of silently leaving a column in the wrong shape.
    logger.error({ err }, "DB init FAILED — a migration did not apply");
  })
  .finally(() => {
    const server = app.listen(port, () => {
      logger.info({ port }, "Server listening");

      if (process.env.GOOGLE_MIRROR_SHEET_ID) {
        const INTERVAL_MS = 5 * 60 * 1000;
        setTimeout(async () => {
          const reachable = await verifyMirrorSheetAccess();
          if (!reachable.ok) {
            logger.error(
              { error: reachable.error, sheetId: process.env.GOOGLE_MIRROR_SHEET_ID },
              "Mirror sheet unreachable — auto-sync disabled. Check GOOGLE_MIRROR_SHEET_ID " +
                "and share the spreadsheet with the service account.",
            );
            return;
          }
          runFullSync().catch((err) => logger.error({ err }, "Initial sheet sync failed"));
          setInterval(() => {
            runFullSync().catch((err) => logger.error({ err }, "Scheduled sheet sync failed"));
          }, INTERVAL_MS);
          logger.info({ intervalMinutes: 5 }, "Sheet auto-sync scheduled");
        }, 30_000);
      }

      scheduleDailyBackup();
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      logger.error({ err }, "Failed to start server");
      process.exit(1);
    });

    // ─── Chatwoot ActionCable relay ──────────────────────────────────────────
    //
    // The console opens a WebSocket for live message delivery. Without this the
    // console still renders, but an agent would have to refresh to see a
    // supplier's reply — the console would look healthy while failing to be
    // live, which is the failure mode that is hardest to notice.
    const wsTarget = chatwootProxyTarget();
    const wsMount = chatwootProxyMount();
    if (wsTarget && wsMount) {
      server.on("upgrade", (req, socket, head) => {
        const url = req.url ?? "";
        // Match the SAME path space the HTTP proxy owns. A naive
        // `${wsMount}/` prefix test is correct only while the mount is a
        // sub-path: at the root it becomes `//` and matches nothing, so the
        // console would render but never receive a live message.
        if (!chatwootOwnsPath(new URL(url, "http://localhost").pathname)) {
          // Not ours: leave the socket alone for any other listener.
          return;
        }
        relayWebSocket(req as unknown as Request, socket, head, {
          target: wsTarget,
          prefix: wsMount,
        });
      });
      logger.info({ at: wsMount }, "Chatwoot websocket relay armed");
    }
  });
