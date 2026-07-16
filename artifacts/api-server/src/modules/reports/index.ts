/**
 * Reports Module — التقارير والتحليلات
 *
 * Covers: dashboard analytics, audit log, and Google Sheets
 *         bi-directional sync.
 *
 * Routes mounted:
 *   GET /analytics/*
 *   GET /audit
 *   POST /sync/run
 *   GET  /sync/status
 */
import { Router, type IRouter } from "express";
import analyticsRouter from "./analytics";
import auditRouter from "./audit";
import syncRouter from "./sync";

const router: IRouter = Router();

router.use(analyticsRouter);
router.use(auditRouter);
router.use(syncRouter);

export default router;
