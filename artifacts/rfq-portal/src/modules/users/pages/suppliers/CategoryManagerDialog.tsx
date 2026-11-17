import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Plus,
  Pencil,
  Trash2,
  X,
  Check,
  AlertCircle,
  Search,
  RotateCcw,
  GitMerge,
  ChevronRight,
  ChevronDown,
  BarChart3,
} from "lucide-react";

/**
 * Professional category manager — إدارة تصنيفات الموردين
 *
 * Replaces the small inline dialog. Reads/writes the supplier-category API
 * directly (the new lifecycle endpoints are not in the OpenAPI spec, same
 * pattern as the receipts/deliveries/accounts screens).
 *
 * Deliberate design points, each from a rule the operator set:
 *   • A deleted category is HIDDEN, never removed — the deleted view offers a
 *     «استعادة» action, so nothing is lost by accident.
 *   • A merge is an EXPLICIT two-step action with a confirmation panel; nothing
 *     here merges on name similarity. The cleanup report only *suggests*.
 *   • Every row shows how many suppliers it holds, so an unused category is
 *     visible before anyone tidies it away.
 */

interface CategoryRow {
  id: number;
  name: string;
  parentId: number | null;
  isActive: boolean;
  deletedAt: string | null;
  sortOrder: number;
  supplierCount: number;
}

interface ReportData {
  totals: {
    total: number;
    active: number;
    deleted: number;
    unused: number;
    duplicateGroups: number;
  };
  unused: CategoryRow[];
  duplicates: Array<{
    key: string;
    categories: Array<{ id: number; name: string; parentId: number | null }>;
  }>;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export function CategoryManagerDialog({
  onClose,
  variant = "dialog",
}: {
  onClose?: () => void;
  variant?: "dialog" | "panel";
}) {
  const [rows, setRows] = useState<CategoryRow[]>([]);
  const [report, setReport] = useState<ReportData | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const [newName, setNewName] = useState("");
  const [newParentId, setNewParentId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editParentId, setEditParentId] = useState<number | null>(null);

  // Merge is a two-step explicit action: pick a source and a target, then
  // confirm. Nothing merges without this confirmation.
  const [mergeSource, setMergeSource] = useState<CategoryRow | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [list, rep] = await Promise.all([
        api<CategoryRow[]>(`/categories${showDeleted ? "?includeDeleted=1" : ""}`),
        api<ReportData>("/categories/report"),
      ]);
      setRows(list);
      setReport(rep);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [showDeleted]);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = (msg: string) => {
    setOkMsg(msg);
    setError(null);
    setTimeout(() => setOkMsg(null), 2500);
  };

  const run = async (fn: () => Promise<unknown>, successMsg: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      flash(successMsg);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    void run(async () => {
      await api("/categories", {
        method: "POST",
        body: JSON.stringify({ name: newName.trim(), parentId: newParentId }),
      });
      setNewName("");
      setNewParentId(null);
    }, "تمت إضافة التصنيف");
  };

  const startEdit = (c: CategoryRow) => {
    setEditingId(c.id);
    setEditName(c.name);
    setEditParentId(c.parentId ?? null);
  };

