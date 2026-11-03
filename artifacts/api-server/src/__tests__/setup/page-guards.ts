/**
 * Test setup: page guards read the employee's role from req.session (set by
 * each test's auth mock) instead of the database. Policy is the real
 * accessFor/allowsAny from shared/permissions.
 */
import { vi } from "vitest";

vi.mock("../../shared/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/permissions")>();
  type Req = { method: string; session?: { employeeId?: number; role?: string } };
  const gate =
    (keys: string[]) =>
    (req: Req, res: any, next: any): void => {
      const s = req.session;
      // Tests whose auth mock is a no-op carry no session: the page policy
      // does not apply to them (their own auth mock already decided).
      if (!s) {
        next();
        return;
      }
      if (!s.employeeId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (!actual.allowsAny(actual.accessFor(s.role, null), keys)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    };
  return {
    ...actual,
    requirePermission: (...keys: string[]) => gate(keys),
    guardFor: (prefix: string) => {
      const g = actual.ROUTE_GUARDS[prefix];
      const onRead = gate(g.read);
      const onWrite = gate(g.write);
      return (req: Req, res: any, next: any) =>
        (req.method === "GET" || req.method === "HEAD" ? onRead : onWrite)(req, res, next);
    },
  };
});
