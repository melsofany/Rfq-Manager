import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/AuthContext";
import { canAccessPath } from "@/lib/permissions";
import { getApiErrorMessage } from "@/lib/api-error";
import { toast } from "sonner";
import { Pencil, X } from "lucide-react";

/** Read the server's JSON `{error}` message (falls back to the HTTP status). */
async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

interface ItemCategoryRow {
  customerRfqItemId: number;
  partNo: string | null;
  lineItem: string | null;
  description: string | null;
  uom: string | null;
  qty: string | null;
  isCancelled: boolean;
  customerRfqId: number | null;
  customerRfqNo: string | null;
  customerName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  categories: Array<{
    categoryId: number;
    categoryName: string | null;
    employeeId: number | null;
    employeeName: string | null;
    isPrimary: boolean;
  }>;
}

/**
 * The manager's per-item category editor. The item's PRIMARY category (the
 * classifier's pick, and what drives ownership) is locked; the manager adds or
 * removes the EXTRA categories the item also belongs to.
 */
export function ItemCategoriesEditor({
  item,
  onClose,
  onSaved,
}: {
  item: { itemId: number; label: string };
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [allCats, setAllCats] = useState<Array<{ id: number; name: string }>>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [primaryId, setPrimaryId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [catsRes, itemRes] = await Promise.all([
          fetch("/api/item-categories", { credentials: "include" }),
          fetch(`/api/customer-rfq/items/${item.itemId}/categories`, { credentials: "include" }),
        ]);
        if (cancelled) return;
        const cats = catsRes.ok
          ? ((await catsRes.json()) as Array<{ id: number; name: string }>)
          : [];
        setAllCats(cats.map((c) => ({ id: c.id, name: c.name })));
        if (itemRes.ok) {
          const json = (await itemRes.json()) as {
            primaryCategoryId?: number | null;
            categories: Array<{ categoryId: number; isPrimary: boolean }>;
          };
          setPrimaryId(json.primaryCategoryId ?? null);
          setSelected(new Set(json.categories.map((c) => c.categoryId)));
        }
      } catch {
        // ignore — the modal still opens with an empty list
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item.itemId]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        // The primary category cannot be un-selected — promote another one.
        if (id === primaryId) {
          const fallback = [...next][0] ?? null;
          setPrimaryId(fallback);
        }
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/customer-rfq/items/${item.itemId}/categories`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ categoryIds: [...selected], primaryCategoryId: primaryId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "فشل حفظ التصنيفات");
      }
      toast.success("تم حفظ تصنيفات البند");
      onSaved?.();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل حفظ التصنيفات");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-foreground">
            تصنيفات البند{" "}
            <span className="font-mono text-xs text-muted-foreground">{item.label}</span>
          </h2>
          <button onClick={onClose} className="text-muted-foreground">
            <X size={18} />
          </button>
        </div>
        {loading ? (
          <div className="text-sm text-muted-foreground">جارٍ التحميل…</div>
        ) : (
          <div className="max-h-72 overflow-y-auto space-y-1">
            {allCats.map((c) => {
              const isPrimary = c.id === primaryId;
              return (
                <label
                  key={c.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/40 text-sm cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                  />
                  <span className="text-foreground">{c.name}</span>
                  {isPrimary ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-100 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">
                      أساسي
                    </span>
                  ) : (
                    selected.has(c.id) && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          setPrimaryId(c.id);
                        }}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
                      >
                        تعيين أساسي
                      </button>
                    )
                  )}
                </label>
              );
            })}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            إلغاء
          </Button>
          <Button onClick={save} disabled={saving || loading}>
            {saving ? "جارٍ الحفظ…" : "حفظ"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The «بنود التصنيفات» list — EVERY item with its identity (line item / part
 * number / description) and its category. Visible to the whole team (read-only);
 * the category is edited per item by an admin/manager only.
 */
function ItemsCategoryList({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<ItemCategoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [allCats, setAllCats] = useState<Array<{ id: number; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<{ itemId: number; label: string } | null>(null);

  const PAGE = 100;

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/item-categories", { credentials: "include" });
      if (res.ok) setAllCats((await res.json()) as Array<{ id: number; name: string }>);
    })();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE),
        offset: String(offset),
      });
      if (search) params.set("search", search);
      if (catFilter !== "all") params.set("categoryId", catFilter);
      const res = await fetch(`/api/customer-rfq/item-categories?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(await readError(res));
      const json = (await res.json()) as { total: number; rows: ItemCategoryRow[] };
      setRows(json.rows);
      setTotal(json.total);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [search, catFilter, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const hasNext = offset + PAGE < total;
  const hasPrev = offset > 0;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">بنود التصنيفات</h2>
        <p className="text-sm text-muted-foreground mt-1">
          كل بند باسمه وورقة القطعة والـ Line Item والتصنيف الخاص به. العرض متاح للجميع، وتعديل
          التصنيف للمدير فقط.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setOffset(0);
            setSearch(searchInput.trim());
          }}
          className="flex gap-2 flex-1 min-w-[240px]"
        >
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="ابحث بورقة القطعة، Line Item، التوصيف، رقم الطلب، أو العميل…"
          />
          <Button type="submit" disabled={loading}>
            بحث
          </Button>
          {search && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setSearchInput("");
                setSearch("");
                setOffset(0);
              }}
            >
              مسح
            </Button>
          )}
        </form>
        <select
          value={catFilter}
          onChange={(e) => {
            setCatFilter(e.target.value);
            setOffset(0);
          }}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="all">كل التصنيفات</option>
          <option value="unclassified">غير مصنّف</option>
          {allCats.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.name}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {total.toLocaleString("en-US")} بند
        </span>
      </div>

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="overflow-auto max-h-[calc(100vh-260px)]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10">
              <tr className="bg-muted/60 border-b border-border text-right">
                <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Line Item</th>
                <th className="px-3 py-2 text-xs font-medium text-muted-foreground">
                  ورقة القطعة (Part No)
                </th>
                <th className="px-3 py-2 text-xs font-medium text-muted-foreground">
                  اسم البند (التوصيف)
                </th>
                <th className="px-3 py-2 text-xs font-medium text-muted-foreground">التصنيف</th>
                <th className="px-3 py-2 text-xs font-medium text-muted-foreground">طلب التسعير</th>
                {canEdit && (
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground">إجراء</th>
                )}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={canEdit ? 6 : 5}
                    className="px-4 py-10 text-center text-muted-foreground"
                  >
                    جارٍ التحميل…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={canEdit ? 6 : 5}
                    className="px-4 py-10 text-center text-muted-foreground"
                  >
                    لا توجد بنود مطابقة.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={r.customerRfqItemId}
                    className={`border-b border-border/40 last:border-0 hover:bg-muted/20 ${
                      r.isCancelled ? "opacity-60" : ""
                    }`}
                  >
                    <td className="px-3 py-2 font-mono whitespace-nowrap" dir="ltr">
                      {r.lineItem || "—"}
                    </td>
                    <td className="px-3 py-2 font-mono whitespace-nowrap" dir="ltr">
                      {r.partNo || "—"}
                    </td>
                    <td className="px-3 py-2">{r.description || "—"}</td>
                    <td className="px-3 py-2">
                      {r.categories.length > 0 ? (
                        <span className="inline-flex flex-wrap items-center gap-1">
                          {r.categories.map((c) => (
                            <span
                              key={c.categoryId}
                              title={
                                c.isPrimary
                                  ? `أساسي${c.employeeName ? ` — ${c.employeeName}` : ""}`
                                  : `إضافي${c.employeeName ? ` — ${c.employeeName}` : ""}`
                              }
                              className={
                                c.isPrimary
                                  ? "inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-teal-100 text-teal-800 dark:bg-teal-950/50 dark:text-teal-300"
                                  : "inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300"
                              }
                            >
                              {c.categoryName ?? "غير مصنّف"}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="text-amber-600 dark:text-amber-400 text-xs">
                          غير مصنّف
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {r.customerRfqNo ? (
                        <span className="font-mono text-xs" dir="ltr">
                          {r.customerRfqNo}
                        </span>
                      ) : (
                        "—"
                      )}
                      {r.customerName && (
                        <div className="text-xs text-muted-foreground">{r.customerName}</div>
                      )}
                    </td>
                    {canEdit && (
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setEditor({
                              itemId: r.customerRfqItemId,
                              label: r.partNo || r.lineItem || `بند #${r.customerRfqItemId}`,
                            })
                          }
                        >
                          <Pencil size={14} className="me-1" /> تعديل التصنيف
                        </Button>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {total > PAGE && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {offset + 1}–{Math.min(offset + PAGE, total)} من {total.toLocaleString("en-US")}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!hasPrev || loading}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
            >
              السابق
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasNext || loading}
              onClick={() => setOffset((o) => o + PAGE)}
            >
              التالي
            </Button>
          </div>
        </div>
      )}

      {editor && (
        <ItemCategoriesEditor item={editor} onClose={() => setEditor(null)} onSaved={load} />
      )}
    </div>
  );
}

export function ItemCategoriesTab() {
  const { employee } = useAuth();
  // Editing an item's category is for an admin or a manager.
  const canEdit = employee?.role === "admin" || employee?.role === "manager";

  if (!canAccessPath(employee?.role, employee?.permissions, "/items")) {
    return (
      <div className="p-8 text-center text-muted-foreground">ليس لديك صلاحية لعرض هذه الصفحة.</div>
    );
  }

  return (
    <div className="space-y-6">
      <ItemsCategoryList canEdit={canEdit} />
    </div>
  );
}
