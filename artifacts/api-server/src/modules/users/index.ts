/**
 * Users Module — المستخدمون والموردون
 *
 * Covers: authentication (login/logout/me), employee management,
 *         supplier CRUD, and supplier categories.
 *
 * Routes mounted:
 *   POST   /auth/login
 *   POST   /auth/logout
 *   GET    /auth/me
 *   GET/POST/PUT/DELETE /suppliers
 *   GET/POST/PUT/DELETE /categories
 */
import { Router, type IRouter } from "express";
import authRouter from "./auth";
import suppliersRouter from "./suppliers";
import categoriesRouter from "./categories";
import representativesRouter from "./representatives";

const router: IRouter = Router();

router.use(authRouter);
router.use(suppliersRouter);
router.use(categoriesRouter);
router.use(representativesRouter);

export default router;
