/**
 * Page permissions for the API.
 *
 * Mirrors the portal's `artifacts/rfq-portal/src/lib/permissions.ts`:
 *  - admin has everything;
 *  - an employee with a non-empty explicit `permissions` map gets exactly the
 *    keys set to true in it;
 *  - otherwise the role default below applies.
 * Keep ROLE_DEFAULTS in sync with the portal file.
 */
import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db, employeesTable } from "@workspace/db";

type Session = { employeeId?: number; role?: string };

const ALL_PAGES = [
  "dashboard", "customers", "customer-rfq", "customer-po", "rfq", "suppliers", "items",
  "purchase-orders", "accounts", "analytics", "whatsapp", "employees", "hr", "audit",
  "integrations", "mailbox", "ai-assistant", "backup",
];
const ADMIN_ONLY_FOR_NON_ADMIN = ["employees", "hr", "audit", "integrations", "ai-assistant", "backup"];
const ITEMS_TABS = ["items:search", "items:analysis", "items:sheet", "items:categories"];

export const ROLE_DEFAULTS: Record<string, string[]> = {
  manager: [...ALL_PAGES, "customer-rfq:edit", "customer-rfq:price", "customer-po:edit", ...ITEMS_TABS, "rfq:assign"],
  purchasing: [
    ...ALL_PAGES.filter((k) => !ADMIN_ONLY_FOR_NON_ADMIN.includes(k)),
    "customer-rfq:edit", "customer-po:edit", ...ITEMS_TABS, "rfq:assign",
  ],
  data_entry: ["dashboard", "customers", "customer-rfq", "customer-po", "mailbox", "customer-rfq:edit", "customer-po:edit"],
  // Legacy backend-only role (not in the portal). Kept so accounting staff keep the accounts API.
  accountant: ["dashboard", "accounts", "mailbox", "customer-po", "accounts:records", "accounts:expenses", "accounts:posting"],
};

export interface Access {
  all: boolean;
  keys: Set<string>;
}

/** Pure: what an employee may access, given role and explicit map. */
export function accessFor(role: string | undefined, permissions: unknown): Access {
  if (role === "admin") return { all: true, keys: new Set() };
  const explicit =
    permissions && typeof permissions === "object" ? (permissions as Record<string, unknown>) : null;
  if (explicit && Object.keys(explicit).length) {
    return { all: false, keys: new Set(Object.keys(explicit).filter((k) => explicit[k] === true)) };
  }
  return { all: false, keys: new Set(ROLE_DEFAULTS[role ?? ""] ?? []) };
}

/** Loads the employee's access from the database. Null when missing or inactive. */
export async function loadAccess(employeeId: number): Promise<Access | null> {
  const [emp] = await db
    .select({
      role: employeesTable.role,
      permissions: employeesTable.permissions,
      isActive: employeesTable.isActive,
    })
    .from(employeesTable)
    .where(eq(employeesTable.id, employeeId))
    .limit(1);
  if (!emp || !emp.isActive) return null;
  return accessFor(emp.role, emp.permissions);
}

/** Pure: does this access grant any of the keys? */
export function allowsAny(access: Access, keys: string[]): boolean {
  return access.all || keys.some((k) => access.keys.has(k));
}

/** Does this employee have the page permission (admin always passes)? */
export async function hasPagePermission(employeeId: number, key: string): Promise<boolean> {
  const access = await loadAccess(employeeId);
  return access !== null && allowsAny(access, [key]);
}

function check(keys: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const session = (req as Request & { session?: Session }).session;
      if (!session?.employeeId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const access = await loadAccess(session.employeeId);
      if (!access) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (!allowsAny(access, keys)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Route-level gate: the employee needs any one of these keys. */
export function requirePermission(...keys: string[]) {
  return check(keys);
}

/**
 * Router-level gate by HTTP method: reads need any of `read`, writes need any of
 * `write`. Used on a path prefix so every route under it is covered.
 */
export function guardByMethod(read: string[], write: string[]) {
  const onRead = check(read);
  const onWrite = check(write);
  return (req: Request, res: Response, next: NextFunction): void => {
    const method = req.method.toUpperCase();
    (method === "GET" || method === "HEAD" ? onRead : onWrite)(req, res, next);
  };
}

const RFQ_READ = ["rfq", "purchase-orders", "customer-rfq", "customer-po", "accounts", "dashboard"];

/** Page guards per API prefix: reads need any of `read`, writes any of `write`. */
export const ROUTE_GUARDS: Record<string, { read: string[]; write: string[] }> = {
  "/suppliers": { read: ["suppliers", "rfq", "purchase-orders"], write: ["suppliers"] },
  "/categories": { read: ["suppliers", "rfq", "purchase-orders"], write: ["suppliers"] },
  "/customers": { read: ["customers", "customer-rfq", "customer-po", "dashboard"], write: ["customers"] },
  "/representatives": { read: ["employees", "customers", "customer-rfq", "customer-po"], write: ["employees"] },
  "/employees": { read: ["employees", "rfq", "customer-rfq", "customer-po", "purchase-orders", "dashboard"], write: ["employees"] },
  "/items": { read: ["items", "rfq", "customer-rfq", "customer-po", "purchase-orders", "analytics", "dashboard"], write: ["items"] },
  "/item-categories": { read: ["items", "rfq", "customer-rfq"], write: ["items"] },
  "/offers": { read: RFQ_READ, write: ["rfq"] },
  "/offer": { read: RFQ_READ, write: ["rfq"] },
  "/rfq": { read: RFQ_READ, write: ["rfq"] },
  "/customer-rfq": { read: ["customer-rfq", "rfq", "customer-po", "dashboard"], write: ["customer-rfq"] },
  "/customer-po": { read: ["customer-po", "customer-rfq", "dashboard"], write: ["customer-po"] },
  "/po": { read: ["purchase-orders", "rfq", "accounts", "dashboard"], write: ["purchase-orders"] },
  "/accounts": { read: ["accounts", "dashboard"], write: ["accounts"] },
  "/expenses": { read: ["accounts", "accounts:expenses"], write: ["accounts", "accounts:expenses"] },
  "/collections": { read: ["accounts", "dashboard"], write: ["accounts"] },
  "/analytics": { read: ["analytics", "dashboard"], write: ["analytics"] },
  "/sync": { read: ["analytics"], write: ["analytics"] },
  "/audit": { read: ["audit"], write: ["audit"] },
  "/whatsapp": { read: ["whatsapp", "whatsapp:chats"], write: ["whatsapp", "whatsapp:chats"] },
  "/chatwoot": { read: ["whatsapp", "whatsapp:chats"], write: ["whatsapp", "whatsapp:chats"] },
  "/ai-assistant": { read: ["ai-assistant"], write: ["ai-assistant"] },
  "/integrations": { read: ["integrations"], write: ["integrations"] },
  "/backup": { read: ["backup"], write: ["backup"] },
};

/** Router-level guard for one API prefix, from ROUTE_GUARDS. */
export function guardFor(prefix: string) {
  const g = ROUTE_GUARDS[prefix];
  if (!g) throw new Error(`No page guard for ${prefix}`);
  return guardByMethod(g.read, g.write);
}
