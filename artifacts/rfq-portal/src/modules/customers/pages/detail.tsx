import { useState } from "react";
import { useParams, Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCustomer,
  useUpdateCustomer,
  useDeleteCustomer,
  getGetCustomerQueryKey,
  getListCustomersQueryKey,
} from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft,
  Mail,
  Phone,
  MapPin,
  Pencil,
  Trash2,
  X,
  Check,
  AlertCircle,
  User,
  FileText,
  Hash,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { getApiErrorMessage } from "@/lib/api-error";

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const customerId = parseInt(id, 10);
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { employee } = useAuth();
  const canManage = employee?.role === "admin" || employee?.role === "manager";

  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [form, setForm] = useState({
    customerId: "",
    name: "",
    nickname: "",
    contactPerson: "",
    email: "",
    phone: "",
    address: "",
    taxId: "",
    notes: "",
    isActive: true,
  });

  const { data: customer, isLoading } = useGetCustomer(customerId, {
    query: { queryKey: getGetCustomerQueryKey(customerId), enabled: !!customerId },
  });

  const updateMutation = useUpdateCustomer({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCustomerQueryKey(customerId) });
        queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
        setEditing(false);
        setServerError(null);
      },
      onError: (err: unknown) => {
        setServerError(getApiErrorMessage(err, "حدث خطأ أثناء الحفظ"));
      },
    },
  });

  const deleteMutation = useDeleteCustomer({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
        navigate("/customers");
      },
      onError: (err: unknown) => {
        setServerError(getApiErrorMessage(err, "تعذر حذف العميل"));
        setConfirmDelete(false);
      },
    },
  });

  const startEdit = () => {
    if (!customer) return;
    setForm({
      customerId: customer.customerId ?? "",
      name: customer.name,
      nickname: customer.nickname ?? "",
      contactPerson: customer.contactPerson ?? "",
      email: customer.email ?? "",
      phone: customer.phone ?? "",
      address: customer.address ?? "",
      taxId: customer.taxId ?? "",
      notes: customer.notes ?? "",
      isActive: customer.isActive,
    });
    setServerError(null);
    setEditing(true);
  };

  const saveEdit = () => {
    if (!form.name.trim() || !form.phone.trim() || !form.address.trim()) {
      setServerError("الاسم ورقم الهاتف والعنوان مطلوبة");
      return;
    }
    setServerError(null);
    updateMutation.mutate({
      id: customerId,
      data: {
        ...form,
        name: form.name.trim(),
        phone: form.phone.trim(),
        address: form.address.trim(),
      } as Parameters<typeof updateMutation.mutate>[0]["data"],
    });
  };

  const handleDelete = () => {
    setDeleting(true);
    setServerError(null);
    deleteMutation.mutate({ id: customerId });
    setDeleting(false);
  };

  const upd = (field: string, value: string | boolean) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  if (isLoading) {
    return (
      <Layout>
        <div className="p-4 sm:p-6 text-muted-foreground text-sm">جارٍ التحميل...</div>
      </Layout>
    );
  }
  if (!customer) {
    return (
      <Layout>
        <div className="p-4 sm:p-6 text-muted-foreground text-sm">العميل غير موجود.</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="p-4 sm:p-6 max-w-4xl space-y-5">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link href="/customers">
              <a className="text-muted-foreground hover:text-foreground">
                <ArrowLeft size={18} />
              </a>
            </Link>
            <div>
              <h1 className="text-xl font-bold text-foreground">{customer.name}</h1>
              {customer.customerId && (
                <p className="text-muted-foreground text-xs font-mono">{customer.customerId}</p>
              )}
            </div>
          </div>
          {!editing && (
            <div className="flex items-center gap-2">
              {canManage && (
                <Button variant="outline" size="sm" className="gap-1.5" onClick={startEdit}>
                  <Pencil size={13} /> تعديل
                </Button>
              )}
              {canManage && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={13} /> حذف
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Status badge */}
        {!editing && (
          <div>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                customer.isActive
                  ? "bg-green-50 text-green-700"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {customer.isActive ? "نشط" : "غير نشط"}
            </span>
          </div>
        )}

        {serverError && (
          <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
            <AlertCircle size={14} />
            <span>{serverError}</span>
          </div>
        )}

        {/* Body */}
        {editing ? (
          <form
            className="bg-card border border-border rounded-lg p-6 space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              saveEdit();
            }}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>كود العميل</Label>
                <Input value={form.customerId} onChange={(e) => upd("customerId", e.target.value)} placeholder="CUST-001" />
              </div>
              <div className="space-y-1.5">
                <Label>الاسم *</Label>
                <Input value={form.name} onChange={(e) => upd("name", e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label>اسم الشهرة</Label>
                <Input value={form.nickname} onChange={(e) => upd("nickname", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>رقم الهاتف *</Label>
                <Input value={form.phone} onChange={(e) => upd("phone", e.target.value)} dir="ltr" required />
              </div>
              <div className="space-y-1.5">
                <Label>البريد الإلكتروني</Label>
                <Input value={form.email} onChange={(e) => upd("email", e.target.value)} type="email" dir="ltr" />
              </div>
              <div className="space-y-1.5">
                <Label>السجل التجاري / الرقم الضريبي</Label>
                <Input value={form.taxId} onChange={(e) => upd("taxId", e.target.value)} dir="ltr" />
              </div>
              <div className="space-y-1.5">
                <Label>مسؤول التواصل</Label>
                <Input value={form.contactPerson} onChange={(e) => upd("contactPerson", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>الحالة</Label>
                <select
                  value={form.isActive ? "active" : "inactive"}
                  onChange={(e) => upd("isActive", e.target.value === "active")}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                >
                  <option value="active">نشط</option>
                  <option value="inactive">غير نشط</option>
                </select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>العنوان *</Label>
                <Input value={form.address} onChange={(e) => upd("address", e.target.value)} required />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>ملاحظات</Label>
                <Textarea value={form.notes} onChange={(e) => upd("notes", e.target.value)} rows={3} />
              </div>
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  setEditing(false);
                  setServerError(null);
                }}
              >
                <X size={13} /> إلغاء
              </Button>
              <Button type="submit" size="sm" className="gap-1.5" disabled={updateMutation.isPending}>
                <Check size={13} /> {updateMutation.isPending ? "جارٍ الحفظ..." : "حفظ"}
              </Button>
            </div>
          </form>
        ) : (
          <div className="bg-card border border-border rounded-lg p-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5">
              <InfoRow icon={<Hash size={14} />} label="كود العميل" value={customer.customerId} mono />
              <InfoRow icon={<User size={14} />} label="اسم الشهرة" value={customer.nickname} />
              <InfoRow icon={<Phone size={14} />} label="رقم الهاتف" value={customer.phone} ltr />
              <InfoRow icon={<Mail size={14} />} label="البريد الإلكتروني" value={customer.email} ltr />
              <InfoRow icon={<FileText size={14} />} label="السجل التجاري / الرقم الضريبي" value={customer.taxId} ltr />
              <InfoRow icon={<User size={14} />} label="مسؤول التواصل" value={customer.contactPerson} />
              <div className="sm:col-span-2">
                <InfoRow icon={<MapPin size={14} />} label="العنوان" value={customer.address} />
              </div>
              {customer.notes && (
                <div className="sm:col-span-2">
                  <p className="text-muted-foreground text-xs mb-1">ملاحظات</p>
                  <p className="text-sm text-foreground whitespace-pre-wrap">{customer.notes}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Delete confirmation modal */}
        {confirmDelete && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-card border border-border rounded-lg p-6 max-w-sm w-full space-y-4">
              <div className="flex items-center gap-2 text-destructive">
                <AlertCircle size={20} />
                <h3 className="font-bold">تأكيد الحذف</h3>
              </div>
              <p className="text-sm text-muted-foreground">
                هل أنت متأكد من حذف العميل "{customer.name}"؟ لا يمكن التراجع عن هذا الإجراء.
              </p>
              <div className="flex gap-3 justify-end">
                <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>
                  إلغاء
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={deleting || deleteMutation.isPending}
                  onClick={handleDelete}
                >
                  {deleting || deleteMutation.isPending ? "جارٍ الحذف..." : "حذف"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}

function InfoRow({
  icon,
  label,
  value,
  mono,
  ltr,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  ltr?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
        {icon}
        {label}
      </div>
      <p
        className={`text-sm text-foreground ${mono ? "font-mono" : ""} ${value ? "" : "text-muted-foreground/50"}`}
        dir={ltr ? "ltr" : undefined}
      >
        {value ?? "-"}
      </p>
    </div>
  );
}
