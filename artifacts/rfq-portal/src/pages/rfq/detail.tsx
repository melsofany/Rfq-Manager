import { useState } from "react";
import { useParams, useLocation, Link } from "wouter";
import {
  useGetRfq,
  useListRfqItems,
  useGetRfqSentLog,
  useGetRfqOffers,
  useUpdateRfq,
  getGetRfqQueryKey,
  getListRfqItemsQueryKey,
  getGetRfqSentLogQueryKey,
  getGetRfqOffersQueryKey,
} from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft, Send, Eye, CheckCircle2, XCircle,
  AlertTriangle, FileSpreadsheet, FileText, ClipboardList, Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const VAT_RATE = 0.14;
const VAT_LABEL = "14%";

type Tab = "items" | "sent" | "offers";

type OfferRow = {
  supplierId: number;
  supplierName: string;
  price: number;
  priceWithVat: number;
  taxIncluded: boolean;
  deliveryDays?: number | null;
  deviation: number;
  isLowest: boolean;
  isAnomaly: boolean;
};

type ItemAnalysis = {
  rfqItemId: number;
  description: string;
  partNo?: string | null;
  qty?: string | number | null;
  uom?: string | null;
  referencePrice?: number | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  avgPrice?: number | null;
  offers: OfferRow[];
};

type OffersData = {
  analysis?: { itemAnalysis?: ItemAnalysis[] };
  offers?: unknown[];
};

// ── Price cell ──────────────────────────────────────────────────────────────
function PriceCell({
  price,
  priceWithVat,
  taxIncluded,
  isLowest,
  isAnomaly,
}: {
  price: number;
  priceWithVat: number;
  taxIncluded: boolean;
  isLowest: boolean;
  isAnomaly: boolean;
}) {
  return (
    <div className="text-right leading-tight">
      {/* VAT-inclusive price — primary comparison value */}
      <div className={cn(
        "font-mono text-xs font-semibold",
        isLowest && "text-green-700",
        isAnomaly && !isLowest && "text-amber-600",
        !isLowest && !isAnomaly && "text-foreground",
      )}>
        {priceWithVat.toLocaleString("en-EG", { minimumFractionDigits: 2 })}
        {isLowest && <span className="ml-1 text-[9px] bg-green-100 text-green-700 rounded px-1">أقل سعر</span>}
        {isAnomaly && !isLowest && <AlertTriangle size={10} className="inline ml-1 text-amber-500" />}
      </div>
      {/* Original price — secondary, shown if tax was excluded */}
      {!taxIncluded && (
        <div className="text-[10px] text-muted-foreground font-mono">
          قبل الضريبة: {price.toLocaleString("en-EG", { minimumFractionDigits: 2 })}
        </div>
      )}
    </div>
  );
}

// ── Normalize offers: compute priceWithVat if missing from API response ────────
function normalizeItems(offersData: OffersData): ItemAnalysis[] {
  return (offersData.analysis?.itemAnalysis ?? []).map((item) => ({
    ...item,
    offers: (item.offers as OfferRow[]).map((o) => ({
      ...o,
      priceWithVat: (o as OfferRow).priceWithVat ?? (o.taxIncluded ? o.price : o.price * (1 + VAT_RATE)),
    })),
  }));
}

