/**
 * Customer Collections Module — متابعة تحصيل مستحقات العملاء
 *
 * Routes mounted (via routes/index.ts):
 *   GET /collections, GET /collections/alerts, GET/PUT /collections/:poId,
 *   POST/PATCH/DELETE /collections/.../payments.
 */
import { Router, type IRouter } from "express";
import collectionsRouter from "./routes";

const router: IRouter = Router();
router.use(collectionsRouter);

export default router;
