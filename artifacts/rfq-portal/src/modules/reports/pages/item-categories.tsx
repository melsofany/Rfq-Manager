import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/AuthContext";
import { canAccessPath, canManageItemAssignment } from "@/lib/permissions";
import { getApiErrorMessage } from "@/lib/api-error";
import { toast } from "sonner";

/** Read the server's JSON `{error}` message (falls back to the HTTP status). */
async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

interface CategoryOption {
  id: number;
  name: string;
}

interface EmployeeOption {
  id: number;
  name: string;
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
  /** The owner of the item's PRIMARY category — who is responsible for it. */
  employeeId: number | null;
  employeeName: string | null;
  categories: Array<{
    categoryId: number;
    categoryName: string | null;
    employeeId: number | null;
    employeeName: string | null;
    isPrimary: boolean;
  }>;
}

interface UnownedCategory {
  id: number;
  name: string;
  itemCount: number;
}

interface ClassificationConflict {
  identityKey: string;
  itemCount: number;
  categories: Array<{ id: number; name: string; count: number }>;
  sampleDescription: string | null;
}

/** Why an item needs a human decision — mirrors the server's three reasons. */
type ReviewReason = "unclassified" | "ambiguous" | "category_not_in_suppliers";

interface ReviewQueueItem {
  itemId: number;
  partNo: string | null;
  lineItem: string | null;
  description: string | null;
  customerRfqId: number | null;
  customerRfqNo: string | null;
  customerName: string | null;
  reason: ReviewReason;
  categoryId: number | null;
  categoryName: string | null;
  candidates: Array<{ id: number; name: string }>;
  confidence: number | null;
}

const REVIEW_REASON_LABEL: Record<ReviewReason, string> = {
  unclassified: "غير مصنّف — الذكاء الاصطناعي لم يتعرّف عليه",
  ambiguous: "مشتبه بين تصنيفين",
  category_not_in_suppliers: "تصنيفه غير موجود في تصنيفات الموردين",
};

const REVIEW_REASON_TONE: Record<ReviewReason, string> = {
  unclassified: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  ambiguous: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  category_not_in_suppliers:
    "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900 dark:text-fuchsia-200",
};

/**
 * The «تصنيفات البنود» tab — the SINGLE place item categorization and
 * responsibility are managed.
 *
 * The customer-RFQ page is read-only for this data: it shows the category and
 * the assigned employee, and links here. Editing is admin/manager only, by role
 * (assigning an item moves KPI responsibility between employees).
 */
