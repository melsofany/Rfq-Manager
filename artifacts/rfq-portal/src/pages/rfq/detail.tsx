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

// ── Offers PDF — client-side via jsPDF + autotable ───────────────────────────
async function exportToPdf(
  rfqNo: string,
  customerRfqNo: string,
  offersData: OffersData,
): Promise<void> {
  // Dynamic imports — jsPDF v4 uses named export { jsPDF }
  const [jspdfMod, { default: autoTable }] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);
  // Support both named export (v4) and default export (older)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const JsPDF: new (...args: unknown[]) => unknown = (jspdfMod as Record<string, unknown>).jsPDF as never
    ?? (jspdfMod as Record<string, unknown>).default as never;
  if (!JsPDF) throw new Error("jsPDF module could not be loaded");

  const items: ItemAnalysis[] = normalizeItems(offersData);
  if (items.length === 0) throw new Error("لا توجد عروض لتصديرها");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = new (JsPDF as any)({ orientation: "landscape", unit: "mm", format: "a4" });

  const BLUE = [26, 58, 92] as [number, number, number];
  const GOLD = [200, 168, 75] as [number, number, number];
  const GREEN = [22, 101, 52] as [number, number, number];
  const AMBER = [180, 83, 9] as [number, number, number];
  const WHITE: [number, number, number] = [255, 255, 255];
  const GREY: [number, number, number] = [244, 248, 252];

  const PW = doc.internal.pageSize.getWidth();
  const MARGIN = 10;
  const CW = PW - MARGIN * 2;

  // ── Header ────────────────────────────────────────────────────────────────
  doc.setFillColor(...BLUE);
  doc.rect(0, 0, PW, 22, "F");
  doc.setTextColor(...WHITE);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("RFQ PRICE COMPARISON REPORT", MARGIN + 2, 10);
  doc.setTextColor(...GOLD);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text("Cortoba Supplies | VAT-inclusive comparison", MARGIN + 2, 17);

  // ── Info band ─────────────────────────────────────────────────────────────
  doc.setFillColor(...GREY);
  doc.rect(MARGIN, 24, CW, 14, "F");
  doc.setFillColor(...GOLD);
  doc.rect(MARGIN, 38, CW, 1, "F");

  const infoCells = [
    { label: "Internal RFQ", value: rfqNo },
    { label: "Customer RFQ", value: customerRfqNo },
    { label: "Export Date", value: new Date().toLocaleDateString("en-GB") },
    { label: "Items", value: String(items.length) },
    { label: "VAT Rate", value: VAT_LABEL },
  ];
  const cellW = CW / infoCells.length;
  infoCells.forEach((c, i) => {
    const cx = MARGIN + i * cellW + cellW / 2;
    doc.setTextColor(136, 153, 170);
    doc.setFontSize(6.5);
    doc.setFont("helvetica", "normal");
    doc.text(c.label, cx, 29, { align: "center" });
    doc.setTextColor(...BLUE);
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.text(c.value, cx, 36, { align: "center" });
  });

  // ── VAT note ──────────────────────────────────────────────────────────────
  doc.setTextColor(100, 100, 100);
  doc.setFontSize(6.5);
  doc.setFont("helvetica", "italic");
  doc.text(
    `(*) "Price incl. VAT" column = supplier price × 1.14 when tax NOT included, otherwise price as-is. Min/Avg/Max are VAT-adjusted.`,
    MARGIN,
    43,
  );

  // ── Build table data ──────────────────────────────────────────────────────
  const allSuppliers = Array.from(
    new Set(items.flatMap((item) => item.offers.map((o) => o.supplierName)))
  );

  // Headers
  const head: (string | { content: string; colSpan?: number })[][] = [];

  // Row 1: fixed cols + supplier group spans
  const row1: { content: string; colSpan?: number; styles?: object }[] = [
    { content: "#" },
    { content: "Description" },
    { content: "Part No" },
    { content: "QTY / UOM" },
    ...allSuppliers.map((s) => ({
      content: s,
      colSpan: 2,
      styles: { halign: "center" as const },
    })),
    { content: "Summary (Incl. VAT)" },
  ];
  head.push(row1 as never);

  // Row 2: sub-headers for each supplier pair
  const row2: { content: string; styles?: object }[] = [
    { content: "" },
    { content: "" },
    { content: "" },
    { content: "" },
    ...allSuppliers.flatMap(() => [
      { content: "Original (EGP)", styles: { fontSize: 6, textColor: [180, 83, 9] } },
      { content: "Incl. VAT (EGP) *", styles: { fontSize: 6, textColor: [22, 101, 52] } },
    ]),
    { content: "" },
  ];
  head.push(row2 as never);

  // Body rows
  const body: (string | { content: string; styles: object })[][] = [];

  items.forEach((item, idx) => {
    const bySupplier = new Map<string, OfferRow>();
    for (const o of item.offers) bySupplier.set(o.supplierName, o);

    const summaryText =
      item.minPrice != null
        ? `Min: ${item.minPrice.toFixed(2)}\nAvg: ${item.avgPrice?.toFixed(2)}\nMax: ${item.maxPrice?.toFixed(2)}`
        : "No quotes";

    const row: (string | { content: string; styles: object })[] = [
      String(idx + 1),
      item.description,
      item.partNo ?? "—",
      item.qty != null ? `${item.qty} ${item.uom ?? ""}`.trim() : "—",
      ...allSuppliers.flatMap((s) => {
        const o = bySupplier.get(s);
        if (!o) return ["—", "—"];
        const origColor = o.taxIncluded ? [80, 80, 80] : [140, 100, 0];
        const vatColor = o.isLowest ? GREEN : o.isAnomaly ? AMBER : [50, 50, 50];
        return [
          {
            content: o.price.toLocaleString("en-EG", { minimumFractionDigits: 2 }),
            styles: { textColor: origColor, halign: "right" },
          },
          {
            content: o.priceWithVat.toLocaleString("en-EG", { minimumFractionDigits: 2 }) + (o.isLowest ? " ✓" : ""),
            styles: { textColor: vatColor, fontStyle: o.isLowest ? "bold" : "normal", halign: "right" },
          },
        ];
      }),
      summaryText,
    ];
    body.push(row);
  });

  // ── Render table ──────────────────────────────────────────────────────────
  autoTable(doc, {
    head,
    body,
    startY: 46,
    margin: { left: MARGIN, right: MARGIN },
    tableWidth: CW,
    styles: {
      font: "helvetica",
      fontSize: 7.5,
      cellPadding: 2,
      lineColor: [208, 219, 232],
      lineWidth: 0.2,
      overflow: "linebreak",
    },
    headStyles: {
      fillColor: BLUE,
      textColor: WHITE,
      fontStyle: "bold",
      fontSize: 7,
      halign: "center",
    },
    alternateRowStyles: { fillColor: GREY },
    columnStyles: {
      0: { cellWidth: 8, halign: "center" },
      1: { cellWidth: 55 },
      2: { cellWidth: 25, halign: "center" },
      3: { cellWidth: 18, halign: "center" },
      // Supplier cols assigned dynamically; last col = summary
      [4 + allSuppliers.length * 2]: { cellWidth: 38 },
    },
    didDrawPage: (data) => {
      // Repeat header on each page
      if (data.pageNumber > 1) {
        doc.setFillColor(...BLUE);
        doc.rect(0, 0, PW, 10, "F");
        doc.setTextColor(...GOLD);
        doc.setFontSize(8);
        doc.setFont("helvetica", "bold");
        doc.text(`${rfqNo} — Cont.`, MARGIN, 7);
      }
      // Footer
      const pageH = doc.internal.pageSize.getHeight();
      doc.setFillColor(...BLUE);
      doc.rect(0, pageH - 10, PW, 10, "F");
      doc.setTextColor(...GOLD);
      doc.setFontSize(7);
      doc.setFont("helvetica", "normal");
      doc.text(
        `Cortoba Supplies | INFO@CORTOBA-SUPPLIES.COM | All values in EGP | VAT ${VAT_LABEL} applied to tax-exclusive prices`,
        PW / 2,
        pageH - 4,
        { align: "center" },
      );
    },
  });

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
    if (!rfq) return;
    setExporting("pdf");
    try {
      const response = await fetch(`/api/rfq/${rfqId}/offers/pdf`, { credentials: "include" });
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
      if (!blob || blob.size === 0) throw new Error("الملف المُولَّد فارغ");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `RFQ-Comparison-${rfq.internalRfqNo}.pdf`;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
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
