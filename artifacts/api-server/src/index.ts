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
} from "./modules/communications/service";
import { scheduleDailyBackup } from "./modules/backup/service";
import { verifySenderIdentity } from "./shared/mail-identity";
import { logReadMailboxes } from "./modules/ai-assistant/mailboxes";
import { logProviderCapacity } from "./modules/ai-assistant/config";
import { mastraEngineEnabled } from "./modules/ai-assistant/mastra-agent";

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
    logProviderCapacity();
    // Which tool-loop engine this process will use. The choice is an env var with
    // no other visible surface, and "did my switch take effect?" was a real
    // question during the Mastra rollout — a one-line startup record answers it
    // from the deploy logs instead of from a live conversation.
    logger.info(
      {
        engine: mastraEngineEnabled() ? "mastra" : "legacy",
        env: process.env.AI_AGENT_ENGINE ?? null,
      },
      "AI assistant: agent engine selected",
    );
    try {
      await ensureWorkOrderTemplate();
      await ensurePoCancelTemplate();
      await ensurePoCancelItemTemplate();
    } catch (err) {
      logger.warn({ err }, "WhatsApp template provisioning failed (non-fatal)");
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
  });
