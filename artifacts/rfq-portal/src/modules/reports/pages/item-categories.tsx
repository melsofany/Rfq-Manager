import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/AuthContext";
import { canAccessPath, hasPermission } from "@/lib/permissions";
import { getApiErrorMessage } from "@/lib/api-error";
import { toast } from "sonner";
import { Plus, Trash2, Pencil, Users, Tags, Check, X } from "lucide-react";

/** Read the server's JSON `{error}` message (falls back to the HTTP status). */
async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

interface ItemCategory {
  id: number;
  name: string;
  code: string | null;
  isActive: boolean;
  sortOrder: number;
}

interface Owner {
  employeeId: number;
  isPrimary: boolean;
  name: string;
}

interface ItemKeyword {
  id: number;
  categoryId: number;
  keyword: string;
  weight: number;
  language: string | null;
  enabled: boolean;
}

interface Employee {
  id: number;
  name: string;
  role: string;
  isActive: boolean;
}

export function ItemCategoriesTab() {
  const { employee } = useAuth();
  const [rows, setRows] = useState<ItemCategory[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editCode, setEditCode] = useState("");

  // owners editor
  const [ownersFor, setOwnersFor] = useState<ItemCategory | null>(null);
  const [owners, setOwners] = useState<Owner[]>([]);
  const [ownersLoading, setOwnersLoading] = useState(false);

  // keywords editor (the classifier's admin-managed vocabulary)
  const [keywordsFor, setKeywordsFor] = useState<ItemCategory | null>(null);
  const [keywords, setKeywords] = useState<ItemKeyword[]>([]);
  const [keywordsLoading, setKeywordsLoading] = useState(false);
  const [newKeyword, setNewKeyword] = useState("");
  const [newKeywordWeight, setNewKeywordWeight] = useState("");

  const canManage = hasPermission(employee?.role, employee?.permissions, "items:categories");
  const isAdmin = employee?.role === "admin";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [catsRes, empsRes] = await Promise.all([
        fetch("/api/item-categories", { credentials: "include" }),
        fetch("/api/employees", { credentials: "include" }),
      ]);
      if (!catsRes.ok) throw new Error(await catsRes.text());
      const cats = (await catsRes.json()) as ItemCategory[];
      setRows(cats);
      if (empsRes.ok) {
        const emps = (await empsRes.json()) as Employee[];
        setEmployees(emps.filter((e) => e.isActive));
      }
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canAccessPath(employee?.role, employee?.permissions, "/items")) {
    return (
      <div className="p-8 text-center text-muted-foreground">ليس لديك صلاحية لعرض هذه الصفحة.</div>
    );
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      const res = await fetch("/api/item-categories", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), code: newCode.trim() || null }),
      });
      if (!res.ok) throw new Error(await readError(res));
      toast.success("تم إنشاء التصنيف");
      setNewName("");
      setNewCode("");
      await load();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    }
  }

  async function handleSaveEdit(id: number) {
    try {
      const res = await fetch(`/api/item-categories/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName.trim(), code: editCode.trim() || null }),
      });
      if (!res.ok) throw new Error(await readError(res));
      toast.success("تم الحفظ");
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    }
  }

  async function handleToggle(id: number, isActive: boolean) {
    try {
      const res = await fetch(`/api/item-categories/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (!res.ok) throw new Error(await readError(res));
      await load();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("حذف هذا التصنيف؟ سيبقى تاريخ البنود لكن الإسناد يصبح «غير مصنّف».")) return;
    try {
      const res = await fetch(`/api/item-categories/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await readError(res));
      toast.success("تم الحذف");
      await load();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    }
  }

  async function openOwners(cat: ItemCategory) {
    setOwnersFor(cat);
    setOwnersLoading(true);
    try {
      const res = await fetch(`/api/item-categories/${cat.id}/owners`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(await readError(res));
      setOwners((await res.json()) as Owner[]);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
      setOwners([]);
    } finally {
      setOwnersLoading(false);
    }
  }

  function toggleOwner(empId: number) {
    setOwners((prev) => {
      const exists = prev.some((o) => o.employeeId === empId);
      if (exists) return prev.filter((o) => o.employeeId !== empId);
      return [...prev, { employeeId: empId, isPrimary: false, name: "" }];
    });
  }

  function setPrimary(empId: number) {
    setOwners((prev) => prev.map((o) => ({ ...o, isPrimary: o.employeeId === empId })));
  }

  async function saveOwners() {
    if (!ownersFor) return;
    try {
      const res = await fetch(`/api/item-categories/${ownersFor.id}/owners`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owners: owners.map((o) => ({ employeeId: o.employeeId, isPrimary: o.isPrimary })),
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      toast.success("تم تحديث المسؤولين");
      setOwnersFor(null);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    }
  }

  // ── keywords editor ────────────────────────────────────────────────────────
  async function openKeywords(cat: ItemCategory) {
    setKeywordsFor(cat);
    setKeywordsLoading(true);
    try {
      const res = await fetch(`/api/item-categories/${cat.id}/keywords`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(await readError(res));
      setKeywords((await res.json()) as ItemKeyword[]);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
      setKeywords([]);
    } finally {
      setKeywordsLoading(false);
    }
  }

  async function addKeyword(e: React.FormEvent) {
    e.preventDefault();
    if (!keywordsFor || !newKeyword.trim()) return;
    try {
      const res = await fetch(`/api/item-categories/${keywordsFor.id}/keywords`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keyword: newKeyword.trim(),
          weight: newKeywordWeight.trim() ? Number(newKeywordWeight) : 0,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setNewKeyword("");
      setNewKeywordWeight("");
      await openKeywords(keywordsFor);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    }
  }

  async function toggleKeyword(k: ItemKeyword) {
    if (!keywordsFor) return;
    try {
      const res = await fetch(`/api/item-categories/${keywordsFor.id}/keywords/${k.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !k.enabled }),
      });
      if (!res.ok) throw new Error(await readError(res));
      await openKeywords(keywordsFor);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    }
  }

  async function deleteKeyword(k: ItemKeyword) {
    if (!keywordsFor) return;
    try {
      const res = await fetch(`/api/item-categories/${keywordsFor.id}/keywords/${k.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await readError(res));
      await openKeywords(keywordsFor);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">تصنيفات البنود</h2>
        <p className="text-sm text-muted-foreground mt-1">
          التصنيفات التي تُبنى عليها مسؤولية كل موظف مشتريات. عيّن لكل تصنيف مَن يتولاه (واحد
          «أساسي» والباقي بدلاء).
        </p>
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive text-sm rounded-lg p-3">{error}</div>
      )}

      {canManage && (
        <form
          onSubmit={handleCreate}
          className="bg-card border border-border rounded-lg p-4 flex flex-wrap items-end gap-3"
        >
          <div className="flex-1 min-w-[200px]">
            <label className="text-xs text-muted-foreground">اسم التصنيف</label>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="مثال: قواطع"
            />
          </div>
          <div className="w-40">
            <label className="text-xs text-muted-foreground">الكود (اختياري)</label>
            <Input
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              placeholder="breakers"
            />
          </div>
          <Button type="submit" disabled={!newName.trim()}>
            <Plus size={16} className="me-1" /> إضافة
          </Button>
        </form>
      )}

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">لا توجد تصنيفات بعد.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/30 border-b border-border text-right">
                <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground">التصنيف</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground">الكود</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground">الحالة</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3">
                    {editing === c.id ? (
                      <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
                    ) : (
                      <span className="text-foreground">{c.name}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {editing === c.id ? (
                      <Input value={editCode} onChange={(e) => setEditCode(e.target.value)} />
                    ) : (
                      <span className="font-mono text-xs text-muted-foreground">
                        {c.code ?? "-"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => canManage && handleToggle(c.id, !c.isActive)}
                      className={`text-xs px-2 py-1 rounded ${c.isActive ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}
                    >
                      {c.isActive ? "مُفعَّل" : "موقوف"}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {editing === c.id ? (
                        <>
                          <Button size="sm" onClick={() => handleSaveEdit(c.id)}>
                            <Check size={14} />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                            <X size={14} />
                          </Button>
                        </>
                      ) : (
                        canManage && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setEditing(c.id);
                              setEditName(c.name);
                              setEditCode(c.code ?? "");
                            }}
                          >
                            <Pencil size={14} />
                          </Button>
                        )
                      )}
                      <Button size="sm" variant="ghost" onClick={() => openOwners(c)}>
                        <Users size={14} className="me-1" /> المسؤولون
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => openKeywords(c)}>
                        <Tags size={14} className="me-1" /> الكلمات المفتاحية
                      </Button>
                      {isAdmin && (
                        <Button size="sm" variant="ghost" onClick={() => handleDelete(c.id)}>
                          <Trash2 size={14} className="text-destructive" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {ownersFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-md p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-foreground">مسؤولو «{ownersFor.name}»</h2>
              <button onClick={() => setOwnersFor(null)} className="text-muted-foreground">
                <X size={18} />
              </button>
            </div>
            {ownersLoading ? (
              <div className="text-sm text-muted-foreground">جارٍ التحميل…</div>
            ) : (
              <div className="max-h-72 overflow-y-auto space-y-1">
                {employees.map((emp) => {
                  const owner = owners.find((o) => o.employeeId === emp.id);
                  return (
                    <div
                      key={emp.id}
                      className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-muted/40"
                    >
                      <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!!owner}
                          onChange={() => toggleOwner(emp.id)}
                        />
                        <span className="text-foreground">{emp.name}</span>
                        <span className="text-xs text-muted-foreground">({emp.role})</span>
                      </label>
                      {owner && (
                        <button
                          onClick={() => setPrimary(emp.id)}
                          className={`text-xs px-2 py-0.5 rounded ${owner.isPrimary ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
                        >
                          {owner.isPrimary ? "أساسي" : "تعيين أساسي"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOwnersFor(null)}>
                إلغاء
              </Button>
              <Button onClick={saveOwners} disabled={!isAdmin}>
                حفظ
              </Button>
            </div>
            {!isAdmin && (
              <p className="text-xs text-muted-foreground">
                تعديل المسؤولين متاح للمدير العام فقط.
              </p>
            )}
          </div>
        </div>
      )}

      {keywordsFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-lg p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-foreground">
                كلمات «{keywordsFor.name}» المفتاحية
              </h2>
              <button onClick={() => setKeywordsFor(null)} className="text-muted-foreground">
                <X size={18} />
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              الكلمات التي يستخدمها المُصنِّف الآلي لتمييز هذا التصنيف. الكلمة الموقوفة لا تُحذف —
              تبقى في السجل لكن لا تُستخدم. الوزن 0 يعني الوزن الافتراضي.
            </p>
            <form onSubmit={addKeyword} className="flex items-center gap-2">
              <Input
                placeholder="كلمة مفتاحية (عربي أو إنجليزي)"
                value={newKeyword}
                onChange={(e) => setNewKeyword(e.target.value)}
              />
              <Input
                placeholder="الوزن"
                className="w-20"
                value={newKeywordWeight}
                onChange={(e) => setNewKeywordWeight(e.target.value)}
              />
              <Button type="submit" size="sm" disabled={!canManage}>
                <Plus size={14} />
              </Button>
            </form>
            {keywordsLoading ? (
              <div className="text-sm text-muted-foreground">جارٍ التحميل…</div>
            ) : keywords.length === 0 ? (
              <div className="text-sm text-muted-foreground">لا توجد كلمات بعد.</div>
            ) : (
              <div className="max-h-72 overflow-y-auto flex flex-wrap gap-2">
                {keywords.map((k) => (
                  <span
                    key={k.id}
                    className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded border ${
                      k.enabled
                        ? "border-border text-foreground"
                        : "border-dashed border-border text-muted-foreground line-through"
                    }`}
                  >
                    <button
                      onClick={() => toggleKeyword(k)}
                      disabled={!canManage}
                      title={k.enabled ? "إيقاف" : "تفعيل"}
                    >
                      {k.keyword}
                    </button>
                    {k.weight !== 0 && <span className="text-muted-foreground">({k.weight})</span>}
                    {canManage && (
                      <button onClick={() => deleteKeyword(k)} title="حذف">
                        <X size={12} className="text-destructive" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
            <div className="flex justify-end">
              <Button variant="ghost" onClick={() => setKeywordsFor(null)}>
                إغلاق
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