function ItemsCategoryList({
  canManage,
  categories,
  employees,
  onChanged,
}: {
  canManage: boolean;
  categories: CategoryOption[];
  employees: EmployeeOption[];
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<ItemCategoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [allCats, setAllCats] = useState<CategoryOption[]>([]);
  const [loading, setLoading] = useState(true);

  // Per-item editor
  const [editFor, setEditFor] = useState<ItemCategoryRow | null>(null);
  const [editCategory, setEditCategory] = useState<number | "">("");
  const [editEmployee, setEditEmployee] = useState<number | "">("");
  const [editReason, setEditReason] = useState("");
  const [saving, setSaving] = useState(false);

  const PAGE = 100;

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/item-categories", { credentials: "include" });
      if (res.ok) setAllCats((await res.json()) as CategoryOption[]);
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

  function openEditor(r: ItemCategoryRow) {
    setEditFor(r);
    setEditCategory(r.categoryId ?? "");
    setEditEmployee(r.employeeId ?? "");
    setEditReason("");
  }

  async function saveEdit() {
    if (!editFor) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/customer-rfq/items/${editFor.customerRfqItemId}/assignment`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId: editCategory === "" ? null : Number(editCategory),
          employeeId: editEmployee === "" ? null : Number(editEmployee),
          reason: editReason.trim() || null,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      toast.success("تم تحديث التصنيف والمسؤول");
      setEditFor(null);
      await load();
      onChanged();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const hasNext = offset + PAGE < total;
  const hasPrev = offset > 0;
  const colCount = canManage ? 7 : 6;
  const categoryChoices = categories.length ? categories : allCats;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">تصنيفات البنود والمسؤولية</h2>
        <p className="text-sm text-muted-foreground mt-1">
          كل بند باسمه وورقة القطعة والـ Line Item والتصنيف والموظف المسند إليه. العرض متاح للجميع،
          وتعديل التصنيف والمسؤول للمدير أو الأدمن فقط.
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
                <th className="px-3 py-2 text-xs font-medium text-muted-foreground">
                  الموظف المسند إليه
                </th>
                <th className="px-3 py-2 text-xs font-medium text-muted-foreground">طلب التسعير</th>
                {canManage && <th className="px-3 py-2 w-16" />}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={colCount} className="px-4 py-10 text-center text-muted-foreground">
                    جارٍ التحميل…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="px-4 py-10 text-center text-muted-foreground">
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
                      {r.employeeName ? (
                        <span className="text-foreground">{r.employeeName}</span>
                      ) : (
                        <span className="text-amber-600 dark:text-amber-400 text-xs">
                          بلا مسؤول
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
                    {canManage && (
                      <td className="px-3 py-2 text-center">
                        <Button size="sm" variant="outline" onClick={() => openEditor(r)}>
                          تعديل
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

      {editFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
            <h2 className="font-semibold text-foreground">تعديل تصنيف البند ومسؤوله</h2>
            <p className="text-xs text-muted-foreground">
              {editFor.description ||
                editFor.partNo ||
                editFor.lineItem ||
                `بند #${editFor.customerRfqItemId}`}
            </p>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">التصنيف</label>
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={editCategory}
                onChange={(e) =>
                  setEditCategory(e.target.value === "" ? "" : Number(e.target.value))
                }
              >
                <option value="">— بلا تصنيف —</option>
                {categoryChoices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">الموظف المسؤول</label>
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={editEmployee}
                onChange={(e) =>
                  setEditEmployee(e.target.value === "" ? "" : Number(e.target.value))
                }
              >
                <option value="">— بلا مسؤول —</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">السبب (اختياري)</label>
              <Input value={editReason} onChange={(e) => setEditReason(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditFor(null)} disabled={saving}>
                إلغاء
              </Button>
              <Button onClick={saveEdit} disabled={saving}>
                حفظ
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Categories with NO responsible employee. Such a category classifies an item
 * but can never be assigned — the item shows «مصنّف — بلا مسؤول». Assigning an
 * owner here fixes every item of that category at once.
 */
function UnownedCategoriesPanel({
  employees,
  canManage,
  onChanged,
}: {
  employees: EmployeeOption[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<UnownedCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [assignFor, setAssignFor] = useState<UnownedCategory | null>(null);
  const [ownerId, setOwnerId] = useState<number | "">("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/customer-rfq/unowned-categories", { credentials: "include" });
      if (res.ok) setRows((await res.json()) as UnownedCategory[]);
    } catch {
      /* advisory — a failure must not blank the tab */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveOwner() {
    if (!assignFor || ownerId === "") return;
    setSaving(true);
    try {
      const res = await fetch(`/api/item-categories/${assignFor.id}/owners`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owners: [{ employeeId: Number(ownerId), isPrimary: true }] }),
      });
      if (!res.ok) throw new Error(await readError(res));
      toast.success("تم تعيين المسؤول — يمكن الآن إعادة الإسناد الآلي");
      setAssignFor(null);
      setOwnerId("");
      await load();
      onChanged();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading || rows.length === 0) {
    // Rendered as a sub-tab, so an empty state is required — returning null
    // would leave the operator staring at a blank pane with no explanation.
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-center">
        <p className="text-sm font-medium text-foreground">لا توجد تصنيفات بلا مسؤول</p>
        <p className="text-xs text-muted-foreground mt-1">
          كل تصنيف مُصنَّف عليه بنود له موظف مسؤول.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 p-4 space-y-3">
      <div>
        <h3 className="font-semibold text-sm text-foreground">تصنيفات بلا مسؤول ({rows.length})</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          هذه التصنيفات مُصنَّفة عليها بنود لكن ليس لها موظف مسؤول، لذلك تظهر بنودها «بلا مسؤول».
          عيّن مسؤولًا لكل تصنيف لإصلاح ذلك.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {rows.map((c) => (
          <div
            key={c.id}
            className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm"
          >
            <span className="font-medium text-foreground">{c.name}</span>
            <span className="text-xs text-muted-foreground">
              {c.itemCount.toLocaleString("en-US")} بند
            </span>
            {canManage && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setAssignFor(c);
                  setOwnerId("");
                }}
              >
                تعيين مسؤول
              </Button>
            )}
          </div>
        ))}
      </div>

      {assignFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
            <h2 className="font-semibold text-foreground">تعيين مسؤول للتصنيف</h2>
            <p className="text-xs text-muted-foreground">
              {assignFor.name} — {assignFor.itemCount.toLocaleString("en-US")} بند
            </p>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">الموظف المسؤول (أساسي)</label>
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={ownerId}
                onChange={(e) => setOwnerId(e.target.value === "" ? "" : Number(e.target.value))}
              >
                <option value="">— اختر موظفًا —</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAssignFor(null)} disabled={saving}>
                إلغاء
              </Button>
              <Button onClick={saveOwner} disabled={saving || ownerId === ""}>
                حفظ
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Identities whose items DISAGREE on their classification — «نفس البند: كهرباء في
 * طلب، إضاءة في طلب، غير مصنّف في الباقي». The operator sees this as the same item
 * changing owner from one request to the next. The repair unifies each identity
 * onto ONE domain (a manager's manual decision wins, else the majority) so the
 * KPI attributes every copy of the item to the same employee.
 */
function ClassificationConflictsPanel({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<ClassificationConflict[]>([]);
  const [loading, setLoading] = useState(true);
  const [repairing, setRepairing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/customer-rfq/classification-conflicts", {
        credentials: "include",
      });
      if (res.ok) {
        const body = (await res.json()) as { conflicts: ClassificationConflict[] };
        setRows(body.conflicts ?? []);
      }
    } catch {
      /* advisory */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runRepair() {
    setRepairing(true);
    try {
      const res = await fetch("/api/customer-rfq/classification-repair", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(await readError(res));
      const out = (await res.json()) as { identities: number; itemsFixed: number };
      toast.success(
        `تم توحيد ${out.identities.toLocaleString("en-US")} بندًا متضاربًا — أُصلح ${out.itemsFixed.toLocaleString("en-US")} صفًا`,
      );
      await load();
      onChanged();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setRepairing(false);
    }
  }

  if (loading || rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-center">
        <p className="text-sm font-medium text-foreground">لا يوجد تضارب في تصنيف البنود</p>
        <p className="text-xs text-muted-foreground mt-1">
          كل بند مصنَّف بنفس الطريقة في جميع الطلبات.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/30 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-sm text-foreground">
            تضارب تصنيف البند ({rows.length.toLocaleString("en-US")})
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            نفس البند مصنَّف بشكل مختلف بين الطلبات (مثال: «كهرباء» في طلب و«إضاءة» في آخر و«غير
            مصنّف» في الباقي). هذا هو سبب تغيّر الموظف المسؤول عن البند. التوحيد يجعل التصنيف واحدًا
            في كل الطلبات — قرار المدير اليدوي له الأولوية، وإلا الأغلبية.
          </p>
        </div>
        <Button size="sm" onClick={runRepair} disabled={repairing}>
          {repairing ? "جارٍ التوحيد…" : "توحيد التصنيف المتضارب"}
        </Button>
      </div>
      <div className="max-h-72 overflow-y-auto space-y-1.5">
        {rows.slice(0, 100).map((c) => (
          <div
            key={c.identityKey}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs"
          >
            <span className="font-medium text-foreground truncate max-w-md">
              {c.sampleDescription ?? c.identityKey}
            </span>
            <span className="text-muted-foreground">{c.itemCount.toLocaleString("en-US")} صف</span>
            <span className="flex flex-wrap gap-1">
              {c.categories.map((cat) => (
                <span key={cat.id} className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                  {cat.name} ×{cat.count.toLocaleString("en-US")}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * «بنود تحتاج مراجعة» — the items the automatic classifier could not place, so
 * a manager decides. Three reasons, each with its own guidance:
 *
 *  • «غير مصنّف» — the AI answered «غير معروف» and no keyword matched. The
 *    manager picks a category.
 *  • «مشتبه بين تصنيفين» — two domains scored equally, so the classifier
 *    refused to guess. Both are named; the manager breaks the tie.
 *  • «تصنيفه غير موجود في تصنيفات الموردين» — the item IS classified, but under
 *    a category that is not a trade category in `/suppliers`. The fix is a
 *    catalogue change, not an item change, and the panel says so.
 *
 * The manager resolves a row with the SAME per-item editor used by the list
 * below (`PATCH .../assignment`), so there is no second write path to keep in
 * sync and no extra permission to grant.
 */
function ReviewQueuePanel({
  categories,
  employees,
  canManage,
  onChanged,
}: {
  categories: CategoryOption[];
  employees: EmployeeOption[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<ReviewQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [reasonFilter, setReasonFilter] = useState<ReviewReason | "all">("all");
  const [editFor, setEditFor] = useState<ReviewQueueItem | null>(null);
  const [editCategory, setEditCategory] = useState<number | "">("");
  const [editEmployee, setEditEmployee] = useState<number | "">("");
  const [saving, setSaving] = useState(false);
  // The categories the backend treats as trade categories. The picker offers
  // ONLY these: choosing any other category would leave the item in the queue
  // (its reason is precisely «not in the supplier categories»), i.e. a fix that
  // does not fix. Read from the response so the rule lives in one place.
  const [tradeCategoryIds, setTradeCategoryIds] = useState<number[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/customer-rfq/classification-review-queue?limit=300", {
        credentials: "include",
      });
      if (res.ok) {
        const body = (await res.json()) as {
          items?: ReviewQueueItem[];
          tradeCategoryIds?: number[];
        };
        setRows(body.items ?? []);
        setTradeCategoryIds(body.tradeCategoryIds ?? null);
      }
    } catch {
      /* advisory — a failure must not blank the tab */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveResolution() {
    if (!editFor || editCategory === "") return;
    setSaving(true);
    try {
      const res = await fetch(`/api/customer-rfq/items/${editFor.itemId}/assignment`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId: Number(editCategory),
          employeeId: editEmployee === "" ? null : Number(editEmployee),
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      toast.success("تم تحديد التصنيف والمسؤول");
      setEditFor(null);
      setEditCategory("");
      setEditEmployee("");
      await load();
      onChanged();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const shown = reasonFilter === "all" ? rows : rows.filter((r) => r.reason === reasonFilter);
  const counts: Record<ReviewReason, number> = {
    unclassified: rows.filter((r) => r.reason === "unclassified").length,
    ambiguous: rows.filter((r) => r.reason === "ambiguous").length,
    category_not_in_suppliers: rows.filter((r) => r.reason === "category_not_in_suppliers").length,
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
        جارٍ التحميل…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="font-semibold text-sm text-foreground">
          بنود تحتاج مراجعة ({rows.length.toLocaleString("en-US")})
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          البنود التي لم يستطع التصنيف الآلي حسم تصنيفها — إما لأن الذكاء الاصطناعي لم يتعرّف عليها،
          أو لأنها مشتبهة بين تصنيفين، أو لأن تصنيفها غير موجود في تصنيفات الموردين. حدِّد التصنيف
          والمسؤول لكل بند لإخراجه من هذه القائمة.
        </p>
        <div className="flex flex-wrap gap-2 mt-3">
          {(["all", "unclassified", "ambiguous", "category_not_in_suppliers"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setReasonFilter(k)}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                reasonFilter === k
                  ? "border-primary bg-primary/10 text-primary font-medium"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {k === "all"
                ? `الكل (${rows.length.toLocaleString("en-US")})`
                : `${REVIEW_REASON_LABEL[k]} (${counts[k].toLocaleString("en-US")})`}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-6 text-center">
          <p className="text-sm font-medium text-foreground">لا توجد بنود تحتاج مراجعة</p>
          <p className="text-xs text-muted-foreground mt-1">
            كل بند مصنَّف تصنيفًا موجودًا في تصنيفات الموردين.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="text-right px-3 py-2 font-medium">البند</th>
                  <th className="text-right px-3 py-2 font-medium">رقم الطلب</th>
                  <th className="text-right px-3 py-2 font-medium">السبب</th>
                  <th className="text-right px-3 py-2 font-medium">التصنيف الحالي</th>
                  <th className="text-right px-3 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, 200).map((r) => (
                  <tr key={r.itemId} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      <div className="font-medium text-foreground">
                        {r.description ?? r.partNo ?? r.lineItem ?? `#${r.itemId}`}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {[r.partNo && `قطعة: ${r.partNo}`, r.lineItem && `بند: ${r.lineItem}`]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {r.customerRfqNo ?? "—"}
                      {r.customerName ? <div>{r.customerName}</div> : null}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block rounded px-2 py-0.5 text-xs ${REVIEW_REASON_TONE[r.reason]}`}
                      >
                        {REVIEW_REASON_LABEL[r.reason]}
                      </span>
                      {r.reason === "ambiguous" && r.candidates.length > 0 ? (
                        <div className="text-xs text-muted-foreground mt-1">
                          {r.candidates.map((c) => c.name).join(" / ")}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {r.categoryName ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canManage && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditFor(r);
                            setEditCategory(r.categoryId ?? "");
                            setEditEmployee("");
                          }}
                        >
                          تحديد التصنيف
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
            <h2 className="font-semibold text-foreground">تحديد تصنيف البند</h2>
            <p className="text-xs text-muted-foreground">
              {editFor.description ?? editFor.partNo ?? `#${editFor.itemId}`}
            </p>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">التصنيف (مجال وظيفي)</label>
              <select
                value={editCategory}
                onChange={(e) =>
                  setEditCategory(e.target.value === "" ? "" : Number(e.target.value))
                }
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="">— اختر تصنيفًا —</option>
                {(tradeCategoryIds
                  ? categories.filter((c) => tradeCategoryIds.includes(c.id))
                  : categories
                ).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                تُعرض تصنيفات الموردين فقط — اختيار أي تصنيف آخر يُبقي البند في هذه القائمة.
              </p>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">الموظف المسؤول (اختياري)</label>
              <select
                value={editEmployee}
                onChange={(e) =>
                  setEditEmployee(e.target.value === "" ? "" : Number(e.target.value))
                }
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="">— بلا مسؤول —</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditFor(null)}
                disabled={saving}
              >
                إلغاء
              </Button>
              <Button size="sm" onClick={saveResolution} disabled={saving || editCategory === ""}>
                {saving ? "جارٍ الحفظ…" : "حفظ"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ItemCategoriesTab() {
  const { employee } = useAuth();
  const canManage = canManageItemAssignment(employee?.role, employee?.permissions);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [classifying, setClassifying] = useState(false);
  const [sub, setSub] = useState<"list" | "unowned" | "review">("list");

  const onChanged = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    void (async () => {
      try {
        const [cRes, eRes] = await Promise.all([
          fetch("/api/item-categories", { credentials: "include" }),
          fetch("/api/employees", { credentials: "include" }),
        ]);
        if (cRes.ok) setCategories((await cRes.json()) as CategoryOption[]);
        if (eRes.ok)
          setEmployees(
            ((await eRes.json()) as Array<EmployeeOption & { isActive?: boolean }>).filter(
              (e) => e.isActive !== false,
            ),
          );
      } catch {
        /* selects degrade to empty; the list still renders */
      }
    })();
  }, []);

  async function runBulkClassify() {
    setClassifying(true);
    try {
      const res = await fetch("/api/customer-rfq/items/classify", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(await readError(res));
      const out = (await res.json()) as { scanned: number; classified: number };
      toast.success(`التصنيف الآلي: فُحص ${out.scanned}، صُنّف ${out.classified}`);
      onChanged();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setClassifying(false);
    }
  }

  if (!canAccessPath(employee?.role, employee?.permissions, "/items")) {
    return (
      <div className="p-8 text-center text-muted-foreground">ليس لديك صلاحية لعرض هذه الصفحة.</div>
    );
  }

  // Sub-tabs. The unowned and review panels used to sit ABOVE the list, which
  // pushed the actual category table below the fold; each is now its own pane.
  const subTabs = [
    { key: "list" as const, label: "التصنيفات" },
    { key: "unowned" as const, label: "بلا مسؤول" },
    { key: "review" as const, label: "بنود تحتاج مراجعة" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex gap-1 border-b border-border">
        {subTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setSub(t.key)}
            className={`inline-flex items-center px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              sub === t.key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {sub === "unowned" ? (
        <UnownedCategoriesPanel employees={employees} canManage={canManage} onChanged={onChanged} />
      ) : sub === "review" ? (
        <ReviewQueuePanel
          categories={categories}
          employees={employees}
          canManage={canManage}
          onChanged={onChanged}
        />
      ) : (
        <>
          {canManage && <ClassificationConflictsPanel onChanged={onChanged} />}
          {canManage && (
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={runBulkClassify} disabled={classifying}>
                {classifying ? "جارٍ التصنيف الآلي…" : "تصنيف آلي للبنود غير المصنّفة"}
              </Button>
            </div>
          )}
          <ItemsCategoryList
            key={reloadKey}
            canManage={canManage}
            categories={categories}
            employees={employees}
            onChanged={onChanged}
          />
        </>
      )}
    </div>
  );
}