// ── Excel export ─────────────────────────────────────────────────────────────
async function exportToExcel(rfqNo: string, customerRfqNo: string, offersData: OffersData) {
  const { utils, writeFile } = await import("xlsx");
  const wb = utils.book_new();
  const items = normalizeItems(offersData);

  const summaryRows: unknown[][] = [
    ["Cortoba Supplies — قرطبة للتوريدات"],
    ["تقرير مقارنة الأسعار — RFQ Price Comparison (VAT Inclusive)"],
    [`Internal RFQ: ${rfqNo}`, `Customer RFQ: ${customerRfqNo}`],
    [`Exported: ${new Date().toLocaleDateString("en-EG")}`, `VAT Rate: ${VAT_LABEL}`],
    [],
    [
      "#", "Part No", "Description", "QTY", "UOM", "Ref. Price (EGP)",
      "Supplier", "Original Price (EGP)", "Tax Inc.", "Price incl. VAT (EGP)",
      "Lead (days)", "vs. Avg (VAT-adj) %", "Lowest?",
    ],
  ];

  items.forEach((item, idx) => {
    const sorted = item.offers.slice().sort((a, b) => a.priceWithVat - b.priceWithVat);
    if (sorted.length === 0) {
      summaryRows.push([
        idx + 1, item.partNo ?? "-", item.description, item.qty ?? "-", item.uom ?? "-",
        item.referencePrice ?? "-", "No offers yet", "", "", "", "", "", "",
      ]);
    } else {
      sorted.forEach((o, oi) => {
        summaryRows.push([
          oi === 0 ? idx + 1 : "",
          oi === 0 ? (item.partNo ?? "-") : "",
          oi === 0 ? item.description : "",
          oi === 0 ? (item.qty ?? "-") : "",
          oi === 0 ? (item.uom ?? "-") : "",
          oi === 0 ? (item.referencePrice ?? "-") : "",
          o.supplierName,
          o.price,
          o.taxIncluded ? "Yes" : "No",
          o.priceWithVat,
          o.deliveryDays ?? "-",
          `${o.deviation > 0 ? "+" : ""}${o.deviation.toFixed(1)}%`,
          o.isLowest ? "YES" : "",
        ]);
      });
      summaryRows.push([
        "", "", "", "", "", "", "Summary (Incl. VAT)",
        `Min: ${item.minPrice?.toFixed(2) ?? "-"} | Avg: ${item.avgPrice?.toFixed(2) ?? "-"} | Max: ${item.maxPrice?.toFixed(2) ?? "-"}`,
        "", "", "", "", "",
      ]);
      summaryRows.push([]);
    }
  });

  const ws = utils.aoa_to_sheet(summaryRows);
  ws["!cols"] = [
    { wch: 4 }, { wch: 14 }, { wch: 40 }, { wch: 8 }, { wch: 8 },
    { wch: 16 }, { wch: 28 }, { wch: 16 }, { wch: 10 }, { wch: 18 }, { wch: 12 }, { wch: 18 }, { wch: 8 },
  ];
  utils.book_append_sheet(wb, ws, "Price Comparison");
  writeFile(wb, `RFQ-Comparison-${rfqNo}.xlsx`);
}

