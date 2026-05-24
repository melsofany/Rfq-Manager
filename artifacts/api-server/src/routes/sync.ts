import { Router } from "express";
import { requireAuth, requireRole } from "../middlewares/auth";
import { runFullSync, getSyncStatus } from "../lib/sheetSync";

const router = Router();

/** GET /api/sync/status — current sync status */
router.get("/sync/status", requireAuth, (_req, res): void => {
  res.json(getSyncStatus());
});

/** POST /api/sync/sheet — manually trigger a full bidirectional sync */
router.post("/sync/sheet", requireAuth, requireRole("admin", "manager"), async (_req, res): Promise<void> => {
  const status = getSyncStatus();
  if (status.inProgress) {
    res.status(409).json({ error: "Sync already in progress" });
    return;
  }
  // Start async — respond immediately then run in background
  res.json({ message: "Sync started" });
  await runFullSync();
});

export default router;
