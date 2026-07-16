import type { Request, Response, NextFunction } from "express";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const session = (req as Request & { session?: { employeeId?: number; role?: string } }).session;
  if (!session?.employeeId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = (req as Request & { session?: { employeeId?: number; role?: string } }).session;
    if (!session?.employeeId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!roles.includes(session.role || "")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}
