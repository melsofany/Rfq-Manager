/**
 * Accounts Bridge Module — جسر الحسابات إلى Odoo
 *
 * Odoo Community is the accounting engine; this module is the only thing in the
 * RFQ app that talks to it. The RFQ app stays the sole UI users see.
 *
 * Mounted by `routes/index.ts`. The legacy `modules/accounts` module is
 * DEPRECATED but still mounted (its routes keep their own distinct paths) until
 * Odoo is verified working in production — see `modules/accounts/DEPRECATED.md`.
 */
import { Router, type IRouter } from "express";
import bridgeRouter from "./routes";

const router: IRouter = Router();
router.use(bridgeRouter);

export default router;

export { syncEvent, probeOdoo } from "./service";
export { replayEvent } from "./replay";
export { eventKey } from "./mapping";
