import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, employeesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

const router = Router();

declare module "express-session" {
  interface SessionData {
    employeeId: number;
    role: string;
  }
}

router.post("/auth/login", async (req, res): Promise<void> => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "Email and password required" });
    return;
  }

  const [employee] = await db.select().from(employeesTable).where(eq(employeesTable.email, email.toLowerCase()));
  if (!employee || !employee.isActive) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const valid = await bcrypt.compare(password, employee.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  req.session.employeeId = employee.id;
  req.session.role = employee.role;

  req.log.info({ employeeId: employee.id }, "Employee logged in");

  res.json({
    employee: {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      role: employee.role,
      phone: employee.phone,
      isActive: employee.isActive,
      createdAt: employee.createdAt.toISOString(),
    },
    token: req.sessionID,
  });
});

router.post("/auth/logout", (req, res): void => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

router.get("/auth/me", async (req, res): Promise<void> => {
  if (!req.session.employeeId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const [employee] = await db.select().from(employeesTable).where(eq(employeesTable.id, req.session.employeeId));
  if (!employee) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  res.json({
    id: employee.id,
    name: employee.name,
    email: employee.email,
    role: employee.role,
    phone: employee.phone,
    isActive: employee.isActive,
    createdAt: employee.createdAt.toISOString(),
  });
});

router.get("/employees", async (req, res): Promise<void> => {
  if (!req.session.employeeId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const employees = await db.select().from(employeesTable).orderBy(employeesTable.createdAt);
  res.json(employees.map(e => ({
    id: e.id, name: e.name, email: e.email, role: e.role,
    phone: e.phone, isActive: e.isActive, createdAt: e.createdAt.toISOString(),
  })));
});

router.post("/employees", async (req, res): Promise<void> => {
  if (!req.session.employeeId || req.session.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const { name, email, password, role, phone } = req.body as Record<string, string>;
    if (!name || !email || !password || !role) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }

    // Reject duplicate email
    const [existingEmail] = await db.select({ id: employeesTable.id })
      .from(employeesTable).where(eq(employeesTable.email, email.toLowerCase())).limit(1);
    if (existingEmail) {
      res.status(409).json({ error: "البريد الإلكتروني مستخدم بالفعل من قِبَل موظف آخر" });
      return;
    }

    // Reject duplicate phone (if provided)
    if (phone && phone.trim()) {
      const [existingPhone] = await db.select({ id: employeesTable.id })
        .from(employeesTable).where(eq(employeesTable.phone, phone.trim())).limit(1);
      if (existingPhone) {
        res.status(409).json({ error: "رقم الهاتف مستخدم بالفعل من قِبَل موظف آخر" });
        return;
      }
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const [employee] = await db.insert(employeesTable).values({
      name, email: email.toLowerCase(), passwordHash, role, phone: phone?.trim() || null,
    }).returning();

  logger.info({ employeeId: employee.id }, "Employee created");
  res.status(201).json({
    id: employee.id, name: employee.name, email: employee.email,
    role: employee.role, phone: employee.phone, isActive: employee.isActive,
    createdAt: employee.createdAt.toISOString(),
  });
});

router.patch("/employees/:id", async (req, res): Promise<void> => {
  if (!req.session.employeeId || req.session.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const { name, email, role, phone, isActive, password } = req.body as Record<string, string | boolean>;

  const updates: Record<string, unknown> = {};
  if (name) updates.name = name;
  if (email) updates.email = (email as string).toLowerCase();
  if (role) updates.role = role;
  if (phone !== undefined) updates.phone = phone;
  if (isActive !== undefined) updates.isActive = isActive;
  if (password) updates.passwordHash = await bcrypt.hash(password as string, 10);

  const [employee] = await db.update(employeesTable).set(updates).where(eq(employeesTable.id, id)).returning();
  if (!employee) { res.status(404).json({ error: "Not found" }); return; }

  res.json({
    id: employee.id, name: employee.name, email: employee.email,
    role: employee.role, phone: employee.phone, isActive: employee.isActive,
    createdAt: employee.createdAt.toISOString(),
  });
});

export default router;
