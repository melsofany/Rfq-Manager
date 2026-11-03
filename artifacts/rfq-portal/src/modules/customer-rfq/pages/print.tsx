import { useState } from "react";
import { useParams, Link } from "wouter";
import {
  useGetCustomerRfq,
  useGetCustomer,
  getGetCustomerQueryKey,
} from "@workspace/api-client-react";
import { Printer, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

// Printable quotation request (طلب تسعير العميل).
// Shows on screen with controls; the controls are hidden when printing, so the
// browser's "Save as PDF" produces a clean A4 page.

const COMPANY = {
  nameAr: "قرطبة للتوريدات",
  nameEn: "CORTOBA SUPPLIES",
  address: "ش.الإسكندرية - برج نجمة مطروح، الدور الرابع - مرسي مطروح",
  phone: "ت: 432-972-587",
  commercialReg: "س-ت: 21618",
  email: "INFO@CORTOBA-SUPPLIES.COM",
};

const DEFAULT_TERMS = [
  "الأسعار المذكورة بالجنيه المصري.",
  "الأسعار سارية حتى تاريخ انتهاء الطلب المذكور أعلاه.",
  "يرجى ذكر رقم الطلب الداخلي عند الرد على هذا العرض.",
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

  return (
    <div className="min-h-screen bg-slate-100 py-6 print:bg-white print:py-0" dir="rtl">
      {/* Controls — hidden in print */}
      <div className="mx-auto mb-4 flex max-w-[210mm] flex-wrap items-center justify-between gap-3 px-4 print:hidden">
        <Link href={`/customer-rfq/${rfq.id}`}>
          <a className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
            <ArrowRight size={16} /> رجوع للطلب
          </a>
        </Link>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showPrices}
              onChange={(e) => setShowPrices(e.target.checked)}
            />
            إظهار الأسعار
          </label>
          <Button onClick={() => window.print()}>
            <Printer size={16} className="ml-2" /> طباعة / حفظ PDF
          </Button>
        </div>
      </div>

      <div className="mx-auto mb-6 max-w-[210mm] px-4 print:hidden">
        <label className="mb-1 block text-sm font-semibold text-slate-700">الشروط والأحكام</label>
        <Textarea
          rows={6}
          value={terms}
          onChange={(e) => setTerms(e.target.value)}
          className="bg-white"
        />
        <p className="mt-1 text-xs text-slate-500">
          سطر لكل شرط. التعديل هنا يظهر في الطباعة فقط ولا يُحفظ في الطلب.
        </p>
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
          </div>
        </header>

        {/* Title + numbers */}
        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-[#1a3a5c]">طلب تسعير</h1>
            <div className="text-xs tracking-widest text-[#c8a84b]">REQUEST FOR QUOTATION</div>
          </div>
          <div className="rounded border border-slate-300 px-3 py-2 text-sm">
            <Field label="رقم الطلب الداخلي" value={rfq.internalNo} />
            <Field label="رقم طلب العميل (الخارجي)" value={rfq.customerRfqNo} />
            <Field label="تاريخ الإدخال" value={formatDate(rfq.entryDate)} />
            <Field label="تاريخ انتهاء الطلب" value={formatDate(rfq.expiryDate)} />
          </div>
        </div>

        {/* Customer */}
        <section className="mt-4 rounded border border-slate-200 bg-slate-50 px-3 py-2">
          <div className="mb-1 text-sm font-bold text-[#1a3a5c]">بيانات العميل</div>
          <Field label="اسم العميل" value={customer?.name ?? rfq.customerName} />
          <Field label="العنوان" value={customer?.address} />
          <Field label="الهاتف" value={customer?.phone} />
          <Field label="الشخص المسؤول" value={customer?.contactPerson ?? rfq.buyerName} />
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
            {COMPANY.address} | {COMPANY.phone} | {COMPANY.commercialReg}
          </div>
          <div dir="ltr">{COMPANY.email}</div>
        </footer>
      </div>
    </div>
  );
}
