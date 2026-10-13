import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { canAssignItems } from "@/lib/permissions";
import { toast } from "sonner";
import { RefreshCw, AlertTriangle, CheckCircle2, UserCog } from "lucide-react";

interface AssignmentRow {
  rfqItemId: number;
  lineItem: string | null;
  partNo: string | null;
  description: string;
  categoryId: number | null;
  categoryName: string | null;
  employeeId: number | null;
  employeeName: string | null;
  source: string | null;
  confidence: number | null;
  unclassified: boolean;
  unassigned: boolean;
}

interface ItemCategory {
  id: number;
  name: string;
  isActive: boolean;
}

interface Employee {
  id: number;
  name: string;
  role: string;
  isActive: boolean;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * Per-item responsibility panel: shows the item's category and the employee
 * responsible for it, and lets an authorised user confirm/override either.
 * Items that could not be classified are flagged (never silently blank).
 */
export function ItemAssignmentsPanel({ rfqId }: { rfqId: number }) {
  const { employee } = useAuth();
  const [rows, setRows] = useState<AssignmentRow[]>([]);
  const [categories, setCategories] = useState<ItemCategory[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const canAssign = canAssignItems(employee?.role, employee?.permissions);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [aRes, cRes, eRes] = await Promise.all([
        fetch(`/api/rfq/${rfqId}/assignments`, { credentials: "include" }),
        fetch("/api/item-categories", { credentials: "include" }),
        fetch("/api/employees", { credentials: "include" }),
      ]);
      if (!aRes.ok) throw new Error(await readError(aRes));
      setRows((await aRes.json()) as AssignmentRow[]);
      if (cRes.ok) setCategories((await cRes.json()) as ItemCategory[]);
      if (eRes.ok) {
        const emps = (await eRes.json()) as Employee[];
        setEmployees(emps.filter((e) => e.isActive));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [rfqId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function ensureAssignments() {
    try {
      const res = await fetch(`/api/rfq/${rfqId}/assignments/ensure`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await readError(res));
      toast.success("تم تشغيل التصنيف والإسناد الآلي");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function patchAssignment(
    row: AssignmentRow,
    patch: { categoryId?: number | null; employeeId?: number | null },
  ) {
    setBusy(row.rfqItemId);
    try {
      const res = await fetch(`/api/rfq/items/${row.rfqItemId}/assignment`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId: patch.categoryId !== undefined ? patch.categoryId : row.categoryId,
          employeeId: patch.employeeId !== undefined ? patch.employeeId : row.employeeId,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const unclassified = rows.filter((r) => r.unclassified).length;
  const unassigned = rows.filter((r) => r.unassigned && !r.unclassified).length;

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border flex-wrap">
        <div className="flex items-center gap-2">
          <UserCog size={16} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">مسؤولية البنود</h3>
          {(unclassified > 0 || unassigned > 0) && (
            <span className="flex items-center gap-1 text-xs text-amber-600">
              <AlertTriangle size={13} />
              {unclassified > 0 && `${unclassified} غير مصنّف`}
              {unclassified > 0 && unassigned > 0 && " · "}
              {unassigned > 0 && `${unassigned} بلا مسؤول`}
            </span>
          )}
        </div>
        {canAssign && (
          <Button size="sm" variant="outline" onClick={ensureAssignments}>
            <RefreshCw size={14} className="me-1" /> تصنيف وإسناد آلي
          </Button>
        )}
      </div>

      {loading ? (
        <div className="p-6 text-center text-muted-foreground text-sm">جارٍ التحميل…</div>
      ) : error ? (
        <div className="p-6 text-center text-destructive text-sm">{error}</div>
      ) : rows.length === 0 ? (
        <div className="p-6 text-center text-muted-foreground text-sm">لا توجد بنود.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/30 border-b border-border text-right">
                <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground w-10">#</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground">البند</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground">التصنيف</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground">المسؤول</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.rfqItemId}
                  className={`border-b border-border last:border-0 ${r.unclassified || r.unassigned ? "bg-amber-50/60" : ""}`}
                >
                  <td className="px-4 py-2.5 text-xs text-muted-foreground text-center">{i + 1}</td>
                  <td className="px-4 py-2.5">
                    <div className="text-foreground text-xs">{r.description}</div>
                    {r.partNo && (
                      <div className="font-mono text-[11px] text-muted-foreground">{r.partNo}</div>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {canAssign ? (
                      <select
                        value={r.categoryId ?? ""}
                        disabled={busy === r.rfqItemId}
                        onChange={(e) =>
                          patchAssignment(r, {
                            categoryId: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                        className="text-xs bg-background border border-border rounded px-1.5 py-1"
                      >
                        <option value="">— غير مصنّف —</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span
                        className={`text-xs ${r.unclassified ? "text-amber-600" : "text-foreground"}`}
                      >
                        {r.categoryName ?? "غير مصنّف"}
                      </span>
                    )}
                    {r.source === "auto" && r.confidence != null && (
                      <span className="ms-1 text-[10px] text-muted-foreground">
                        ({r.confidence}%)
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {canAssign ? (
                      <select
                        value={r.employeeId ?? ""}
                        disabled={busy === r.rfqItemId}
                        onChange={(e) =>
                          patchAssignment(r, {
                            employeeId: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                        className="text-xs bg-background border border-border rounded px-1.5 py-1"
                      >
                        <option value="">— بلا مسؤول —</option>
                        {employees.map((emp) => (
                          <option key={emp.id} value={emp.id}>
                            {emp.name}
                          </option>
                        ))}
                      </select>
                    ) : r.employeeName ? (
                      <span className="flex items-center gap-1 text-xs text-foreground">
                        <CheckCircle2 size={12} className="text-emerald-600" />
                        {r.employeeName}
                      </span>
                    ) : (
                      <span className="text-xs text-amber-600">بلا مسؤول</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
