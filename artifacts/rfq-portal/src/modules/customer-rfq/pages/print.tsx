import { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import {
  useGetCustomerRfq,
  useGetCustomer,
  getGetCustomerQueryKey,
} from "@workspace/api-client-react";
import { Printer, ArrowRight, Download, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// Customer quotation (عرض سعر). On screen: controls for options and sending.
// The controls are hidden when printing, so the browser's "Save as PDF" gives a
// clean A4 page. Sending uses the server-generated PDF (same layout).

const COMPANY = {
  nameAr: "قرطبة للتوريدات",
  nameEn: "CORTOBA SUPPLIES",
  address: "ش.الإسكندرية - برج نجمة مطروح، الدور الرابع - مرسي مطروح",
  phone: "432-972-587",
  commercialReg: "س-ت: 21618",
  email: "INFO@CORTOBA-SUPPLIES.COM",
};

const DEFAULT_TERMS = [
  "الأسعار المذكورة بالجنيه المصري.",
  "الأسعار سارية حتى تاريخ انتهاء الطلب المذكور أعلاه.",
  "يرجى ذكر رقم المرجع عند الرد على هذا العرض.",
  "مدة التسليم: حسب الاتفاق بعد تأكيد أمر الشراء.",
  "طريقة الدفع: حسب الاتفاق.",
].join("\n");

function formatDate(d?: string | null): string {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d;
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${dt.getFullYear()}`;
}

function toNum(v: string | number | null | undefined): number {
  const n = typeof v === "string" ? parseFloat(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function money(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function Field({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex gap-2 py-1 text-sm">
      <span className="w-40 shrink-0 font-semibold text-slate-600">{label}</span>
      <span className="font-medium text-slate-900" dir="auto">
        {value && value.trim() ? value : "—"}
      </span>
    </div>
  );
}

type SendResult = Record<string, { sent: boolean; error: string | null }>;

export default function CustomerRfqPrintPage() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id, 10);

  const { data: rfq, isLoading } = useGetCustomerRfq(id);
  const customerId = rfq?.customerId ?? 0;
  const { data: customer } = useGetCustomer(customerId, {
    query: { queryKey: getGetCustomerQueryKey(customerId), enabled: customerId > 0 },
  });

  const [showPrices, setShowPrices] = useState(true);
  const [terms, setTerms] = useState(DEFAULT_TERMS);
  const [contactPerson, setContactPerson] = useState("");
  const [useWhatsapp, setUseWhatsapp] = useState(true);
  const [useEmail, setUseEmail] = useState(false);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<SendResult | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  // Prefill recipient fields from the customer record (only while still empty).
  useEffect(() => {
    if (!customer) return;
    setContactPerson((v) => v || customer.contactPerson || "");
    setPhone((v) => v || customer.phone || "");
    setEmail((v) => v || customer.email || "");
  }, [customer]);

  if (isLoading) {
    return <div className="p-8 text-center text-slate-500">جارٍ التحميل…</div>;
  }
  if (!rfq) {
    return <div className="p-8 text-center text-red-600">الطلب غير موجود</div>;
  }

  const items = rfq.items ?? [];
  const lines = items.map((it) => {
    const qty = toNum(it.qty);
    const price = toNum(it.unitPrice);
    return { ...it, qty, price, total: Math.round(qty * price * 10000) / 10000 };
  });
  const grandTotal = lines.reduce((s, l) => s + l.total, 0);
  const termLines = terms
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);

  const pdfUrl = `/api/customer-rfq/${rfq.id}/quotation.pdf?prices=${showPrices ? "1" : "0"}`;

  const canSend = (useWhatsapp || useEmail) && !sending;

  const handleSend = async () => {
    setSendError(null);
    setSendResult(null);
    const channels = [useWhatsapp && "whatsapp", useEmail && "email"].filter(Boolean);
    setSending(true);
    try {
      const res = await fetch(`/api/customer-rfq/${rfq.id}/quotation/send`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channels,
          phone: phone.trim(),
          email: email.trim(),
          contactPerson: contactPerson.trim(),
          showPrices,
          terms: termLines,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        results?: SendResult;
        error?: string;
      } | null;
      if (!res.ok) {
        throw new Error(body?.error ?? `تعذر الإرسال (HTTP ${res.status})`);
      }
      setSendResult(body?.results ?? {});
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "تعذر الإرسال");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 py-6 print:bg-white print:py-0" dir="rtl">
      {/* Controls — hidden in print */}
      <div className="mx-auto mb-4 flex max-w-[210mm] flex-wrap items-center justify-between gap-3 px-4 print:hidden">
        <Link href={`/customer-rfq/${rfq.id}`}>
          <a className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
            <ArrowRight size={16} /> رجوع للطلب
          </a>
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showPrices}
              onChange={(e) => setShowPrices(e.target.checked)}
            />
            إظهار الأسعار
          </label>
          <Button variant="outline" onClick={() => window.open(pdfUrl, "_blank")}>
            <Download size={16} className="ml-2" /> تحميل PDF
          </Button>
          <Button onClick={() => window.print()}>
            <Printer size={16} className="ml-2" /> طباعة
          </Button>
        </div>
      </div>

      {/* Send panel — hidden in print */}
      <div className="mx-auto mb-6 max-w-[210mm] space-y-4 rounded-lg border border-slate-200 bg-white p-4 print:hidden">
        <div className="text-sm font-bold text-slate-800">إرسال عرض السعر للعميل</div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">الشخص المسؤول</label>
            <Input
              value={contactPerson}
              onChange={(e) => setContactPerson(e.target.value)}
              placeholder="اسم الشخص المسؤول"
              className="bg-white"
            />
          </div>
          <div className="flex items-end gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={useWhatsapp}
                onChange={(e) => setUseWhatsapp(e.target.checked)}
              />
              واتساب
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={useEmail}
                onChange={(e) => setUseEmail(e.target.checked)}
              />
              إيميل
            </label>
          </div>
          {useWhatsapp && (
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                رقم الواتساب (مع كود الدولة)
              </label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+20 1XXXXXXXXX"
                dir="ltr"
                className="bg-white"
              />
            </div>
          )}
          {useEmail && (
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                البريد الإلكتروني
              </label>
              <Input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                dir="ltr"
                type="email"
                className="bg-white"
              />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            يُرسَل عرض السعر كملف PDF بنفس تصميم الطباعة، والأسعار تتبع خيار "إظهار الأسعار".
          </p>
          <Button onClick={handleSend} disabled={!canSend}>
            <Send size={16} className="ml-2" /> {sending ? "جارٍ الإرسال…" : "إرسال"}
          </Button>
        </div>

        {sendError && <p className="text-sm text-red-600">{sendError}</p>}
        {sendResult && (
          <div className="space-y-1 text-sm">
            {"whatsapp" in sendResult && (
              <p className={sendResult.whatsapp.sent ? "text-emerald-700" : "text-red-600"}>
                واتساب:{" "}
                {sendResult.whatsapp.sent ? "تم الإرسال" : `فشل — ${sendResult.whatsapp.error}`}
              </p>
            )}
            {"email" in sendResult && (
              <p className={sendResult.email.sent ? "text-emerald-700" : "text-red-600"}>
                إيميل: {sendResult.email.sent ? "تم الإرسال" : `فشل — ${sendResult.email.error}`}
              </p>
            )}
          </div>
        )}

        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-600">الشروط والأحكام</label>
          <Textarea
            rows={5}
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
            className="bg-white"
          />
          <p className="mt-1 text-xs text-slate-500">
            سطر لكل شرط. التعديل يظهر في الطباعة والإرسال، ولا يُحفظ في الطلب.
          </p>
        </div>
      </div>

      {/* Printable sheet — A4 */}
      <div className="mx-auto flex min-h-[297mm] w-full max-w-[210mm] flex-col bg-white p-[12mm] shadow-lg print:min-h-0 print:max-w-none print:p-0 print:shadow-none">
        {/* Header */}
        <header className="flex items-center justify-between border-b-4 border-[#c8a84b] pb-3">
          <img src="/logo.png" alt={COMPANY.nameEn} className="h-20 w-20 object-contain" />
          <div className="text-left" dir="ltr">
            <div className="text-lg font-bold text-[#1a3a5c]">{COMPANY.nameEn}</div>
            <div className="text-sm text-[#1a3a5c]" dir="rtl">
              {COMPANY.nameAr}
            </div>
            <div className="mt-1 text-xs text-slate-700" dir="ltr">
              Tel: {COMPANY.phone}
            </div>
          </div>
        </header>

        {/* Title + numbers */}
        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-[#1a3a5c]">عرض سعر</h1>
            <div className="text-xs tracking-widest text-[#c8a84b]">QUOTATION</div>
          </div>
          <div className="rounded border border-slate-300 px-3 py-2 text-sm">
            <Field label="رقم المرجع (الداخلي)" value={rfq.internalNo} />
            <Field label="رقم طلب العميل" value={rfq.customerRfqNo} />
            <Field label="تاريخ العرض" value={formatDate(rfq.entryDate)} />
            <Field label="صالح حتى" value={formatDate(rfq.expiryDate)} />
          </div>
        </div>

        {/* Customer */}
        <section className="mt-4 rounded border border-slate-200 bg-slate-50 px-3 py-2">
          <div className="mb-1 text-sm font-bold text-[#1a3a5c]">إلى</div>
          <Field label="العميل" value={customer?.name ?? rfq.customerName} />
          <Field
            label="الشخص المسؤول"
            value={contactPerson || customer?.contactPerson || rfq.buyerName}
          />
          <Field label="العنوان" value={customer?.address} />
          <Field label="الهاتف" value={phone || customer?.phone} />
        </section>

        {/* Items */}
        <table className="mt-4 w-full border-collapse text-sm">
          <thead>
            <tr className="bg-[#1a3a5c] text-white">
              <th className="border border-slate-300 px-2 py-1.5 text-center">م</th>
              <th className="border border-slate-300 px-2 py-1.5 text-right">رقم القطعة</th>
              <th className="border border-slate-300 px-2 py-1.5 text-right">البند</th>
              <th className="border border-slate-300 px-2 py-1.5 text-right">الوصف</th>
              <th className="border border-slate-300 px-2 py-1.5 text-center">الوحدة</th>
              <th className="border border-slate-300 px-2 py-1.5 text-center">الكمية</th>
              {showPrices && (
                <>
                  <th className="border border-slate-300 px-2 py-1.5 text-center">سعر الوحدة</th>
                  <th className="border border-slate-300 px-2 py-1.5 text-center">الإجمالي</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id} className="even:bg-slate-50">
                <td className="border border-slate-300 px-2 py-1 text-center">{i + 1}</td>
                <td className="border border-slate-300 px-2 py-1" dir="ltr">
                  {l.partNo || "—"}
                </td>
                <td className="border border-slate-300 px-2 py-1">{l.lineItem || "—"}</td>
                <td className="border border-slate-300 px-2 py-1">{l.description || "—"}</td>
                <td className="border border-slate-300 px-2 py-1 text-center">{l.uom || "—"}</td>
                <td className="border border-slate-300 px-2 py-1 text-center" dir="ltr">
                  {l.qty || "—"}
                </td>
                {showPrices && (
                  <>
                    <td className="border border-slate-300 px-2 py-1 text-center" dir="ltr">
                      {l.price ? money(l.price) : "—"}
                    </td>
                    <td className="border border-slate-300 px-2 py-1 text-center" dir="ltr">
                      {l.total ? money(l.total) : "—"}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
          {showPrices && (
            <tfoot>
              <tr className="font-bold">
                <td
                  colSpan={7}
                  className="border border-slate-300 bg-slate-100 px-2 py-1.5 text-left"
                  dir="ltr"
                >
                  {money(grandTotal)}
                </td>
                <td className="border border-slate-300 bg-slate-100 px-2 py-1.5 text-right">
                  الإجمالي
                </td>
              </tr>
            </tfoot>
          )}
        </table>

        {/* Terms */}
        {termLines.length > 0 && (
          <section className="mt-5">
            <div className="mb-1 text-sm font-bold text-[#1a3a5c]">الشروط والأحكام</div>
            <ol className="list-decimal space-y-1 pr-5 text-sm text-slate-800">
              {termLines.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ol>
          </section>
        )}

        {/* Footer */}
        <footer className="mt-auto border-t-2 border-[#c8a84b] pt-2 text-center text-[11px] text-slate-600">
          <div>
            {COMPANY.address} | ت: {COMPANY.phone} | {COMPANY.commercialReg}
          </div>
          <div dir="ltr">{COMPANY.email}</div>
        </footer>
      </div>
    </div>
  );
}
