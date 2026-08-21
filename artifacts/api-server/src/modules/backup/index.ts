/**
 * Backup Module — نسخ احتياطي يومي لقاعدة البيانات على Google Drive
 *
 * Routes mounted (via routes/index.ts):
 *   GET /backup/status, POST /backup/run
 * Scheduler: scheduleDailyBackup() is called from src/index.ts on startup.
 */
import { Router, type IRouter } from "express";
import backupRouter from "./routes";

const router: IRouter = Router();
router.use(backupRouter);

export default router;
