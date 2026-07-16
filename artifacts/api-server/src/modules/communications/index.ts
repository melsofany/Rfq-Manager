/**
 * Communications Module — التواصل
 *
 * Covers: WhatsApp Cloud API webhook, chat history, message dispatch,
 *         media storage, and reactions.
 *
 * Routes mounted:
 *   GET/POST /whatsapp/*
 */
import { Router, type IRouter } from "express";
import whatsappRouter from "./routes";

const router: IRouter = Router();

router.use(whatsappRouter);

export default router;