  const saveEdit = (id: number) => {
    if (!editName.trim()) return;
    void run(async () => {
      await api(`/categories/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editName.trim(), parentId: editParentId }),
      });
      setEditingId(null);
    }, "تم حفظ التعديل");
  };

  const softDelete = (c: CategoryRow) => {
    void run(
      () => api(`/categories/${c.id}`, { method: "DELETE" }),
      `تم حذف «${c.name}» (يمكن استعادته)`,
    );
  };

  const restore = (c: CategoryRow) => {
    void run(
      () => api(`/categories/${c.id}/restore`, { method: "POST" }),
      `تمت استعادة «${c.name}»`,
    );
  };

  const doMerge = (source: CategoryRow, target: CategoryRow) => {
    void run(
      () =>
        api("/categories/merge", {
          method: "POST",
          body: JSON.stringify({ sourceId: source.id, targetId: target.id }),
        }),
      `تم دمج «${source.name}» في «${target.name}»`,
    );
    setMergeSource(null);
  };

  // ── Tree rendering ────────────────────────────────────────────────────────
  const { roots, childrenOf } = useMemo(() => {
    const active = rows.filter((r) => showDeleted || r.isActive);
    const filtered = search.trim()
      ? active.filter((r) => r.name.toLowerCase().includes(search.trim().toLowerCase()))
      : active;
    // When searching, keep a matching child's parent visible so the tree reads.
    const ids = new Set(filtered.map((r) => r.id));
    const withParents = active.filter(
      (r) => ids.has(r.id) || (r.parentId != null && ids.has(r.parentId)),
    );
    const childrenOf = new Map<number, CategoryRow[]>();
    const roots: CategoryRow[] = [];
    const present = new Set(withParents.map((r) => r.id));
    for (const r of withParents) {
      if (r.parentId == null || !present.has(r.parentId)) {
        roots.push(r);
        continue;
      }
      const list = childrenOf.get(r.parentId) ?? [];
      list.push(r);
      childrenOf.set(r.parentId, list);
    }
    return { roots, childrenOf };
  }, [rows, showDeleted, search]);

  const renderRow = (c: CategoryRow, depth: number): React.ReactNode => {
    const subs = childrenOf.get(c.id) ?? [];
    const isCollapsed = collapsed.has(c.id);
    const editing = editingId === c.id;
    return (
      <div key={c.id}>
        <div
          className={`flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/30 ${!c.isActive ? "opacity-60" : ""}`}
          style={{ paddingRight: 8 + depth * 20 }}
        >
          {subs.length > 0 ? (
            <button
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(c.id)) next.delete(c.id);
                  else next.add(c.id);
                  return next;
                })
              }
              className="text-muted-foreground hover:text-foreground"
            >
              {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </button>
          ) : (
            <span className="w-3.5" />
          )}

          {editing ? (
            <>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="h-7 text-sm flex-1"
                autoFocus
              />
              <select
                value={editParentId ?? ""}
                onChange={(e) => setEditParentId(e.target.value ? Number(e.target.value) : null)}
                className="h-7 text-xs bg-background border border-input rounded px-1 text-foreground"
              >
                <option value="">تصنيف رئيسي</option>
                {rows
                  .filter((r) => r.id !== c.id)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
              <button
                onClick={() => saveEdit(c.id)}
                className="text-green-600 hover:text-green-700 p-0.5"
                disabled={busy}
              >
                <Check size={15} />
              </button>
              <button
                onClick={() => setEditingId(null)}
                className="text-muted-foreground hover:text-foreground p-0.5"
              >
                <X size={15} />
              </button>
            </>
          ) : (
            <>
              <span
                className={`flex-1 text-sm text-foreground ${depth === 0 ? "font-medium" : "text-muted-foreground"}`}
              >
                {c.name}
                {!c.isActive && <span className="text-[11px] text-destructive mr-2">(محذوف)</span>}
              </span>
              <span
                className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground tabular-nums"
                title="عدد الموردين في هذا التصنيف"
              >
                {c.supplierCount}
              </span>
              {c.isActive ? (
                <>
                  <button
                    onClick={() => startEdit(c)}
                    className="text-muted-foreground hover:text-foreground p-0.5"
                    title="تعديل"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    onClick={() => setMergeSource(c)}
                    className="text-muted-foreground hover:text-primary p-0.5"
                    title="دمج في تصنيف آخر"
                  >
                    <GitMerge size={13} />
                  </button>
                  <button
                    onClick={() => softDelete(c)}
                    className="text-muted-foreground hover:text-destructive p-0.5"
                    title="حذف (قابل للاستعادة)"
                    disabled={busy}
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              ) : (
                <button
                  onClick={() => restore(c)}
                  className="text-muted-foreground hover:text-green-600 p-0.5"
                  title="استعادة"
                  disabled={busy}
                >
                  <RotateCcw size={13} />
                </button>
              )}
            </>
          )}
        </div>
        {!isCollapsed && subs.map((s) => renderRow(s, depth + 1))}
      </div>
    );
  };

  const isPanel = variant === "panel";
  const body = (
    <>
      {!isPanel && (
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground">إدارة تصنيفات الموردين</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>
      )}

      {/* Add form */}
      <form onSubmit={handleAdd} className="px-5 pt-4 pb-3 border-b border-border space-y-2">
        <div className="flex gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="اسم التصنيف الجديد..."
            className="h-9 text-sm flex-1"
          />
          <select
            value={newParentId ?? ""}
            onChange={(e) => setNewParentId(e.target.value ? Number(e.target.value) : null)}
            className="h-9 text-xs bg-background border border-input rounded px-2 text-foreground"
          >
            <option value="">تصنيف رئيسي (بدون أب)</option>
            {rows
              .filter((r) => r.isActive && r.parentId == null)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
          </select>
          <Button
            type="submit"
            size="sm"
            disabled={busy || !newName.trim()}
            className="gap-1.5 h-9"
          >
            <Plus size={14} /> إضافة
          </Button>
        </div>
      </form>

      {/* Toolbar */}
      <div className="px-5 py-3 border-b border-border flex items-center gap-3">
        <div className="relative flex-1">
          <Search
            size={14}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="بحث في التصنيفات..."
            className="h-8 text-sm pr-7"
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => setShowDeleted(e.target.checked)}
          />
          إظهار المحذوف
        </label>
      </div>

      {/* Report strip */}
      {report && (
        <div className="px-5 py-2 border-b border-border flex items-center gap-4 text-[11px] text-muted-foreground bg-muted/20">
          <span className="flex items-center gap-1">
            <BarChart3 size={12} /> الإجمالي:{" "}
            <b className="text-foreground">{report.totals.active}</b>
          </span>
          <span>
            بلا موردين: <b className="text-foreground">{report.totals.unused}</b>
          </span>
          <span className={report.totals.duplicateGroups > 0 ? "text-amber-600" : ""}>
            مجموعات متشابهة: <b>{report.totals.duplicateGroups}</b>
          </span>
          {report.totals.deleted > 0 && (
            <span>
              محذوفة: <b>{report.totals.deleted}</b>
            </span>
          )}
        </div>
      )}

      {/* Tree */}
      <div className="flex-1 overflow-y-auto px-3 py-2 min-h-[200px]">
        {error && (
          <div className="flex items-center gap-1.5 text-xs text-destructive px-2 py-2">
            <AlertCircle size={13} /> <span>{error}</span>
          </div>
        )}
        {okMsg && (
          <div className="flex items-center gap-1.5 text-xs text-green-600 px-2 py-2">
            <Check size={13} /> <span>{okMsg}</span>
          </div>
        )}
        {roots.length === 0 && !busy ? (
          <p className="text-muted-foreground text-sm text-center py-8">لا توجد تصنيفات</p>
        ) : (
          roots.map((r) => renderRow(r, 0))
        )}
      </div>

      {/* Merge confirmation */}
      {mergeSource && (
        <div className="px-5 py-3 border-t border-border bg-amber-50 dark:bg-amber-950/20">
          <p className="text-xs text-foreground mb-2">
            دمج «<b>{mergeSource.name}</b>» في تصنيف آخر — سيتم نقل كل الموردين والعلاقات، وإخفاء
            التصنيف المصدر (قابل للاستعادة). اختر التصنيف الهدف:
          </p>
          <div className="flex gap-2">
            <select
              id="merge-target"
              className="h-8 text-xs bg-background border border-input rounded px-2 text-foreground flex-1"
              defaultValue=""
            >
              <option value="" disabled>
                اختر التصنيف الهدف...
              </option>
              {rows
                .filter((r) => r.isActive && r.id !== mergeSource.id)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
            </select>
            <Button
              size="sm"
              variant="destructive"
              className="h-8"
              disabled={busy}
              onClick={() => {
                const sel = document.getElementById("merge-target") as HTMLSelectElement | null;
                const targetId = sel?.value ? Number(sel.value) : null;
                const target = rows.find((r) => r.id === targetId);
                if (target) doMerge(mergeSource, target);
              }}
            >
              تأكيد الدمج
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={() => setMergeSource(null)}
            >
              إلغاء
            </Button>
          </div>
        </div>
      )}

      {!isPanel && (
        <div className="px-5 py-3 border-t border-border flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            إغلاق
          </Button>
        </div>
      )}
    </>
  );

  if (isPanel) {
    return (
      <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
        {body}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        {body}
      </div>
    </div>
  );
}
