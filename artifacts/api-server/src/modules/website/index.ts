/**
 * Website Module — إدارة الموقع الإلكتروني.
 *
 * Mounts the admin router (content + publish) and the public read endpoint the
 * static site consumes.
 *
 * Routes mounted (via routes/index.ts):
 *   GET  /website/settings        GET/PUT content, kill-switch, maintenance
 *   POST /website/deploy          rebuild + redeploy the static site
 *   GET  /public/website          public content for the site (no auth)
 */
import { Router, type IRouter } from "express";
import websiteRouter from "./routes";
import websitePublicRouter from "./public";

const router: IRouter = Router();
router.use(websitePublicRouter);
router.use(websiteRouter);

export default router;
