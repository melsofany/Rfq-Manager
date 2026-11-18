import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronLeft,
  GitMerge,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Users,
  X,
} from "lucide-react";

/** One trade category as the categories API returns it. */
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

const INDENT_PX = 24;

function StatTile({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-md bg-muted/40 px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p
        className={cn(
          "text-base font-semibold tabular-nums",
          warn ? "text-amber-700 dark:text-amber-400" : "text-foreground",
        )}
      >
        {value}
      </p>
    </div>
  );
}

interface SupplierLite {
  id: number;
  name: string;
  isActive?: boolean;
  categories?: string[];
}

/**
 * The suppliers that belong to one trade category. Each supplier shows its
 * OTHER categories too, because a supplier can belong to several.
 */
function CategorySuppliers({ categoryName, indent }: { categoryName: string; indent: number }) {
  const { t } = useLanguage();
  const [, navigate] = useLocation();
  const { data = [], isLoading } = useQuery<SupplierLite[]>({
    queryKey: ["suppliers-by-category", categoryName],
    queryFn: async () => {
      const res = await fetch(`/api/suppliers?category=${encodeURIComponent(categoryName)}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("failed");
      return (await res.json()) as SupplierLite[];
    },
    staleTime: 60 * 1000,
  });

  if (isLoading) {
    return (
      <p
        className="border-t border-border bg-muted/20 py-3 text-xs text-muted-foreground"
        style={{ paddingInlineStart: indent + 32 }}
      >
        {t("sup.loading")}
      </p>
    );
  }
  if (data.length === 0) {
    return (
      <p
        className="border-t border-border bg-muted/20 py-3 text-xs text-muted-foreground"
        style={{ paddingInlineStart: indent + 32 }}
      >
        {t("sup.cm.noSuppliersHere")}
      </p>
    );
  }
  return (
    <ul className="border-t border-border bg-muted/20 py-1">
      {data.map((sup) => {
        const others = (sup.categories ?? []).filter((n) => n !== categoryName);
        return (
          <li key={sup.id}>
            <button
              type="button"
              onClick={() => navigate(`/suppliers/${sup.id}`)}
              className="flex w-full items-center gap-3 py-2 pe-4 text-start transition-colors hover:bg-muted/50"
              style={{ paddingInlineStart: indent + 32 }}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {sup.name}
                </span>
                {others.length > 0 && (
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {t("sup.cm.alsoIn")} {others.join("، ")}
                  </span>
                )}
              </span>
              {sup.isActive === false && (
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {t("sup.inactive")}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Management of the TRADE categories: add, rename, move under a parent, merge,
 * delete (restorable) and restore.
 *
 * Rules kept from the earlier design:
 *   • a deleted category is hidden, never removed, and can be restored;
 *   • a merge is an explicit two-step action, shown right under the row it
 *     applies to, and nothing merges on name similarity;
 *   • every row shows how many suppliers it holds, so an unused category is
 *     visible before anyone tidies it away.
 */
export function TradeCategoryManager() {
  const { t } = useLanguage();
  const [rows, setRows] = useState<CategoryRow[]>([]);
  const [report, setReport] = useState<ReportData | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newParentId, setNewParentId] = useState<number | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editParentId, setEditParentId] = useState<number | null>(null);

  const [mergeSourceId, setMergeSourceId] = useState<number | null>(null);
  const [openSuppliers, setOpenSuppliers] = useState<Set<number>>(new Set());
  const [showGroups, setShowGroups] = useState(false);
  const [groupTargets, setGroupTargets] = useState<Record<string, number>>({});
  // A group merge is two steps: choose, then confirm with the consequences shown.
  const [pendingMerge, setPendingMerge] = useState<{ key: string; targetId: number } | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState<number | null>(null);

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
      setAdding(false);
    }, t("sup.cm.added"));
  };

  const startEdit = (c: CategoryRow) => {
    setMergeSourceId(null);
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
    }, t("sup.cm.saved"));
  };

  const softDelete = (c: CategoryRow) => {
    void run(
      () => api(`/categories/${c.id}`, { method: "DELETE" }),
      t("sup.cm.deleted", { name: c.name }),
    );
  };

  const restore = (c: CategoryRow) => {
    void run(
      () => api(`/categories/${c.id}/restore`, { method: "POST" }),
      t("sup.cm.restored", { name: c.name }),
    );
  };

  const startMerge = (c: CategoryRow) => {
    setEditingId(null);
    setMergeSourceId(c.id);
    setMergeTargetId(null);
  };

  const doMerge = (source: CategoryRow, target: CategoryRow) => {
    setMergeSourceId(null);
    void run(
      () =>
        api("/categories/merge", {
          method: "POST",
          body: JSON.stringify({ sourceId: source.id, targetId: target.id }),
        }),
      t("sup.cm.merged", { source: source.name, target: target.name }),
    );
  };

  const toggleSuppliers = (id: number) =>
    setOpenSuppliers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleCollapsed = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ── Tree ──────────────────────────────────────────────────────────────────
  const { roots, childrenOf } = useMemo(() => {
    const active = rows.filter((r) => showDeleted || r.isActive);
    const q = search.trim().toLowerCase();
    const matched = q ? active.filter((r) => r.name.toLowerCase().includes(q)) : active;
    // When searching, keep a matching child's parent visible so the tree reads.
    const ids = new Set(matched.map((r) => r.id));
    const visible = q
      ? active.filter((r) => ids.has(r.id) || (r.parentId != null && ids.has(r.parentId)))
      : active;
    const present = new Set(visible.map((r) => r.id));
    const childrenOf = new Map<number, CategoryRow[]>();
    const roots: CategoryRow[] = [];
    for (const r of visible) {
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

  const activeRows = useMemo(() => rows.filter((r) => r.isActive), [rows]);
  const mergeSource = rows.find((r) => r.id === mergeSourceId) ?? null;

  // Similar-name groups from the report, restricted to ACTIVE members so a
  // deleted spelling never offers itself as a merge target.
  const dupGroups = useMemo(() => {
    if (!report) return [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return report.duplicates
      .map((g) => ({
        key: g.key,
        members: g.categories
          .map((c) => byId.get(c.id))
          .filter((r): r is CategoryRow => Boolean(r && r.isActive)),
      }))
      .filter((g) => g.members.length >= 2);
  }, [report, rows]);

  // The name that already holds the most suppliers is the sensible default to keep.
  const defaultKeep = (members: CategoryRow[]) =>
    members.reduce((best, m) => (m.supplierCount > best.supplierCount ? m : best), members[0]);

  const mergeGroup = (members: CategoryRow[], targetId: number) => {
    const target = members.find((m) => m.id === targetId);
    if (!target) return;
    const sources = members.filter((m) => m.id !== targetId);
    void run(
      async () => {
        for (const src of sources) {
          await api("/categories/merge", {
            method: "POST",
            body: JSON.stringify({ sourceId: src.id, targetId }),
          });
        }
      },
      t("sup.cm.groupMerged", { n: sources.length, target: target.name }),
    );
  };

  const renderRow = (c: CategoryRow, depth: number): React.ReactNode => {
    const subs = childrenOf.get(c.id) ?? [];
    const isCollapsed = collapsed.has(c.id);
    const editing = editingId === c.id;
    const merging = mergeSourceId === c.id;

    return (
      <div key={c.id} className="border-b border-border last:border-0">
        <div
          className={cn(
            "flex items-center gap-2 py-2 pe-3 transition-colors hover:bg-muted/30",
            !c.isActive && "opacity-60",
            editing && "bg-muted/20",
          )}
          style={{ paddingInlineStart: 12 + depth * INDENT_PX }}
        >
          {subs.length > 0 ? (
            <button
              type="button"
              onClick={() => toggleCollapsed(c.id)}
              aria-label={isCollapsed ? t("sup.cm.expand") : t("sup.cm.collapse")}
              className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {isCollapsed ? <ChevronLeft size={14} /> : <ChevronDown size={14} />}
            </button>
          ) : (
            <span className="size-6 shrink-0" aria-hidden />
          )}

          {editing ? (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="h-8 min-w-[160px] flex-1 text-sm"
                autoFocus
                aria-label={t("sup.cm.newName")}
              />
              <select
                value={editParentId ?? ""}
                onChange={(e) => setEditParentId(e.target.value ? Number(e.target.value) : null)}
                aria-label={t("sup.cm.primary")}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
              >
                <option value="">{t("sup.cm.primary")}</option>
                {activeRows
                  .filter((r) => r.id !== c.id)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
              <Button
                size="sm"
                className="h-8 gap-1"
                disabled={busy}
                onClick={() => saveEdit(c.id)}
              >
                <Check size={14} /> {t("sup.cm.save")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1"
                onClick={() => setEditingId(null)}
              >
                <X size={14} /> {t("sup.cm.cancel")}
              </Button>
            </div>
          ) : (
            <>
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "truncate text-sm text-foreground",
                    depth === 0 ? "font-semibold" : "text-muted-foreground",
                  )}
                >
                  {c.name}
                  {!c.isActive && (
                    <span className="ms-2 text-[11px] font-normal text-destructive">
                      {t("sup.cm.deletedTag")}
                    </span>
                  )}
                </p>
              </div>

              <span
                title={t("sup.cm.supplierCount")}
                className={cn(
                  "shrink-0 rounded-md px-2 py-0.5 text-xs tabular-nums",
                  c.supplierCount === 0
                    ? "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {c.supplierCount}
              </span>

              <div className="flex shrink-0 items-center gap-1">
                {c.isActive ? (
                  <>
                    {c.supplierCount > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 px-2 text-xs"
                        onClick={() => toggleSuppliers(c.id)}
                        aria-expanded={openSuppliers.has(c.id)}
                      >
                        <Users size={13} />{" "}
                        {openSuppliers.has(c.id)
                          ? t("sup.cm.hideSuppliers")
                          : t("sup.cm.showSuppliers")}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 px-2 text-xs"
                      onClick={() => startEdit(c)}
                      disabled={busy}
                      title={t("sup.cm.edit")}
                    >
                      <Pencil size={13} /> {t("sup.cm.edit")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 px-2 text-xs"
                      onClick={() => startMerge(c)}
                      disabled={busy || activeRows.length < 2}
                      title={t("sup.cm.merge")}
                    >
                      <GitMerge size={13} /> {t("sup.cm.mergeShort")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
                      onClick={() => softDelete(c)}
                      disabled={busy}
                      title={t("sup.cm.delete")}
                    >
                      <Trash2 size={13} /> {t("sup.cm.deleteShort")}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs hover:text-green-700"
                    onClick={() => restore(c)}
                    disabled={busy}
                    title={t("sup.cm.restore")}
                  >
                    <RotateCcw size={13} /> {t("sup.cm.restore")}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>

        {merging && mergeSource && (
          <div
            className="flex flex-wrap items-center gap-2 border-t border-amber-200 bg-amber-50 py-3 pe-3 dark:border-amber-900 dark:bg-amber-950/30"
            style={{ paddingInlineStart: 12 + depth * INDENT_PX + 32 }}
          >
            <p className="w-full text-xs leading-relaxed text-foreground">
              {t("sup.cm.mergePrompt", { name: mergeSource.name })}
            </p>
            <select
              value={mergeTargetId ?? ""}
              onChange={(e) => setMergeTargetId(e.target.value ? Number(e.target.value) : null)}
              aria-label={t("sup.cm.pickTarget")}
              className="h-8 min-w-[200px] flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground"
            >
              <option value="">{t("sup.cm.pickTarget")}</option>
              {activeRows
                .filter((r) => r.id !== mergeSource.id)
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
              disabled={busy || mergeTargetId == null}
              onClick={() => {
                const target = rows.find((r) => r.id === mergeTargetId);
                if (target) doMerge(mergeSource, target);
              }}
            >
              {t("sup.cm.confirmMerge")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={() => setMergeSourceId(null)}
            >
              {t("sup.cm.cancel")}
            </Button>
          </div>
        )}

        {openSuppliers.has(c.id) && c.isActive && (
          <CategorySuppliers categoryName={c.name} indent={12 + depth * INDENT_PX} />
        )}
        {!isCollapsed && subs.map((s) => renderRow(s, depth + 1))}
      </div>
    );
  };

  return (
    <div>
      {/* Toolbar: search, the deleted toggle, and the add action */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <div className="relative min-w-[200px] flex-1">
          <Search
            size={14}
            aria-hidden
            className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("sup.cm.search")}
            aria-label={t("sup.cm.search")}
            className="h-8 pr-8 text-sm"
          />
        </div>
        <Button
          variant={showDeleted ? "secondary" : "outline"}
          size="sm"
          className="h-8 gap-1.5"
          aria-pressed={showDeleted}
          onClick={() => setShowDeleted((v) => !v)}
        >
          {t("sup.cm.showDeleted")}
        </Button>
        <Button
          size="sm"
          className="h-8 gap-1.5"
          aria-expanded={adding}
          onClick={() => setAdding((v) => !v)}
        >
          <Plus size={14} /> {t("sup.cm.newCategory")}
        </Button>
      </div>

      {/* Add form — only while adding, so the list stays the focus */}
      {adding && (
        <form
          onSubmit={handleAdd}
          className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/20 px-4 py-3"
        >
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("sup.cm.newName")}
            aria-label={t("sup.cm.newName")}
            className="h-8 min-w-[180px] flex-1 text-sm"
            autoFocus
          />
          <select
            value={newParentId ?? ""}
            onChange={(e) => setNewParentId(e.target.value ? Number(e.target.value) : null)}
            aria-label={t("sup.cm.primaryNoParent")}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
          >
            <option value="">{t("sup.cm.primaryNoParent")}</option>
            {activeRows
              .filter((r) => r.parentId == null)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
          </select>
          <Button type="submit" size="sm" className="h-8" disabled={busy || !newName.trim()}>
            {t("sup.cm.add")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8"
            onClick={() => {
              setAdding(false);
              setNewName("");
              setNewParentId(null);
            }}
          >
            {t("sup.cm.cancel")}
          </Button>
        </form>
      )}

      {/* Summary tiles */}
      {report && (
        <div className="grid grid-cols-2 gap-2 border-b border-border px-4 py-3 sm:grid-cols-4">
          <StatTile label={t("sup.cm.totalActive")} value={report.totals.active} />
          <StatTile
            label={t("sup.cm.unusedLabel")}
            value={report.totals.unused}
            warn={report.totals.unused > 0}
          />
          <StatTile
            label={t("sup.cm.duplicateLabel")}
            value={report.totals.duplicateGroups}
            warn={report.totals.duplicateGroups > 0}
          />
          <StatTile label={t("sup.cm.deletedLabel")} value={report.totals.deleted} />
        </div>
      )}

      {/* Similar-name groups, with a merge action per group */}
      {dupGroups.length > 0 && (
        <div className="border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
              {t("sup.cm.dupHint")}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              aria-expanded={showGroups}
              onClick={() => setShowGroups((v) => !v)}
            >
              {showGroups ? t("sup.cm.hideGroups") : t("sup.cm.showGroups")} ({dupGroups.length})
            </Button>
          </div>
          {showGroups && (
            <ul className="mt-3 space-y-3">
              {dupGroups.map((g) => {
                const target = groupTargets[g.key] ?? defaultKeep(g.members).id;
                return (
                  <li key={g.key} className="rounded-md border border-border p-3">
                    <div className="mb-3 flex flex-wrap gap-1.5">
                      {g.members.map((m) => (
                        <span
                          key={m.id}
                          className="rounded-md bg-muted px-2 py-0.5 text-xs text-foreground"
                        >
                          {m.name}{" "}
                          <span className="tabular-nums text-muted-foreground">
                            ({m.supplierCount})
                          </span>
                        </span>
                      ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="text-xs text-muted-foreground" htmlFor={`keep-${g.key}`}>
                        {t("sup.cm.keepTarget")}
                      </label>
                      <select
                        id={`keep-${g.key}`}
                        value={target}
                        onChange={(e) =>
                          setGroupTargets((prev) => ({ ...prev, [g.key]: Number(e.target.value) }))
                        }
                        className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                      >
                        {g.members.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                      {pendingMerge?.key === g.key ? null : (
                        <Button
                          size="sm"
                          className="h-8"
                          disabled={busy}
                          onClick={() => setPendingMerge({ key: g.key, targetId: target })}
                        >
                          {t("sup.cm.mergeGroup")}
                        </Button>
                      )}
                    </div>
                    {pendingMerge?.key === g.key &&
                      (() => {
                        const targetName =
                          g.members.find((m) => m.id === pendingMerge.targetId)?.name ?? "";
                        const movers = g.members
                          .filter((m) => m.id !== pendingMerge.targetId)
                          .reduce((sum, m) => sum + m.supplierCount, 0);
                        return (
                          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
                            <p className="w-full text-xs leading-relaxed text-foreground">
                              {t("sup.cm.mergeConfirm", { n: movers, target: targetName })}
                            </p>
                            <Button
                              size="sm"
                              variant="destructive"
                              className="h-8"
                              disabled={busy}
                              onClick={() => {
                                setPendingMerge(null);
                                mergeGroup(g.members, pendingMerge.targetId);
                              }}
                            >
                              {t("sup.cm.confirmMerge")}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8"
                              onClick={() => setPendingMerge(null)}
                            >
                              {t("sup.cm.cancel")}
                            </Button>
                          </div>
                        );
                      })()}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Messages */}
      {(error || okMsg) && (
        <div className="px-4 pt-3">
          {error && (
            <p className="flex items-center gap-1.5 text-xs text-destructive">
              <AlertCircle size={13} aria-hidden /> {error}
            </p>
          )}
          {okMsg && (
            <p className="flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400">
              <Check size={13} aria-hidden /> {okMsg}
            </p>
          )}
        </div>
      )}

      {/* List */}
      <div className="py-1">
        {roots.length === 0 && !busy ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t("sup.cat.empty")}</p>
        ) : (
          roots.map((r) => renderRow(r, 0))
        )}
      </div>
    </div>
  );
}
