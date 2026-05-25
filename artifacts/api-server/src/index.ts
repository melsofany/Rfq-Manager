// Force IPv4 DNS resolution — Render does not support IPv6 outbound (ENETUNREACH)
import { setDefaultResultOrder } from "dns";
setDefaultResultOrder("ipv4first");

import app from "./app";
import { logger } from "./lib/logger";
import { runFullSync } from "./lib/sheetSync";
import { initDb } from "./lib/initDb";

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
  .then(() => {
    logger.info("DB initialized successfully");
  })
  .catch((err) => {
    logger.warn({ err }, "DB init failed (non-fatal, tables may already exist)");
  })
  .finally(() => {
    const server = app.listen(port, () => {
      logger.info({ port }, "Server listening");

      if (process.env.GOOGLE_MIRROR_SHEET_ID) {
        const INTERVAL_MS = 5 * 60 * 1000;
        setTimeout(() => {
          runFullSync().catch((err) => logger.error({ err }, "Initial sheet sync failed"));
          setInterval(() => {
            runFullSync().catch((err) => logger.error({ err }, "Scheduled sheet sync failed"));
          }, INTERVAL_MS);
        }, 30_000);
        logger.info({ intervalMinutes: 5 }, "Sheet auto-sync scheduled");
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      logger.error({ err }, "Failed to start server");
      process.exit(1);
    });
  });
