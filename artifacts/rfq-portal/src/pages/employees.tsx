import { useState } from "react";
  import { useQueryClient } from "@tanstack/react-query";
  import {
    useListEmployees,
    useCreateEmployee,
    useUpdateEmployee,
    getListEmployeesQueryKey,
  } from "@workspace/api-client-react";
  import { Layout } from "@/components/Layout";
  import { Button } from "@/components/ui/button";
  import { Input } from "@/components/ui/input";
  import { Label } from "@/components/ui/label";
  import { useAuth } from "@/contexts/AuthContext";
  import { Plus, X, UserCog, Pencil, Trash2, ToggleLeft, ToggleRight, AlertTriangle } from "lucide-react";

  const ROLES = ["admin", "manager", "purchasing"];

  const ROLE_LABELS: Record<string, string> = {
    admin: "مدير النظام",
    manager: "مدير",
    purchasing: "مشتريات",
  };

  type EmpForm = { name: string; email: string; password: string; role: string; phone: string };
  const EMPTY_FORM: EmpForm = { name: "", email: "", password: "", role: "purchasing", phone: "" };

  export default function EmployeesPage() {
    const { employee: me } = useAuth();
    const queryClient = useQueryClient();

    // — Create state
    const [showCreate, setShowCreate] = useState(false);
    const [createForm, setCreateForm] = useState<EmpForm>(EMPTY_FORM);
    const [createError, setCreateError] = useState<string | null>(null);

    // — Edit state
    const [editId, setEditId] = useState<number | null>(null);
    const [editForm, setEditForm] = useState<EmpForm>(EMPTY_FORM);
    const [editError, setEditError] = useState<string | null>(null);

    // — Delete state
    const [deleteId, setDeleteId] = useState<number | null>(null);
    const [deleteLoading, setDeleteLoading] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const { data: employees, isLoading } = useListEmployees({
      query: { queryKey: getListEmployeesQueryKey() },
    });

    const refetch = () => queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });

    // — Create
    const createMutation = useCreateEmployee({
      mutation: {
        onSuccess: () => { refetch(); setShowCreate(false); setCreateForm(EMPTY_FORM); setCreateError(null); },
        onError: (err: unknown) => {
          const apiData = (err as { data?: { error?: string } })?.data;
          setCreateError(apiData?.error ?? "فشل في إضافة الموظف");
        },
      },
    });

    // — Update (edit / activate / deactivate)
    const updateMutation = useUpdateEmployee({
      mutation: {
        onSuccess: () => { refetch(); setEditId(null); setEditError(null); },
        onError: (err: unknown) => {
          const apiData = (err as { data?: { error?: string } })?.data;
          setEditError(apiData?.error ?? "فشل في تحديث بيانات الموظف");
        },
      },
    });

    function openEdit(emp: NonNullable<typeof employees>[number]) {
      setEditId(emp.id);
      setEditForm({ name: emp.name, email: emp.email, password: "", role: emp.role, phone: emp.phone ?? "" });
      setEditError(null);
    }

    function handleEditSubmit(e: React.FormEvent) {
      e.preventDefault();
      if (!editId) return;
      const payload: Record<string, unknown> = {
        name: editForm.name,
        email: editForm.email,
        role: editForm.role,
        phone: editForm.phone || null,
      };
      if (editForm.password) payload.password = editForm.password;
      updateMutation.mutate({ id: editId, data: payload as Parameters<typeof updateMutation.mutate>[0]["data"] });
    }

    function handleToggleActive(emp: NonNullable<typeof employees>[number]) {
      updateMutation.mutate({
        id: emp.id,
        data: { isActive: !emp.isActive } as Parameters<typeof updateMutation.mutate>[0]["data"],
      });
    }

    // — Delete
    async function handleDelete() {
      if (!deleteId) return;
      setDeleteLoading(true);
      setDeleteError(null);
      try {
        const r = await fetch(`/api/employees/${deleteId}`, {
          method: "DELETE", credentials: "include",
        });
        const data = await r.json();
        if (!r.ok) { setDeleteError(data.error ?? "فشل في الحذف"); return; }
        refetch();
        setDeleteId(null);
      } catch {
        setDeleteError("خطأ في الاتصال بالسيرفر");
      } finally {
        setDeleteLoading(false);
      }
    }

    if (me?.role !== "admin") {
      return (
        <Layout>
          <div className="p-6 text-muted-foreground text-sm">ليس لديك صلاحية الوصول — للمديرين فقط.</div>
        </Layout>
      );
    }

    const up = (form: EmpForm, set: (f: (p: EmpForm) => EmpForm) => void) =>
      (field: keyof EmpForm, value: string) => set((prev) => ({ ...prev, [field]: value }));

    const updateCreate = up(createForm, setCreateForm);
    const updateEdit = up(editForm, setEditForm);

    return (
      <Layout>
        <div className="p-6 space-y-5">

          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-foreground">الموظفون</h1>
              <p className="text-muted-foreground text-sm">إدارة الوصول والصلاحيات</p>
            </div>
            <Button onClick={() => { setShowCreate(true); setCreateError(null); }} size="sm" className="gap-1.5">
              <Plus size={15} /> إضافة موظف
            </Button>
          </div>

          {/* ── Create Form ─────────────────────────── */}
          {showCreate && (
            <div className="bg-card border border-border rounded-lg p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-sm text-foreground">موظف جديد</h2>
                <button onClick={() => { setShowCreate(false); setCreateError(null); }} className="text-muted-foreground hover:text-foreground">
                  <X size={16} />
                </button>
              </div>
              <form onSubmit={(e) => { e.preventDefault(); createMutation.mutate({ data: createForm as Parameters<typeof createMutation.mutate>[0]["data"] }); }} className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>الاسم الكامل *</Label>
                  <Input value={createForm.name} onChange={(e) => updateCreate("name", e.target.value)} placeholder="أحمد الرشيدي" required />
                </div>
                <div className="space-y-1.5">
                  <Label>البريد الإلكتروني *</Label>
                  <Input value={createForm.email} onChange={(e) => updateCreate("email", e.target.value)} type="email" placeholder="ahmed@cortoba-supplies.com" required />
                </div>
                <div className="space-y-1.5">
                  <Label>كلمة المرور *</Label>
                  <Input value={createForm.password} onChange={(e) => updateCreate("password", e.target.value)} type="password" placeholder="••••••••" required minLength={6} />
                </div>
                <div className="space-y-1.5">
                  <Label>الصلاحية *</Label>
                  <select value={createForm.role} onChange={(e) => updateCreate("role", e.target.value)}
                    className="w-full h-9 px-3 rounded border border-input bg-background text-sm text-foreground" required>
                    {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label>الهاتف</Label>
                  <Input value={createForm.phone} onChange={(e) => updateCreate("phone", e.target.value)} placeholder="+966-50-000-0000" />
                </div>
                <div className="col-span-2 space-y-2">
                  {createError && (
                    <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 text-right">
                      ⚠ {createError}
                    </div>
                  )}
                  <div className="flex gap-3 justify-end">
                    <Button type="button" variant="ghost" onClick={() => setShowCreate(false)} size="sm">إلغاء</Button>
                    <Button type="submit" size="sm" disabled={createMutation.isPending}>
                      {createMutation.isPending ? "جاري الحفظ..." : "إنشاء الموظف"}
                    </Button>
                  </div>
                </div>
              </form>
            </div>
          )}

          {/* ── Edit Modal ─────────────────────────── */}
          {editId !== null && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
              <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-foreground">تعديل بيانات الموظف</h2>
                  <button onClick={() => setEditId(null)} className="text-muted-foreground hover:text-foreground">
                    <X size={18} />
                  </button>
                </div>
                <form onSubmit={handleEditSubmit} className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>الاسم الكامل *</Label>
                    <Input value={editForm.name} onChange={(e) => updateEdit("name", e.target.value)} required />
                  </div>
                  <div className="space-y-1.5">
                    <Label>البريد الإلكتروني *</Label>
                    <Input value={editForm.email} onChange={(e) => updateEdit("email", e.target.value)} type="email" required />
                  </div>
                  <div className="space-y-1.5">
                    <Label>كلمة مرور جديدة <span className="text-muted-foreground text-xs">(اتركها فارغة للإبقاء)</span></Label>
                    <Input value={editForm.password} onChange={(e) => updateEdit("password", e.target.value)} type="password" placeholder="••••••••" minLength={6} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>الصلاحية *</Label>
                    <select value={editForm.role} onChange={(e) => updateEdit("role", e.target.value)}
                      className="w-full h-9 px-3 rounded border border-input bg-background text-sm text-foreground" required>
                      {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5 col-span-2">
                    <Label>الهاتف</Label>
                    <Input value={editForm.phone} onChange={(e) => updateEdit("phone", e.target.value)} placeholder="+966-50-000-0000" />
                  </div>
                  <div className="col-span-2 space-y-2">
                    {editError && (
                      <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 text-right">
                        ⚠ {editError}
                      </div>
                    )}
                    <div className="flex gap-3 justify-end">
                      <Button type="button" variant="ghost" onClick={() => setEditId(null)} size="sm">إلغاء</Button>
                      <Button type="submit" size="sm" disabled={updateMutation.isPending}>
                        {updateMutation.isPending ? "جاري الحفظ..." : "حفظ التعديلات"}
                      </Button>
                    </div>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* ── Delete Confirmation ────────────────── */}
          {deleteId !== null && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
              <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4 text-right">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                    <AlertTriangle size={18} className="text-red-600" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-foreground">تأكيد الحذف</h3>
                    <p className="text-sm text-muted-foreground">
                      هل أنت متأكد من حذف هذا الموظف؟ لا يمكن التراجع عن هذا الإجراء.
                    </p>
                  </div>
                </div>
                {deleteError && (
                  <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
                    ⚠ {deleteError}
                  </div>
                )}
                <div className="flex gap-2 justify-end">
                  <Button variant="ghost" size="sm" onClick={() => { setDeleteId(null); setDeleteError(null); }}>إلغاء</Button>
                  <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleteLoading}>
                    {deleteLoading ? "جاري الحذف..." : "نعم، احذف"}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* ── Employees Table ──────────────────────── */}
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            {isLoading ? (
              <div className="p-8 text-center text-muted-foreground text-sm">جاري التحميل...</div>
            ) : !employees?.length ? (
              <div className="p-12 text-center">
                <UserCog size={40} className="mx-auto text-muted-foreground/30 mb-3" />
                <p className="text-muted-foreground text-sm">لا يوجد موظفون</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/30 border-b border-border text-right">
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">الاسم</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">البريد</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">الهاتف</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">الصلاحية</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">الحالة</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">الإجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map((emp) => {
                    const isSelf = emp.id === me?.id;
                    return (
                      <tr key={emp.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold flex-shrink-0">
                              {emp.name[0]?.toUpperCase()}
                            </div>
                            <div>
                              <span className="font-medium text-foreground">{emp.name}</span>
                              {isSelf && <span className="text-xs text-muted-foreground mr-1">(أنت)</span>}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">{emp.email}</td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">{emp.phone ?? "—"}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                            emp.role === "admin" ? "bg-purple-50 text-purple-700"
                            : emp.role === "manager" ? "bg-blue-50 text-blue-700"
                            : "bg-muted text-muted-foreground"
                          }`}>
                            {ROLE_LABELS[emp.role] ?? emp.role}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                            emp.isActive ? "bg-green-50 text-green-700" : "bg-red-50 text-red-500"
                          }`}>
                            {emp.isActive ? "فعّال" : "موقوف"}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-center gap-1">
                            {/* Edit */}
                            <button
                              onClick={() => openEdit(emp)}
                              title="تعديل"
                              className="p-1.5 rounded hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition-colors"
                            >
                              <Pencil size={14} />
                            </button>

                            {/* Toggle active — cannot deactivate yourself */}
                            <button
                              onClick={() => handleToggleActive(emp)}
                              disabled={isSelf || updateMutation.isPending}
                              title={emp.isActive ? "إيقاف الموظف" : "تفعيل الموظف"}
                              className={`p-1.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                                emp.isActive
                                  ? "hover:bg-amber-50 text-muted-foreground hover:text-amber-600"
                                  : "hover:bg-green-50 text-muted-foreground hover:text-green-600"
                              }`}
                            >
                              {emp.isActive ? <ToggleRight size={15} /> : <ToggleLeft size={15} />}
                            </button>

                            {/* Delete — cannot delete yourself */}
                            {!isSelf && (
                              <button
                                onClick={() => { setDeleteId(emp.id); setDeleteError(null); }}
                                title="حذف الموظف"
                                className="p-1.5 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600 transition-colors"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </Layout>
    );
  }
  