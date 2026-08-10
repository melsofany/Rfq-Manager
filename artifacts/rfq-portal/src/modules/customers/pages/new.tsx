import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useCreateCustomer, getListCustomersQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, AlertCircle } from "lucide-react";

const empty = {
  customerId: "",
  name: "",
  nickname: "",
  contactPerson: "",
  email: "",
  phone: "",
  address: "",
  taxId: "",
  notes: "",
};

export default function NewCustomerPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const [form, setForm] = useState({ ...empty });
  const [serverError, setServerError] = useState<string | null>(null);

  const createMutation = useCreateCustomer({
    mutation: {
      onSuccess: (customer) => {
        queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
        navigate(`/customers/${customer.id}`);
      },
      onError: (err: unknown) => {
        const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
        setServerError(msg ?? "حدث خطأ أثناء الحفظ");
      },
    },
  });

  const update = (field: string, value: string) => setForm((prev) => ({ ...prev, [field]: value }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);
    if (!form.name.trim() || !form.phone.trim() || !form.address.trim()) {
      setServerError("الاسم ورقم الهاتف والعنوان مطلوبة");
      return;
    }
    createMutation.mutate({
      data: {
        ...form,
        name: form.name.trim(),
        phone: form.phone.trim(),
        address: form.address.trim(),
      } as Parameters<typeof createMutation.mutate>[0]["data"],
    });
  };

  return (
    <Layout>
      <div className="p-4 sm:p-6 max-w-2xl space-y-5">
        <div className="flex items-center gap-3">
          <Link href="/customers">
            <a className="text-muted-foreground hover:text-foreground">
              <ArrowLeft size={18} />
            </a>
          </Link>
          <div>
            <h1 className="text-xl font-bold text-foreground">إضافة عميل</h1>
            <p className="text-muted-foreground text-sm">تسجيل عميل جديد في النظام</p>
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-card border border-border rounded-lg p-6 space-y-5"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>كود العميل</Label>
              <Input
                value={form.customerId}
                onChange={(e) => update("customerId", e.target.value)}
                placeholder="CUST-001"
              />
            </div>
            <div className="space-y-1.5">
              <Label>الاسم *</Label>
              <Input
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
                placeholder="اسم العميل أو الشركة"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>اسم الشهرة</Label>
              <Input
                value={form.nickname}
                onChange={(e) => update("nickname", e.target.value)}
                placeholder="الاسم المشهور به"
              />
            </div>
            <div className="space-y-1.5">
              <Label>رقم الهاتف *</Label>
              <Input
                value={form.phone}
                onChange={(e) => update("phone", e.target.value)}
                placeholder="+966-12-345-6789"
                dir="ltr"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>البريد الإلكتروني</Label>
              <Input
                value={form.email}
                onChange={(e) => update("email", e.target.value)}
                type="email"
                placeholder="contact@customer.com"
                dir="ltr"
              />
            </div>
            <div className="space-y-1.5">
              <Label>السجل التجاري / الرقم الضريبي</Label>
              <Input
                value={form.taxId}
                onChange={(e) => update("taxId", e.target.value)}
                placeholder="300000000000003"
                dir="ltr"
              />
            </div>
            <div className="space-y-1.5">
              <Label>مسؤول التواصل</Label>
              <Input
                value={form.contactPerson}
                onChange={(e) => update("contactPerson", e.target.value)}
                placeholder="اسم الشخص المسؤول"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>العنوان *</Label>
              <Input
                value={form.address}
                onChange={(e) => update("address", e.target.value)}
                placeholder="المدينة، المنطقة، الشارع"
                required
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>ملاحظات</Label>
              <Textarea
                value={form.notes}
                onChange={(e) => update("notes", e.target.value)}
                placeholder="أي ملاحظات إضافية عن العميل"
                rows={3}
              />
            </div>
          </div>

          {serverError && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
              <AlertCircle size={14} />
              <span>{serverError}</span>
            </div>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <Link href="/customers">
              <a className="inline-flex items-center px-4 py-2 text-sm rounded border border-border text-muted-foreground hover:text-foreground">
                إلغاء
              </a>
            </Link>
            <Button type="submit" disabled={createMutation.isPending || !form.name || !form.phone || !form.address}>
              {createMutation.isPending ? "جارٍ الحفظ..." : "إضافة العميل"}
            </Button>
          </div>
        </form>
      </div>
    </Layout>
  );
}
