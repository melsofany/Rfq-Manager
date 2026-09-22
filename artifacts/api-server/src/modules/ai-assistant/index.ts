/**
 * AI Assistant Module — المساعد الذكي
 *
 * A WhatsApp agent restricted to admins/managers that can answer questions
 * about any data in the system, read the company mailbox, read images/files,
 * and generate PDFs.
 *
 * Routes mounted:
 *   GET    /ai-assistant/users
 *   POST   /ai-assistant/users
 *   PATCH  /ai-assistant/users/:id
 *   DELETE /ai-assistant/users/:id
 *   GET    /ai-assistant/employees
 *   GET    /ai-assistant/settings
 *   PUT    /ai-assistant/settings
 *
 * Inbound WhatsApp traffic is routed here from the communications webhook
 * (see modules/communications/routes.ts).
 */
import { Router, type IRouter } from "express";
import aiAssistantRouter from "./routes";

const router: IRouter = Router();
router.use(aiAssistantRouter);

export default router;
export { handleAiAssistantMessage } from "./handler";