// ── Dispatch report PDF (server-side) ────────────────────────────────────────
async function exportDispatchReport(rfqId: number, rfqNo: string): Promise<void> {
  const response = await fetch(`/api/rfq/${rfqId}/dispatch-report`, { credentials: "include" });
  if (!response.ok) {
    let errMsg = `Server error ${response.status}`;
    try {
      const json = await response.json();
      if (json?.detail) errMsg = json.detail;
      else if (json?.error) errMsg = json.error;
    } catch { /* ignore */ }
    throw new Error(errMsg);
  }
  const blob = await response.blob();
  if (!blob || blob.size === 0) {
    throw new Error("الملف المُولَّد فارغ — تحقق من سجل الإرسال أو تواصل مع الدعم الفني");
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Dispatch-Report-${rfqNo}.pdf`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
}

// ── Offers PDF — html2canvas screenshot → jsPDF ──────────────────────────────
async function exportToPdf(
  rfqNo: string,
  customerRfqNo: string,
  offersData: OffersData,
  employeeName?: string | null,
  rfqId?: number,
): Promise<void> {
  const items: ItemAnalysis[] = normalizeItems(offersData);
  if (items.length === 0) throw new Error("لا توجد عروض لتصديرها");

  // ── 1. Fetch close date ───────────────────────────────────────────────────
  let closeDate: string | null = null;
  try {
    if (rfqId) {
      const slResp = await fetch(`/api/rfq/${rfqId}/sent-log`, { credentials: "include" });
      if (slResp.ok) {
        const sl = (await slResp.json()) as Array<{ closeDate?: string | null }>;
        closeDate = sl?.find((e) => e.closeDate)?.closeDate ?? null;
      }
    }
  } catch { /* skip */ }

  // ── 2. Fetch logo as data URL ─────────────────────────────────────────────
  let logoSrc = "";
  try {
    const lr = await fetch("/logo.png");
    if (lr.ok) {
      const blob = await lr.blob();
      logoSrc = await new Promise<string>((res) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result as string);
        reader.readAsDataURL(blob);
      });
    }
  } catch { /* skip */ }

  // ── 3. Fetch Amiri Arabic font as data URL (avoids CORS) ─────────────────
  let fontDataUrl = "";
  try {
    const fr = await fetch("/fonts/Amiri-Regular.ttf");
    if (fr.ok) {
      const fontBlob = await fr.blob();
      fontDataUrl = await new Promise<string>((res) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result as string);
        reader.readAsDataURL(fontBlob);
      });
    }
  } catch { /* skip */ }

  const exportDate = new Date().toLocaleDateString("ar-EG", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });
  const allSuppliers = Array.from(
    new Set(items.flatMap((i) => i.offers.map((o) => o.supplierName)))
  );

  // ── 4. Build supplier columns ─────────────────────────────────────────────
  const supplierHeaderCells = allSuppliers
    .map((s) => `<th colspan="2" style="background:#1e4570;color:#fff;padding:6px 4px;border:1px solid #3a5a7c;font-size:10px">${s}</th>`)
    .join("");
  const supplierSubHeader = allSuppliers
    .map(
      () =>
        `<th style="background:#2a4a6c;color:#c8a84b;padding:4px;border:1px solid #3a5a7c;font-size:9px;font-weight:400">السعر الأصلي (ج.م)</th>
         <th style="background:#2a4a6c;color:#90d090;padding:4px;border:1px solid #3a5a7c;font-size:9px;font-weight:400">شامل ض.ق.م</th>`
    )
    .join("");

  // ── 5. Build table rows ───────────────────────────────────────────────────
  const rows = items
    .map((item, idx) => {
      const bySupplier = new Map<string, OfferRow>();
      for (const o of item.offers) bySupplier.set(o.supplierName, o);
      const supCells = allSuppliers
        .map((s) => {
          const o = bySupplier.get(s);
          if (!o) return `<td style="text-align:center;color:#aaa;border:1px solid #e0e8f0;padding:4px">—</td><td style="text-align:center;color:#aaa;border:1px solid #e0e8f0;padding:4px">—</td>`;
          const vc = o.isLowest ? "#166534" : o.isAnomaly ? "#b45309" : "#111";
          const fw = o.isLowest ? "bold" : "normal";
          return `<td style="text-align:left;direction:ltr;border:1px solid #e0e8f0;padding:4px;font-size:10px">${o.price.toLocaleString("en-EG", { minimumFractionDigits: 2 })}</td>
                  <td style="text-align:left;direction:ltr;color:${vc};font-weight:${fw};border:1px solid #e0e8f0;padding:4px;font-size:10px">${o.priceWithVat.toLocaleString("en-EG", { minimumFractionDigits: 2 })}${o.isLowest ? " ✓" : ""}</td>`;
        })
        .join("");
      const summary =
        item.minPrice != null
          ? `أقل: ${item.minPrice.toFixed(2)} | متوسط: ${item.avgPrice?.toFixed(2)} | أعلى: ${item.maxPrice?.toFixed(2)}`
          : "لا توجد عروض";
      const bg = idx % 2 === 0 ? "#fff" : "#f4f8fc";
      return `<tr style="background:${bg}">
        <td style="text-align:center;border:1px solid #e0e8f0;padding:4px;font-size:10px">${idx + 1}</td>
        <td style="border:1px solid #e0e8f0;padding:4px;font-size:10px">${item.description}</td>
        <td style="text-align:center;direction:ltr;border:1px solid #e0e8f0;padding:4px;font-size:10px">${item.partNo ?? "—"}</td>
        <td style="text-align:center;direction:ltr;border:1px solid #e0e8f0;padding:4px;font-size:10px">${item.qty != null ? `${item.qty} ${item.uom ?? ""}`.trim() : "—"}</td>
        ${supCells}
        <td style="border:1px solid #e0e8f0;padding:4px;font-size:9px;color:#444">${summary}</td>
      </tr>`;
    })
    .join("");

  // ── 6. Load html2canvas from CDN ─────────────────────────────────────────
  type H2C = (el: HTMLElement, opts?: Record<string, unknown>) => Promise<HTMLCanvasElement>;
  const win = window as Window & { html2canvas?: H2C };
  if (!win.html2canvas) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("تعذّر تحميل مكتبة html2canvas"));
      document.head.appendChild(s);
    });
  }
  const html2canvas = win.html2canvas!;

  // ── 7. Inject font into the document ─────────────────────────────────────
  const fontStyle = document.createElement("style");
  fontStyle.textContent = fontDataUrl
    ? `@font-face { font-family: 'Amiri'; src: url('${fontDataUrl}') format('truetype'); font-weight: normal; }`
    : "";
  document.head.appendChild(fontStyle);

  // ── 8. Build the report div ───────────────────────────────────────────────
  const div = document.createElement("div");
  div.style.cssText =
    "position:fixed;left:-9999px;top:0;width:1122px;background:#fff;" +
    "font-family:'Amiri','Arial Unicode MS',Arial,sans-serif;direction:rtl;z-index:99999;padding:8px;";

  div.innerHTML = `
<div style="background:#1a3a5c;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-radius:4px 4px 0 0">
  <div>
    <div style="font-size:22px;font-weight:700;color:#c8a84b">قرطبة للتوريدات</div>
    <div style="font-size:10px;color:#aaccee;margin:2px 0">Cortoba Supplies</div>
    <div style="font-size:13px;font-weight:600;margin-top:4px">تقرير مقارنة عروض الأسعار — RFQ Price Comparison Report</div>
  </div>
  ${logoSrc ? `<img src="${logoSrc}" style="height:54px;width:auto" alt="Logo">` : ""}
</div>
<div style="display:flex;background:#f4f8fc;border-bottom:3px solid #c8a84b">
  <div style="flex:1;text-align:center;padding:7px 4px;border-left:1px solid #d0dbe8">
    <div style="font-size:9px;color:#7a8fa0;font-weight:600">رقم الطلب الداخلي</div>
    <div style="font-size:8px;color:#aab">Internal RFQ</div>
    <div style="font-size:12px;font-weight:700;color:#1a3a5c">${rfqNo}</div>
  </div>
  <div style="flex:1;text-align:center;padding:7px 4px;border-left:1px solid #d0dbe8">
    <div style="font-size:9px;color:#7a8fa0;font-weight:600">رقم طلب العميل</div>
    <div style="font-size:8px;color:#aab">Customer RFQ</div>
    <div style="font-size:12px;font-weight:700;color:#1a3a5c">${customerRfqNo}</div>
  </div>
  <div style="flex:1;text-align:center;padding:7px 4px;border-left:1px solid #d0dbe8">
    <div style="font-size:9px;color:#7a8fa0;font-weight:600">أعده</div>
    <div style="font-size:8px;color:#aab">Prepared By</div>
    <div style="font-size:12px;font-weight:700;color:#1a3a5c">${employeeName ?? "—"}</div>
  </div>
  <div style="flex:1;text-align:center;padding:7px 4px;border-left:1px solid #d0dbe8">
    <div style="font-size:9px;color:#7a8fa0;font-weight:600">تاريخ الإغلاق</div>
    <div style="font-size:8px;color:#aab">Close Date</div>
    <div style="font-size:12px;font-weight:700;color:#1a3a5c">${closeDate ?? "—"}</div>
  </div>
  <div style="flex:1;text-align:center;padding:7px 4px;border-left:1px solid #d0dbe8">
    <div style="font-size:9px;color:#7a8fa0;font-weight:600">تاريخ التصدير</div>
    <div style="font-size:8px;color:#aab">Export Date</div>
    <div style="font-size:12px;font-weight:700;color:#1a3a5c">${exportDate}</div>
  </div>
  <div style="flex:1;text-align:center;padding:7px 4px;border-left:1px solid #d0dbe8">
    <div style="font-size:9px;color:#7a8fa0;font-weight:600">عدد البنود</div>
    <div style="font-size:8px;color:#aab">Items</div>
    <div style="font-size:12px;font-weight:700;color:#1a3a5c">${items.length}</div>
  </div>
  <div style="flex:1;text-align:center;padding:7px 4px">
    <div style="font-size:9px;color:#7a8fa0;font-weight:600">ض.ق.م</div>
    <div style="font-size:8px;color:#aab">VAT</div>
    <div style="font-size:12px;font-weight:700;color:#1a3a5c">${VAT_LABEL}</div>
  </div>
</div>
<div style="font-size:9px;color:#555;padding:5px 8px;background:#fffbea;border-bottom:1px solid #e5d980">
  (*) شامل ض.ق.م = السعر × 1.14 إن لم تشمل الضريبة | ✓ = أقل سعر | جميع القيم بالجنيه المصري
</div>
<table style="width:100%;border-collapse:collapse">
  <thead>
    <tr>
      <th rowspan="2" style="background:#1a3a5c;color:#fff;padding:6px 4px;border:1px solid #3a5a7c;font-size:10px;width:28px">#</th>
      <th rowspan="2" style="background:#1a3a5c;color:#fff;padding:6px 4px;border:1px solid #3a5a7c;font-size:10px;text-align:right;width:180px">البيان / Description</th>
      <th rowspan="2" style="background:#1a3a5c;color:#fff;padding:6px 4px;border:1px solid #3a5a7c;font-size:10px;width:80px">Part No</th>
      <th rowspan="2" style="background:#1a3a5c;color:#fff;padding:6px 4px;border:1px solid #3a5a7c;font-size:10px;width:55px">الكمية</th>
      ${supplierHeaderCells}
      <th rowspan="2" style="background:#1a3a5c;color:#fff;padding:6px 4px;border:1px solid #3a5a7c;font-size:10px;width:130px">ملخص (شامل ض.ق.م)</th>
    </tr>
    <tr>${supplierSubHeader}</tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
<div style="background:#1a3a5c;color:#c8a84b;text-align:center;font-size:9px;padding:6px;border-radius:0 0 4px 4px;margin-top:4px">
  قرطبة للتوريدات | INFO@CORTOBA-SUPPLIES.COM${closeDate ? ` | تاريخ الإغلاق: ${closeDate}` : ""} | ض.ق.م ${VAT_LABEL} | ${exportDate}
</div>`;

  document.body.appendChild(div);

  // Wait for Amiri font + images to render
  await document.fonts.ready;
  await new Promise<void>((r) => setTimeout(r, 800));

  // ── 9. Capture with html2canvas ───────────────────────────────────────────
  const canvas = await html2canvas(div, {
    scale: 2,
    useCORS: true,
    allowTaint: false,
    backgroundColor: "#ffffff",
    logging: false,
    width: 1122,
    height: div.scrollHeight,
  });

  document.body.removeChild(div);
  document.head.removeChild(fontStyle);

  // ── 10. Create PDF with jsPDF ─────────────────────────────────────────────
  const jspdfMod = await import("jspdf");
  const JsPDF = (jspdfMod as { jsPDF?: typeof jspdfMod.jsPDF; default?: typeof jspdfMod.jsPDF }).jsPDF
    ?? (jspdfMod as { jsPDF?: typeof jspdfMod.jsPDF; default?: typeof jspdfMod.jsPDF }).default;
  const doc = new JsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const PW = doc.internal.pageSize.getWidth();   // 297 mm
  const PH = doc.internal.pageSize.getHeight();  // 210 mm

  const totalPx = canvas.height;
  const pxPerMm = canvas.width / PW;
  const pageHeightPx = Math.floor(PH * pxPerMm);

  let yPx = 0;
  let firstPage = true;
  while (yPx < totalPx) {
    if (!firstPage) doc.addPage();
    firstPage = false;
    const sliceH = Math.min(pageHeightPx, totalPx - yPx);

    const slice = document.createElement("canvas");
    slice.width = canvas.width;
    slice.height = sliceH;
    const ctx = slice.getContext("2d")!;
    ctx.drawImage(canvas, 0, yPx, canvas.width, sliceH, 0, 0, canvas.width, sliceH);

    const sliceData = slice.toDataURL("image/jpeg", 0.92);
    const sliceHmm = sliceH / pxPerMm;
    doc.addImage(sliceData, "JPEG", 0, 0, PW, sliceHmm);
    yPx += pageHeightPx;
  }

  doc.save(`RFQ-Comparison-${rfqNo}.pdf`);
}

// ── Main page component ───────────────────────────────────────────────────────
export default function RfqDetailPage() {
  const { id } = useParams<{ id: string }>();
  const rfqId = parseInt(id, 10);
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<Tab>("items");
  const [exporting, setExporting] = useState<"excel" | "pdf" | "dispatch" | null>(null);

  const { data: rfq, isLoading } = useGetRfq(rfqId, {
    query: { queryKey: getGetRfqQueryKey(rfqId), enabled: !!rfqId },
  });
  const { data: items } = useListRfqItems(rfqId, {
    query: { queryKey: getListRfqItemsQueryKey(rfqId), enabled: !!rfqId },
  });
  const { data: sentLog, isLoading: sentLogLoading } = useGetRfqSentLog(rfqId, {
    query: { queryKey: getGetRfqSentLogQueryKey(rfqId), enabled: tab === "sent" && !!rfqId },
  });
  const { data: offersData } = useGetRfqOffers(rfqId, {
    query: {
      queryKey: getGetRfqOffersQueryKey(rfqId),
      enabled: (tab === "offers" || exporting != null) && !!rfqId,
    },
  });

  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const cancelMutation = useUpdateRfq({
    mutation: {
      onSuccess: () => {
        toast.success("تم إلغاء طلب التسعير بنجاح");
        navigate("/rfq");
      },
      onError: () => {
        toast.error("حدث خطأ أثناء إلغاء الطلب");
        setShowCancelConfirm(false);
      },
    },
  });

  const handleExportExcel = async () => {
    if (!rfq || !offersData) return;
    setExporting("excel");
    try {
      await exportToExcel(rfq.internalRfqNo, rfq.customerRfqNo, offersData as OffersData);
    } catch (err) {
      toast.error("Excel export failed: " + (err instanceof Error ? err.message : "Unknown error"));
    } finally {
      setExporting(null);
    }
  };

  const handleExportDispatch = async () => {
    if (!rfq) return;
    setExporting("dispatch");
    try {
      await exportDispatchReport(rfqId, rfq.internalRfqNo);
    } catch (err) {
      toast.error("Dispatch report failed: " + (err instanceof Error ? err.message : "Unknown error"));
    } finally {
      setExporting(null);
    }
  };

  const handleExportPdf = async () => {
    if (!rfq || !offersData) return;
    setExporting("pdf");
    try {
      await exportToPdf(rfq.internalRfqNo, rfq.customerRfqNo, offersData as OffersData, rfq.employeeName, rfqId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error(`PDF export failed: ${msg}`);
    } finally {
      setExporting(null);
    }
  };

  if (isLoading) {
    return (
      <Layout>
        <div className="p-6 space-y-4">
          <div className="h-6 bg-muted rounded w-64 animate-pulse" />
          <div className="h-32 bg-muted rounded-lg animate-pulse" />
        </div>
      </Layout>
    );
  }

  if (!rfq) {
    return (
      <Layout>
        <div className="p-6">
          <p className="text-muted-foreground">RFQ not found.</p>
        </div>
      </Layout>
    );
  }

  const hasOffers = (offersData?.offers?.length ?? 0) > 0;

  return (
    <Layout>
      <div className="p-6 space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <Link href="/rfq">
              <a className="text-muted-foreground hover:text-foreground mt-1">
                <ArrowLeft size={18} />
              </a>
            </Link>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-bold text-foreground font-mono">{rfq.internalRfqNo}</h1>
                <StatusBadge status={rfq.status} />
              </div>
              <p className="text-muted-foreground text-sm mt-0.5">
                Customer RFQ: <span className="font-mono">{rfq.customerRfqNo}</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {rfq.status === "draft" && (
              showCancelConfirm ? (
                <>
                  <span className="text-xs text-muted-foreground">هل أنت متأكد من الإلغاء؟</span>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => cancelMutation.mutate({ id: rfqId, data: { status: "cancelled" } })}
                    disabled={cancelMutation.isPending}
                    className="gap-1.5"
                  >
                    <Trash2 size={14} />
                    نعم، إلغاء
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowCancelConfirm(false)}>
                    لا
                  </Button>
                </>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowCancelConfirm(true)}
                  className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
                >
                  <Trash2 size={14} />
                  إلغاء الطلب
                </Button>
              )
            )}
            {rfq.status !== "closed" && rfq.status !== "cancelled" && (
              <Button onClick={() => navigate(`/rfq/${rfqId}/send`)} size="sm" className="gap-1.5">
                <Send size={14} />
                Send to Suppliers
              </Button>
            )}
          </div>
        </div>

        {/* Meta */}
        <div className="bg-card border border-border rounded-lg px-5 py-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-muted-foreground text-xs">Employee</p>
            <p className="font-medium text-foreground">{rfq.employeeName ?? "-"}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Items</p>
            <p className="font-medium text-foreground">{rfq.itemCount}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Suppliers Contacted</p>
            <p className="font-medium text-foreground">{rfq.supplierCount}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Offers Received</p>
            <p className="font-medium text-foreground">{rfq.offerCount}</p>
          </div>
          {rfq.notes && (
            <div className="col-span-full">
              <p className="text-muted-foreground text-xs">Notes</p>
              <p className="text-foreground">{rfq.notes}</p>
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="border-b border-border flex items-center justify-between">
          <div className="flex gap-0">
            {(["items", "sent", "offers"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "px-4 py-2.5 text-sm font-medium border-b-2 -mb-px capitalize transition-colors",
                  tab === t
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {t === "items" && `Items (${rfq.itemCount})`}
                {t === "sent" && `Sent Log (${rfq.supplierCount})`}
                {t === "offers" && `Offers & Analysis (${rfq.offerCount})`}
              </button>
            ))}
          </div>

          {/* Export: Dispatch Report on Sent tab */}
          {tab === "sent" && (rfq.supplierCount ?? 0) > 0 && (
            <div className="flex items-center gap-2 pb-0.5">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs h-8"
                onClick={handleExportDispatch}
                disabled={exporting !== null || sentLogLoading}
              >
                <ClipboardList size={14} className="text-blue-600" />
                {exporting === "dispatch" ? "جاري التصدير..." : "تقرير الإرسال PDF"}
              </Button>
            </div>
          )}

          {/* Export: Offers tab */}
          {tab === "offers" && hasOffers && (
            <div className="flex items-center gap-2 pb-0.5">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs h-8"
                onClick={handleExportExcel}
                disabled={exporting !== null}
              >
                <FileSpreadsheet size={14} className="text-green-600" />
                {exporting === "excel" ? "جاري التصدير..." : "Export Excel"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs h-8"
                onClick={handleExportPdf}
                disabled={exporting !== null}
              >
                <FileText size={14} className="text-red-500" />
                {exporting === "pdf" ? "جاري إنشاء PDF..." : "Export PDF"}
              </Button>
            </div>
          )}
        </div>

        {/* Items Tab */}
        {tab === "items" && (
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            {!items?.length ? (
              <div className="p-8 text-center text-muted-foreground text-sm">No items on this RFQ yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/30 border-b border-border text-left">
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium w-10">#</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Part No</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Description</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">QTY</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">UOM</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-right">Ref. Price</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, i) => (
                    <tr key={item.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-3 text-muted-foreground text-xs text-center">{i + 1}</td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{item.partNo ?? "-"}</td>
                      <td className="px-4 py-3 text-foreground text-sm">{item.description}</td>
                      <td className="px-4 py-3 text-center text-foreground text-sm">{item.qty ?? "-"}</td>
                      <td className="px-4 py-3 text-center text-foreground text-xs">{item.uom ?? "-"}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                        {item.referencePrice != null
                          ? item.referencePrice.toLocaleString("en-EG", { minimumFractionDigits: 2 })
                          : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Sent Log Tab */}
        {tab === "sent" && (
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            {sentLogLoading ? (
              <div className="p-8 text-center text-muted-foreground text-sm animate-pulse">
                جاري تحميل سجل الإرسال...
              </div>
            ) : !sentLog?.length ? (
              <div className="p-8 text-center text-muted-foreground text-sm">
                RFQ hasn't been sent to any suppliers yet.
                <div className="mt-3">
                  <Button onClick={() => navigate(`/rfq/${rfqId}/send`)} size="sm" className="gap-1.5">
                    <Send size={14} /> Send Now
                  </Button>
                </div>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/30 border-b border-border text-left">
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Supplier</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Phone</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Email</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">Link Opened</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">Views</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">Offer</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Close Date</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {sentLog.map((log) => (
                    <tr key={log.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-3">
                        <p className="font-medium text-foreground text-sm">{log.supplierName}</p>
                        {log.contactPerson && <p className="text-muted-foreground text-xs">{log.contactPerson}</p>}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs font-mono">{log.phone ?? "-"}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{log.email ?? "-"}</td>
                      <td className="px-4 py-3 text-center">
                        {log.linkOpened
                          ? <Eye size={15} className="inline text-blue-500" />
                          : <span className="text-muted-foreground text-xs">-</span>}
                      </td>
                      <td className="px-4 py-3 text-center text-xs text-foreground">{log.openCount ?? 0}</td>
                      <td className="px-4 py-3 text-center">
                        {log.offerSubmitted
                          ? <CheckCircle2 size={15} className="inline text-green-500" />
                          : <XCircle size={15} className="inline text-muted-foreground" />}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{log.closeDate ?? "-"}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {new Date(log.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Offers & Analysis Tab */}
        {tab === "offers" && (
          <div className="space-y-5">
            {/* VAT notice banner */}
            {hasOffers && (
              <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-xs text-amber-800">
                <AlertTriangle size={14} className="text-amber-500 shrink-0" />
                <span>
                  جميع مقارنات الأسعار تأخذ في الحسبان{" "}
                  <strong>ضريبة القيمة المضافة {VAT_LABEL}</strong>.
                  الأسعار التي لا تشمل الضريبة يُضاف إليها {VAT_RATE * 100}% للمقارنة العادلة.
                  العمود <strong>"السعر شاملاً ض.ق.م"</strong> هو المرجع للمقارنة.
                </span>
              </div>
            )}

            {!hasOffers ? (
              <div className="bg-card border border-border rounded-lg p-8 text-center text-muted-foreground text-sm">
                No offers received yet.
              </div>
            ) : (
              <>
                {offersData?.analysis?.itemAnalysis?.map((item) => {
                  // Ensure priceWithVat exists (fallback for older API responses)
                  const enrichedOffers: OfferRow[] = (item.offers as OfferRow[]).map((o) => ({
                    ...o,
                    priceWithVat:
                      (o as OfferRow).priceWithVat ??
                      (o.taxIncluded ? o.price : o.price * (1 + VAT_RATE)),
                  }));

                  return (
                    <div key={item.rfqItemId} className="bg-card border border-border rounded-lg overflow-hidden">
                      {/* Item header */}
                      <div className="px-5 py-3 border-b border-border bg-muted/20">
                        <p className="font-medium text-foreground text-sm">{item.description}</p>
                        <p className="text-muted-foreground text-xs mt-0.5">
                          {item.partNo && <span className="font-mono mr-2">{item.partNo}</span>}
                          {item.qty && `QTY: ${item.qty} ${item.uom ?? ""}`}
                          {item.referencePrice != null && (
                            <span className="ml-2">
                              Ref: EGP{" "}
                              {item.referencePrice.toLocaleString("en-EG", { minimumFractionDigits: 2 })}
                            </span>
                          )}
                        </p>
                      </div>

                      {enrichedOffers.length === 0 ? (
                        <div className="px-5 py-4 text-muted-foreground text-xs">No quotes for this item yet</div>
                      ) : (
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-muted/10 border-b border-border text-left">
                              <th className="px-4 py-2 text-muted-foreground text-xs font-medium">المورد</th>
                              <th className="px-4 py-2 text-muted-foreground text-xs font-medium text-right">
                                السعر الأصلي (ج.م)
                              </th>
                              <th className="px-4 py-2 text-muted-foreground text-xs font-medium text-center">
                                يشمل الضريبة؟
                              </th>
                              <th className="px-4 py-2 text-muted-foreground text-xs font-medium text-right">
                                السعر شاملاً ض.ق.م {VAT_LABEL}
                              </th>
                              <th className="px-4 py-2 text-muted-foreground text-xs font-medium text-center">
                                مدة التسليم
                              </th>
                              <th className="px-4 py-2 text-muted-foreground text-xs font-medium text-right">
                                مقارنة بالمتوسط
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {enrichedOffers
                              .slice()
                              .sort((a, b) => a.priceWithVat - b.priceWithVat)
                              .map((o) => (
                                <tr key={o.supplierId} className="border-b border-border last:border-0 hover:bg-muted/5">
                                  <td className="px-4 py-2.5 text-foreground text-sm font-medium">
                                    {o.supplierName}
                                  </td>
                                  {/* Original price */}
                                  <td className="px-4 py-2.5 text-right font-mono text-xs text-muted-foreground">
                                    {o.price.toLocaleString("en-EG", { minimumFractionDigits: 2 })}
                                  </td>
                                  {/* Tax included indicator */}
                                  <td className="px-4 py-2.5 text-center text-xs">
                                    {o.taxIncluded ? (
                                      <span className="inline-flex items-center gap-0.5 text-green-700 bg-green-50 border border-green-200 rounded px-1.5 py-0.5">
                                        <CheckCircle2 size={10} /> نعم
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center gap-0.5 text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                                        <XCircle size={10} /> لا
                                      </span>
                                    )}
                                  </td>
                                  {/* VAT-inclusive price (primary comparison) */}
                                  <td className="px-4 py-2.5">
                                    <PriceCell
                                      price={o.price}
                                      priceWithVat={o.priceWithVat}
                                      taxIncluded={o.taxIncluded}
                                      isLowest={o.isLowest}
                                      isAnomaly={o.isAnomaly}
                                    />
                                  </td>
                                  {/* Delivery days */}
                                  <td className="px-4 py-2.5 text-center text-xs text-muted-foreground">
                                    {o.deliveryDays != null ? `${o.deliveryDays} يوم` : "—"}
                                  </td>
                                  {/* Deviation from average (VAT-adjusted) */}
                                  <td className={cn(
                                    "px-4 py-2.5 text-right text-xs font-medium",
                                    o.deviation < 0 ? "text-green-600" : "text-red-500"
                                  )}>
                                    {o.deviation > 0 ? "+" : ""}{o.deviation.toFixed(1)}%
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                          {item.minPrice != null && (
                            <tfoot className="bg-muted/30 border-t border-border">
                              <tr>
                                <td className="px-4 py-2 text-xs text-muted-foreground font-semibold" colSpan={3}>
                                  ملخص الأسعار شاملة ض.ق.م {VAT_LABEL}
                                </td>
                                <td className="px-4 py-2 text-right text-xs text-foreground font-mono" colSpan={3}>
                                  <span className="text-green-700 font-semibold">
                                    أقل: {item.minPrice.toLocaleString("en-EG", { minimumFractionDigits: 2 })}
                                  </span>
                                  <span className="mx-2 text-muted-foreground">|</span>
                                  <span>
                                    متوسط: {item.avgPrice?.toLocaleString("en-EG", { minimumFractionDigits: 2 })}
                                  </span>
                                  <span className="mx-2 text-muted-foreground">|</span>
                                  <span className="text-red-500">
                                    أعلى: {item.maxPrice?.toLocaleString("en-EG", { minimumFractionDigits: 2 })}
                                  </span>
                                </td>
                              </tr>
                            </tfoot>
                          )}
                        </table>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
}
