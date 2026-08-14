import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Settings2, Building2 } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";

interface TaxSettings {
  id: number | null;
  companyName: string | null;
  companyTaxId: string | null;
  companyAddress: string | null;
  companyPhone: string | null;
  vatRate: number;
  withholdingRate: number;
  withholdingRateServices: number;
  withholdingRatePurchases: number;
}

export default function TaxSettingsTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [companyName, setCompanyName] = useState("");
  const [companyTaxId, setCompanyTaxId] = useState("");
  const [companyAddress, setCompanyAddress] = useState("");
  const [companyPhone, setCompanyPhone] = useState("");
  const [vatRate, setVatRate] = useState("14");
  const [withholdingRate, setWithholdingRate] = useState("3");
  const [withholdingRateServices, setWithholdingRateServices] = useState("5");
  const [withholdingRatePurchases, setWithholdingRatePurchases] = useState("1");

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/accounts/tax-settings", { credentials: "include" });
      if (!r.ok) throw new Error("فشل تحميل الإعدادات");
      const s: TaxSettings = await r.json();
      setCompanyName(s.companyName ?? "");
      setCompanyTaxId(s.companyTaxId ?? "");
      setCompanyAddress(s.companyAddress ?? "");
      setCompanyPhone(s.companyPhone ?? "");
      setVatRate(String(s.vatRate ?? 14));
      setWithholdingRate(String(s.withholdingRate ?? 3));
      setWithholdingRateServices(String(s.withholdingRateServices ?? 5));
      setWithholdingRatePurchases(String(s.withholdingRatePurchases ?? 1));
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل تحميل الإعدادات"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function save() {
    setSaving(true);
    try {
      const r = await fetch("/api/accounts/tax-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          companyName: companyName || null,
          companyTaxId: companyTaxId || null,
          companyAddress: companyAddress || null,
          companyPhone: companyPhone || null,
          vatRate,
          withholdingRate,
          withholdingRateServices,
          withholdingRatePurchases,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? "فشل حفظ الإعدادات");
      }
      toast.success("تم حفظ إعدادات الضرائب");
    } catch (e) {
      toast.error(getApiErrorMessage(e, "فشل حفظ الإعدادات"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>;
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <p className="text-muted-foreground text-sm">
        بيانات المنشأة والنِسَب الضريبية المُطبَّقة على الحسابات. القيم الافتراضية وفقًا لقانون
        ضريبة القيمة المضافة المصري رقم 67 لسنة 2016 وجدول الخصم تحت حساب المورد.
      </p>

      <div className="bg-card border border-border rounded-lg p-5 space-y-4">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Building2 size={16} className="text-primary" />
          بيانات المنشأة
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="اسم الشركة">
            <Input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="h-9 text-sm"
              placeholder="Cortoba Supplies"
            />
          </Field>
          <Field label="الرقم الضريبي (البطاقة الضريبية)">
            <Input
              value={companyTaxId}
              onChange={(e) => setCompanyTaxId(e.target.value)}
              className="h-9 text-sm font-mono"
              placeholder="100-200-300"
            />
          </Field>
          <Field label="عنوان الشركة">
            <Input
              value={companyAddress}
              onChange={(e) => setCompanyAddress(e.target.value)}
              className="h-9 text-sm"
            />
          </Field>
          <Field label="هاتف الشركة">
            <Input
              value={companyPhone}
              onChange={(e) => setCompanyPhone(e.target.value)}
              className="h-9 text-sm"
            />
          </Field>
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg p-5 space-y-4">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Settings2 size={16} className="text-primary" />
          النِسَب الضريبية
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="نسبة ضريبة القيمة المضافة (%)">
            <Input
              type="number"
              step="0.01"
              value={vatRate}
              onChange={(e) => setVatRate(e.target.value)}
              className="h-9 text-sm"
            />
          </Field>
          <Field label="نسبة الخصم تحت حساب المورد (%)">
            <Input
              type="number"
              step="0.01"
              value={withholdingRate}
              onChange={(e) => setWithholdingRate(e.target.value)}
              className="h-9 text-sm"
            />
          </Field>
          <Field label="نسبة الخصم على الخدمات/الاستشارات (%)">
            <Input
              type="number"
              step="0.01"
              value={withholdingRateServices}
              onChange={(e) => setWithholdingRateServices(e.target.value)}
              className="h-9 text-sm"
            />
          </Field>
          <Field label="نسبة الخصم على المشتريات/التوريدات (%)">
            <Input
              type="number"
              step="0.01"
              value={withholdingRatePurchases}
              onChange={(e) => setWithholdingRatePurchases(e.target.value)}
              className="h-9 text-sm"
            />
          </Field>
        </div>
      </div>

      <Button onClick={save} disabled={saving} size="sm" className="gap-1.5">
        {saving ? "جارٍ الحفظ..." : "حفظ الإعدادات"}
      </Button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-muted-foreground mb-1 block">{label}</label>
      {children}
    </div>
  );
}
