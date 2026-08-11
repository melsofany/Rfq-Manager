import { useState } from "react";
import { useParams, useLocation, Link } from "wouter";
import {
  useGetRfq,
  useListRfqItems,
  useGetRfqSentLog,
  useGetRfqOffers,
  useUpdateRfq,
  useApproveOfferItem,
  getGetRfqQueryKey,
  getListRfqItemsQueryKey,
  getGetRfqSentLogQueryKey,
  getGetRfqOffersQueryKey,
} from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { AttachmentsPanel } from "../components/Attachments";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Send,
  Eye,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  FileSpreadsheet,
  FileText,
  ClipboardList,
  Trash2,
  Copy,
  ExternalLink,
  Paperclip,
  BadgeCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";

const VAT_RATE = 0.14;
const VAT_LABEL = "14%";

type Tab = "items" | "sent" | "offers" | "attachments";

type OfferRow = {
  offerItemId?: number;
  supplierId: number;
  supplierName: string;
  price: number;
  priceWithVat: number;
  taxIncluded: boolean;
  isApproved?: boolean;
  deliveryDays?: number | null;
  notes?: string | null;
  deviation: number;
  isLowest: boolean;
  isAnomaly: boolean;
  notPriced?: boolean;
  attachments?: Array<{
    id: number;
    originalName: string;
    mimeType?: string;
    sizeLabel?: string;
    downloadUrl?: string;
  }>;
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
  notPriced,
}: {
  price: number;
  priceWithVat: number;
  taxIncluded: boolean;
  isLowest: boolean;
  isAnomaly: boolean;
  notPriced?: boolean;
}) {
  return (
    <div className="text-right leading-tight">
      {/* VAT-inclusive price — primary comparison value */}
      <div
        className={cn(
          "font-mono text-xs font-semibold",
          !notPriced && isLowest && "text-green-700",
          !notPriced && isAnomaly && !isLowest && "text-amber-600",
          (notPriced || (!isLowest && !isAnomaly)) && "text-foreground",
        )}
      >
        {notPriced ? (
          <span className="text-xs text-muted-foreground italic">لم يسعّر</span>
        ) : (
          priceWithVat.toLocaleString("en-EG", { minimumFractionDigits: 2 })
        )}
        {!notPriced && isLowest && (
          <span className="ml-1 text-[9px] bg-green-100 text-green-700 rounded px-1">أقل سعر</span>
        )}
        {!notPriced && isAnomaly && !isLowest && (
          <AlertTriangle size={10} className="inline ml-1 text-amber-500" />
        )}
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
      priceWithVat:
        (o as OfferRow).priceWithVat ?? (o.taxIncluded ? o.price : o.price * (1 + VAT_RATE)),
      attachments: (o as OfferRow).attachments ?? [],
      notPriced: (o as OfferRow).notPriced ?? false,
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
      "#",
      "Part No",
      "Description",
      "QTY",
      "UOM",
      "Ref. Price (EGP)",
      "Supplier",
      "Original Price (EGP)",
      "Tax Inc.",
      "Price incl. VAT (EGP)",
      "Lead (days)",
      "vs. Avg (VAT-adj) %",
      "Lowest?",
    ],
  ];

  items.forEach((item, idx) => {
    const sorted = item.offers.slice().sort((a, b) => a.priceWithVat - b.priceWithVat);
    if (sorted.length === 0) {
      summaryRows.push([
        idx + 1,
        item.partNo ?? "-",
        item.description,
        item.qty ?? "-",
        item.uom ?? "-",
        item.referencePrice ?? "-",
        "No offers yet",
        "",
        "",
        "",
        "",
        "",
        "",
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
        "",
        "",
        "",
        "",
        "",
        "",
        "Summary (Incl. VAT)",
        `Min: ${item.minPrice?.toFixed(2) ?? "-"} | Avg: ${item.avgPrice?.toFixed(2) ?? "-"} | Max: ${item.maxPrice?.toFixed(2) ?? "-"}`,
        "",
        "",
        "",
        "",
        "",
      ]);
      summaryRows.push([]);
    }
  });

  const ws = utils.aoa_to_sheet(summaryRows);
  ws["!cols"] = [
    { wch: 4 },
    { wch: 14 },
    { wch: 40 },
    { wch: 8 },
    { wch: 8 },
    { wch: 16 },
    { wch: 28 },
    { wch: 16 },
    { wch: 10 },
    { wch: 18 },
    { wch: 12 },
    { wch: 18 },
    { wch: 8 },
  ];
  utils.book_append_sheet(wb, ws, "Price Comparison");
  writeFile(wb, `RFQ-Comparison-${rfqNo}.xlsx`);
}

// ── Dispatch report PDF — rewritten from scratch ─────────────────────────────
async function exportDispatchReport(rfqId: number, rfqNo: string): Promise<void> {
  // 1. Fetch PDF from the server
  let response: Response;
  try {
    response = await fetch(`/api/rfq/${rfqId}/dispatch-report`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/pdf" },
    });
  } catch (networkErr) {
    throw new Error("تعذّر الاتصال بالخادم — تحقق من اتصالك بالإنترنت");
  }

  // 2. Handle non-OK responses
  if (!response.ok) {
    let detail = `خطأ ${response.status}`;
    try {
      const errJson = (await response.json()) as { detail?: string; error?: string };
      detail = errJson.detail ?? errJson.error ?? detail;
    } catch {
      /* keep default */
    }
    throw new Error(detail);
  }

  // 3. Read response as blob
  const blob = await response.blob();
  if (!blob || blob.size === 0) {
    throw new Error("الملف المُولَّد فارغ — تواصل مع الدعم الفني");
  }

  // 4. Trigger browser download
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `Dispatch-Report-${rfqNo}.pdf`;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  // Clean up after the download starts
  setTimeout(() => {
    document.body.removeChild(anchor);
    URL.revokeObjectURL(objectUrl);
  }, 200);
}

// ── Offers PDF — print window opened SYNC then populated async ────────────────
async function exportToPdf(
  rfqNo: string,
  customerRfqNo: string,
  offersData: OffersData,
  employeeName: string | null | undefined,
  rfqId: number | undefined,
  printWin: Window,
): Promise<void> {
  const items: ItemAnalysis[] = normalizeItems(offersData);
  if (items.length === 0) throw new Error("لا توجد عروض لتصديرها");

  // Fetch close date
  let closeDate: string | null = null;
  try {
    if (rfqId) {
      const r = await fetch(`/api/rfq/${rfqId}/sent-log`, { credentials: "include" });
      if (r.ok) {
        const sl = (await r.json()) as Array<{ closeDate?: string | null }>;
        closeDate = sl?.find((e) => e.closeDate)?.closeDate ?? null;
      }
    }
  } catch {
    /* skip */
  }

  // Fetch logo as data URL
  let logoSrc = "";
  try {
    const r = await fetch("/logo.png");
    if (r.ok) {
      const blob = await r.blob();
      logoSrc = await new Promise<string>((res) => {
        const rd = new FileReader();
        rd.onload = () => res(rd.result as string);
        rd.readAsDataURL(blob);
      });
    }
  } catch {
    /* skip */
  }

  const exportDate = new Date().toLocaleDateString("ar-EG", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const allSuppliers = Array.from(
    new Set(items.flatMap((i) => i.offers.map((o) => o.supplierName))),
  );

  // Supplier header
  const supHeaders = allSuppliers.map((s) => `<th colspan="2">${s}</th>`).join("");
  const supSubHeaders = allSuppliers
    .map(() => `<th class="s">السعر (ج.م)</th><th class="s v">شامل ض.ق.م ✱</th>`)
    .join("");

  // HTML-escape helper
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // Rows (with per-item notes sub-rows)
  const rows = items
    .map((item, idx) => {
      const map = new Map<string, OfferRow>();
      for (const o of item.offers) map.set(o.supplierName, o);
      const cells = allSuppliers
        .map((s) => {
          const o = map.get(s);
          if (!o) return `<td>—</td><td>—</td>`;
          const cls = o.isLowest ? ' class="low"' : o.isAnomaly ? ' class="hi"' : "";
          return `<td>${o.price.toLocaleString("en-EG", { minimumFractionDigits: 2 })}</td>
              <td${cls}>${o.priceWithVat.toLocaleString("en-EG", { minimumFractionDigits: 2 })}${o.isLowest ? " ✓" : ""}</td>`;
        })
        .join("");
      const sum =
        item.minPrice != null
          ? `أقل: ${item.minPrice.toFixed(2)}<br>متوسط: ${item.avgPrice?.toFixed(2)}<br>أعلى: ${item.maxPrice?.toFixed(2)}`
          : "—";
      const bg = idx % 2 === 0 ? "" : ' class="alt"';
      const mainRow = `<tr${bg}>
      <td class="c">${idx + 1}</td>
      <td class="d">${item.description}</td>
      <td class="c ltr">${item.partNo ?? "—"}</td>
      <td class="c ltr">${item.qty != null ? `${item.qty} ${item.uom ?? ""}`.trim() : "—"}</td>
      ${cells}
      <td class="sm">${sum}</td>
    </tr>`;
      // Notes sub-row — only shown if at least one supplier left a note
      const detailCells = allSuppliers
        .map((s) => {
          const o = map.get(s);
          const parts: string[] = [];
          if (o?.deliveryDays != null) parts.push(`مدة التوريد: ${o.deliveryDays} يوم`);
          if (o?.notes) parts.push(esc(o.notes));
          return `<td colspan="2" class="ntd">${parts.join(" | ")}</td>`;
        })
        .join("");
      const hasDetails = allSuppliers.some(
        (s) => map.get(s)?.notes || map.get(s)?.deliveryDays != null,
      );
      const noteRow = hasDetails
        ? `<tr class="nrow"><td></td><td class="nlbl">مدة / ملاحظات</td><td colspan="2"></td>${detailCells}<td></td></tr>`
        : "";
      return mainRow + noteRow;
    })
    .join("");

  // ── Build supplier general notes + attachments HTML ─────────────────────────
  type _AttInfo = { originalName: string; downloadUrl?: string; mimeType?: string };
  type _RawOffer = {
    supplierId?: number;
    supplierName?: string | null;
    generalNotes?: string | null;
    attachments?: Array<{ originalName: string; downloadUrl?: string; mimeType?: string }>;
  };
  const _rawOffers = ((offersData as { offers?: _RawOffer[] }).offers ?? []) as _RawOffer[];
  const _withNotes = _rawOffers.filter((o) => o.generalNotes);

  // Collect attachments per supplier (from item-level offers which carry the attachment list)
  const _attBySupplier: Record<string, _AttInfo[]> = {};
  for (const item of items) {
    for (const o of item.offers) {
      if (o.attachments?.length && !_attBySupplier[o.supplierName]) {
        _attBySupplier[o.supplierName] = (o.attachments as _AttInfo[]).map((a) => ({
          originalName: a.originalName,
          downloadUrl: a.downloadUrl,
          mimeType: a.mimeType,
        }));
      }
    }
  }
  const _suppliersWithAtt = Object.keys(_attBySupplier).filter((s) => _attBySupplier[s].length > 0);

  // Pre-fetch images as base64 data-URLs so they embed in the print window
  const _IMG_MIMES = new Set([
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
    "image/bmp",
  ]);
  const _imgDataUrls: Record<string, string> = {};
  for (const sup of _suppliersWithAtt) {
    for (const att of _attBySupplier[sup]) {
      if (att.downloadUrl && _IMG_MIMES.has((att.mimeType ?? "").toLowerCase())) {
        try {
          const r = await fetch(att.downloadUrl, { credentials: "include" });
          if (r.ok) {
            const blob = await r.blob();
            const dataUrl = await new Promise<string>((res) => {
              const rd = new FileReader();
              rd.onload = () => res(rd.result as string);
              rd.readAsDataURL(blob);
            });
            _imgDataUrls[att.downloadUrl] = dataUrl;
          }
        } catch {
          /* skip — will fall back to filename */
        }
      }
    }
  }

  // Notes section (same page as table)
  let supplierSummaryHtml = "";
  if (_withNotes.length) {
    supplierSummaryHtml += '<div class="sn-section">';
    supplierSummaryHtml +=
      '<div class="sn-hdr">ملاحظات الموردين &nbsp;|&nbsp; Supplier Notes</div>';
    supplierSummaryHtml +=
      '<div class="sn-sub">الملاحظات العامة لكل مورد &nbsp;|&nbsp; General Notes per Supplier</div>';
    for (const o of _withNotes) {
      supplierSummaryHtml += `<div class="sn-row"><div class="sn-name">${esc(o.supplierName ?? "—")}</div><div class="sn-val">${esc(o.generalNotes ?? "")}</div></div>`;
    }
    supplierSummaryHtml += "</div>";
  }

  // Attachment pages — each image gets its own full printed page
  let attachmentPagesHtml = "";
  if (_suppliersWithAtt.length) {
    for (const sup of _suppliersWithAtt) {
      for (const att of _attBySupplier[sup]) {
        const isImage = _IMG_MIMES.has((att.mimeType ?? "").toLowerCase());
        const dataUrl = att.downloadUrl ? _imgDataUrls[att.downloadUrl] : undefined;
        attachmentPagesHtml += `<div class="att-page">
  <div class="att-page-hdr">
    <span class="att-page-sup">${esc(sup)}</span>
    <span class="att-page-fn">&#128206; ${esc(att.originalName)}</span>
    <span class="att-page-rfq">${esc(rfqNo)}</span>
  </div>
  <div class="att-page-body">`;
        if (isImage && dataUrl) {
          attachmentPagesHtml += `<img src="${dataUrl}" class="att-img" alt="${esc(att.originalName)}">`;
        } else {
          attachmentPagesHtml += `<div class="att-noimg">
      <div style="font-size:48px;margin-bottom:12px">&#128196;</div>
      <div style="font-size:14px;font-weight:600;color:#1a3a5c">${esc(att.originalName)}</div>
      <div style="font-size:10px;color:#888;margin-top:6px">هذا النوع من الملفات لا يمكن تضمينه في PDF</div>
    </div>`;
        }
        attachmentPagesHtml += `</div></div>`;
      }
    }
  }

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<title>RFQ ${rfqNo}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Cairo',Arial,sans-serif;direction:rtl;font-size:11px;background:#fff;color:#111;padding:6mm}
  @media print{
    @page{size:A4 landscape;margin:6mm}
    body{padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .nop{display:none}
  }

  /* ── Header ── */
  .hdr{display:flex;align-items:center;justify-content:space-between;background:#1a3a5c;color:#fff;padding:10px 16px;border-radius:6px 6px 0 0}
  .hdr img{height:52px;width:auto}
  .company{font-size:20px;font-weight:700;color:#c8a84b}
  .company-en{font-size:10px;color:#9bb8d4;margin:2px 0}
  .rtitle{font-size:13px;font-weight:600;margin-top:4px}

  /* ── Info band ── */
  .meta{display:flex;border:1px solid #d0dbe8;border-top:none;border-bottom:3px solid #c8a84b}
  .mc{flex:1;text-align:center;padding:6px 4px;border-left:1px solid #d0dbe8;background:#f7fafd}
  .mc:last-child{border-left:none}
  .ml{font-size:8.5px;color:#6b7e8f;font-weight:600;display:block}
  .ml2{font-size:7.5px;color:#9baab8;display:block;margin-bottom:3px}
  .mv{font-size:12px;font-weight:700;color:#1a3a5c}

  /* ── Note ── */
  .note{font-size:9px;color:#555;padding:4px 10px;background:#fffbf0;border-bottom:1px solid #e8d98a;margin-bottom:0}

  /* ── Table ── */
  table{width:100%;border-collapse:collapse;margin-top:0}
  th{background:#1a3a5c;color:#fff;padding:5px 4px;text-align:center;border:1px solid #2d527a;font-size:10px;font-weight:600}
  th.s{background:#24466e;color:#c8e0f0;font-weight:400;font-size:9px}
  th.v{color:#a8e0a8}
  td{padding:5px 4px;border:1px solid #dde6f0;vertical-align:middle;font-size:10px}
  tr.alt td{background:#f2f7fc}
  td.c{text-align:center}
  td.ltr{direction:ltr;unicode-bidi:embed;text-align:center}
  td.d{max-width:180px;word-break:break-word}
  td.sm{font-size:8.5px;color:#444;line-height:1.7}
  td.low{color:#15803d;font-weight:700}
  td.hi{color:#b45309}

  /* ── Footer ── */
  .ftr{background:#1a3a5c;color:#c8a84b;text-align:center;font-size:9px;padding:6px;border-radius:0 0 6px 6px;margin-top:6px}

  /* ── Notes row ── */
  tr.nrow td{background:#fffbeb;border-color:#f6e9c0;font-size:9px;color:#78350f;padding:3px 5px}
  td.nlbl{color:#92400e;font-weight:600;text-align:center;font-size:9px}
  td.ntd{font-style:italic}
  /* ── Supplier notes & attachments section ── */
  .sn-section{margin-top:8px;border:1px solid #d0dbe8;border-radius:6px;overflow:hidden}
  .sn-hdr{background:#1a3a5c;color:#c8a84b;padding:7px 12px;font-size:11px;font-weight:700}
  .sn-sub{background:#e8f0f8;padding:5px 10px;font-size:10px;color:#1a3a5c;font-weight:600;border-bottom:1px solid #d0dbe8;border-top:1px solid #d0dbe8;margin-top:4px}
  .sn-row{display:flex;border-bottom:1px solid #eef2f8;align-items:stretch}
  .sn-name{background:#dce8f5;color:#1a3a5c;font-weight:600;font-size:10px;padding:5px 8px;width:160px;min-width:160px;display:flex;align-items:center}
  .sn-val{padding:5px 10px;font-size:10px;flex:1;white-space:pre-wrap}
  .att-row{display:flex;align-items:center;padding:4px 10px;border-bottom:1px solid #eef2f8}
  .att-num{color:#aaa;font-size:9px;width:20px;text-align:center;margin-left:4px}
  .att-badge{background:#dce8f5;color:#1a3a5c;font-size:9px;font-weight:600;padding:2px 6px;border-radius:3px;margin:0 8px;white-space:nowrap}
  .att-fname{font-size:10px;color:#1a3a5c}
  /* ── Print button ── */
  .nop{text-align:center;padding:16px;background:#f0f4f8}
  .nop button{background:#1a3a5c;color:#fff;border:none;padding:10px 32px;font-family:Cairo,sans-serif;font-size:14px;font-weight:600;cursor:pointer;border-radius:6px;margin:4px}
  .nop button:hover{background:#245a82}
  .nop .sec{background:#64748b}
  /* ── Attachment full pages ── */
  .att-page{page-break-before:always;padding:6mm 0}
  @media print{.att-page{padding:0}}
  .att-page-hdr{background:#1a3a5c;color:#fff;padding:8px 14px;border-radius:6px 6px 0 0;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
  .att-page-sup{color:#c8a84b;font-weight:700;font-size:12px}
  .att-page-fn{font-size:10px;color:#9bb8d4;flex:1}
  .att-page-rfq{font-size:9px;color:#aaccee;white-space:nowrap}
  .att-page-body{border:1px solid #d0dbe8;border-top:none;border-radius:0 0 6px 6px;background:#fafbfc;display:flex;align-items:center;justify-content:center;min-height:160mm;padding:8px}
  @media print{.att-page-body{min-height:185mm}}
  .att-img{max-width:100%;max-height:180mm;object-fit:contain;display:block;margin:auto}
  @media print{.att-img{max-height:200mm}}
  .att-noimg{text-align:center;padding:40px;color:#666}
</style>
</head>
<body>

<div class="hdr">
  <div>
    <div class="company">قرطبة للتوريدات</div>
    <div class="company-en">Cortoba Supplies</div>
    <div class="rtitle">تقرير مقارنة عروض الأسعار &mdash; RFQ Price Comparison Report</div>
  </div>
  ${logoSrc ? `<img src="${logoSrc}" alt="">` : ""}
</div>

<div class="meta">
  <div class="mc"><span class="ml">رقم الطلب الداخلي</span><span class="ml2">Internal RFQ</span><span class="mv">${rfqNo}</span></div>
  <div class="mc"><span class="ml">رقم طلب العميل</span><span class="ml2">Customer RFQ</span><span class="mv">${customerRfqNo}</span></div>
  <div class="mc"><span class="ml">أعده</span><span class="ml2">Prepared By</span><span class="mv">${employeeName ?? "—"}</span></div>
  <div class="mc"><span class="ml">تاريخ الإغلاق</span><span class="ml2">Close Date</span><span class="mv">${closeDate ?? "—"}</span></div>
  <div class="mc"><span class="ml">تاريخ التصدير</span><span class="ml2">Export Date</span><span class="mv">${exportDate}</span></div>
  <div class="mc"><span class="ml">البنود</span><span class="ml2">Items</span><span class="mv">${items.length}</span></div>
  <div class="mc"><span class="ml">ض.ق.م</span><span class="ml2">VAT</span><span class="mv">${VAT_LABEL}</span></div>
</div>

<div class="note">✱ شامل ض.ق.م = السعر × 1.14 إن لم تشمل الضريبة، أو كما هو إن شملتها &nbsp;|&nbsp; ✓ = أقل سعر &nbsp;|&nbsp; جميع القيم بالجنيه المصري</div>

<table>
  <thead>
    <tr>
      <th rowspan="2" style="width:28px">#</th>
      <th rowspan="2" style="text-align:right;min-width:150px">البيان</th>
      <th rowspan="2" style="min-width:80px">Part No</th>
      <th rowspan="2" style="width:55px">الكمية</th>
      ${supHeaders}
      <th rowspan="2" style="min-width:110px">ملخص (شامل ض.ق.م)</th>
    </tr>
    <tr>${supSubHeaders}</tr>
  </thead>
  <tbody>${rows}</tbody>
</table>

${supplierSummaryHtml}
<div class="ftr">
  قرطبة للتوريدات &nbsp;|&nbsp; INFO@CORTOBA-SUPPLIES.COM
  ${closeDate ? `&nbsp;|&nbsp; تاريخ الإغلاق: ${closeDate}` : ""}
  &nbsp;|&nbsp; ض.ق.م ${VAT_LABEL} &nbsp;|&nbsp; ${exportDate}
</div>

${attachmentPagesHtml}

<div class="nop">
  <button onclick="window.print()">🖨️ &nbsp; طباعة / حفظ PDF</button>
  <button class="sec" onclick="window.close()">✕ إغلاق</button>
</div>

<script>
  // Wait for Cairo font then auto-print
  document.fonts.ready.then(function() {
    setTimeout(function(){ window.print(); }, 1000);
  });
</script>
</body>
</html>`;

  // Write final HTML to the already-open window
  printWin.document.open();
  printWin.document.write(html);
  printWin.document.close();
}

// ── Main page component ───────────────────────────────────────────────────────
export default function RfqDetailPage() {
  const { id } = useParams<{ id: string }>();
  const rfqId = parseInt(id, 10);
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<Tab>("items");
  const [exporting, setExporting] = useState<"excel" | "pdf" | "dispatch" | null>(null);
  const { employee } = useAuth();
  const isAdmin = employee?.role === "admin";

  const getPricingUrl = (token: string) => `${window.location.origin}/q/${token}`;

  const copyPricingLink = async (token: string, supplierName: string) => {
    try {
      await navigator.clipboard.writeText(getPricingUrl(token));
      toast.success(`تم نسخ رابط ${supplierName}`);
    } catch {
      toast.error("تعذّر نسخ الرابط");
    }
  };

  const { data: rfq, isLoading } = useGetRfq(rfqId, {
    query: { queryKey: getGetRfqQueryKey(rfqId), enabled: !!rfqId },
  });
  const { data: items } = useListRfqItems(rfqId, {
    query: { queryKey: getListRfqItemsQueryKey(rfqId), enabled: !!rfqId },
  });
  const { data: sentLog, isLoading: sentLogLoading } = useGetRfqSentLog(rfqId, {
    query: { queryKey: getGetRfqSentLogQueryKey(rfqId), enabled: tab === "sent" && !!rfqId },
  });
  const { data: offersData, isLoading: offersLoading } = useGetRfqOffers(rfqId, {
    query: {
      queryKey: getGetRfqOffersQueryKey(rfqId),
      enabled: (tab === "offers" || exporting != null) && !!rfqId,
    },
  });

  const [approvingId, setApprovingId] = useState<number | null>(null);
  const approveMutation = useApproveOfferItem({
    mutation: {
      onSuccess: () => {
        toast.success("تم تحديث حالة الاعتماد");
        setApprovingId(null);
      },
      onError: (err) => {
        toast.error("تعذّر تحديث الاعتماد: " + (err as Error).message);
        setApprovingId(null);
      },
    },
  });

  const handleToggleApprove = (offerItemId: number, currentlyApproved: boolean) => {
    setApprovingId(offerItemId);
    approveMutation.mutate({ offerItemId, data: { approved: !currentlyApproved } });
  };

  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const cancelMutation = useUpdateRfq({
    mutation: {
      onSuccess: () => {
        toast.success("تم تحديد الطلب كـ FAILED");
        navigate("/rfq");
      },
      onError: () => {
        toast.error("حدث خطأ أثناء تحديث حالة الطلب");
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
      toast.error(
        "Dispatch report failed: " + (err instanceof Error ? err.message : "Unknown error"),
      );
    } finally {
      setExporting(null);
    }
  };

  const handleExportPdf = () => {
    if (!rfq || !offersData) return;

    // ⚠ window.open MUST be called synchronously (before any await)
    // to avoid popup blocker — so we open first, populate async.
    const printWin = window.open(
      "",
      "_blank",
      "width=1280,height=860,scrollbars=yes,resizable=yes",
    );
    if (!printWin) {
      toast.error("يرجى السماح بالنوافذ المنبثقة في المتصفح ثم أعد المحاولة");
      return;
    }

    // Show loading state immediately
    printWin.document.write(
      '<html dir="rtl"><body style="font-family:Arial;text-align:center;padding:60px;font-size:16px;color:#1a3a5c">⏳ جاري إعداد التقرير...</body></html>',
    );

    setExporting("pdf");

    const run = async () => {
      try {
        await exportToPdf(
          rfq.internalRfqNo,
          rfq.customerRfqNo,
          offersData as OffersData,
          rfq.employeeName,
          rfqId,
          printWin,
        );
      } catch (err) {
        printWin.close();
        const msg = err instanceof Error ? err.message : "Unknown error";
        toast.error(`فشل التصدير: ${msg}`);
      } finally {
        setExporting(null);
      }
    };

    run();
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
      <div className="p-4 sm:p-6 space-y-5">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start gap-3">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <Link href="/rfq">
              <a className="text-muted-foreground hover:text-foreground mt-1 flex-shrink-0">
                <ArrowLeft size={18} />
              </a>
            </Link>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-bold text-foreground font-mono">{rfq.internalRfqNo}</h1>
                <StatusBadge status={rfq.status} />
              </div>
              <p className="text-muted-foreground text-sm mt-0.5 truncate">
                Customer RFQ: <span className="font-mono">{rfq.customerRfqNo}</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap flex-shrink-0">
            {(rfq.status === "DRAFT" || rfq.status === "SENT" || rfq.status === "QUOTED") &&
              (showCancelConfirm ? (
                <>
                  <span className="text-xs text-muted-foreground">
                    هل تريد تحديد الطلب كـ FAILED؟
                  </span>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => cancelMutation.mutate({ id: rfqId, data: { status: "FAILED" } })}
                    disabled={cancelMutation.isPending}
                    className="gap-1.5"
                  >
                    <Trash2 size={14} />
                    نعم، FAILED
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
                  فشل الطلب
                </Button>
              ))}
            {rfq.status !== "FAILED" && rfq.status !== "SUCCESS" && (
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
        <div className="border-b border-border space-y-0">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex overflow-x-auto scrollbar-none -mb-px">
              {(["items", "sent", "offers", "attachments"] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    "px-3 sm:px-4 py-2.5 text-xs sm:text-sm font-medium border-b-2 capitalize transition-colors whitespace-nowrap flex-shrink-0",
                    tab === t
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t === "items" && `Items (${rfq.itemCount})`}
                  {t === "sent" && `Sent Log (${rfq.supplierCount})`}
                  {t === "offers" && `Offers & Analysis (${rfq.offerCount})`}
                  {t === "attachments" && (
                    <span className="flex items-center gap-1">
                      <Paperclip size={13} />
                      المرفقات
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Export: Dispatch Report on Sent tab */}
            {tab === "sent" && (rfq.supplierCount ?? 0) > 0 && (
              <div className="flex items-center gap-2 pb-0.5 flex-shrink-0">
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
              <div className="flex items-center gap-2 pb-0.5 flex-shrink-0">
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
        </div>

        {/* Items Tab */}
        {tab === "items" && (
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            {!items?.length ? (
              <div className="p-8 text-center text-muted-foreground text-sm">
                No items on this RFQ yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/30 border-b border-border text-left">
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium w-10">
                        #
                      </th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                        Part No
                      </th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                        Description
                      </th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                        QTY
                      </th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                        UOM
                      </th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-right">
                        Ref. Price
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, i) => (
                      <tr key={item.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-3 text-muted-foreground text-xs text-center">
                          {i + 1}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                          {item.partNo ?? "-"}
                        </td>
                        <td className="px-4 py-3 text-foreground text-sm">{item.description}</td>
                        <td className="px-4 py-3 text-center text-foreground text-sm">
                          {item.qty ?? "-"}
                        </td>
                        <td className="px-4 py-3 text-center text-foreground text-xs">
                          {item.uom ?? "-"}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                          {item.referencePrice != null
                            ? item.referencePrice.toLocaleString("en-EG", {
                                minimumFractionDigits: 2,
                              })
                            : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
                  <Button
                    onClick={() => navigate(`/rfq/${rfqId}/send`)}
                    size="sm"
                    className="gap-1.5"
                  >
                    <Send size={14} /> Send Now
                  </Button>
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/30 border-b border-border text-left">
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                        Supplier
                      </th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                        Phone
                      </th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                        Email
                      </th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                        Link Opened
                      </th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                        Views
                      </th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                        Offer
                      </th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                        Close Date
                      </th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                        Sent
                      </th>
                      {isAdmin && (
                        <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                          رابط التسعير
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {sentLog.map((log) => (
                      <tr key={log.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-3">
                          <p className="font-medium text-foreground text-sm">{log.supplierName}</p>
                          {log.contactPerson && (
                            <p className="text-muted-foreground text-xs">{log.contactPerson}</p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground text-xs font-mono">
                          {log.phone ?? "-"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">
                          {log.email ?? "-"}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {log.linkOpened ? (
                            <Eye size={15} className="inline text-blue-500" />
                          ) : (
                            <span className="text-muted-foreground text-xs">-</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center text-xs text-foreground">
                          {log.openCount ?? 0}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {log.offerSubmitted ? (
                            <CheckCircle2 size={15} className="inline text-green-500" />
                          ) : (
                            <XCircle size={15} className="inline text-muted-foreground" />
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {log.closeDate ?? "-"}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {new Date(log.createdAt).toLocaleDateString()}
                        </td>
                        {isAdmin && (
                          <td className="px-4 py-3 text-center">
                            <div className="flex items-center justify-center gap-1">
                              <button
                                onClick={() => copyPricingLink(log.token, log.supplierName ?? "")}
                                title="نسخ رابط التسعير"
                                className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                              >
                                <Copy size={13} />
                              </button>
                              <a
                                href={getPricingUrl(log.token)}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="فتح رابط التسعير"
                                className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-blue-600 transition-colors"
                              >
                                <ExternalLink size={13} />
                              </a>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
                  <strong>ضريبة القيمة المضافة {VAT_LABEL}</strong>. الأسعار التي لا تشمل الضريبة
                  يُضاف إليها {VAT_RATE * 100}% للمقارنة العادلة. العمود{" "}
                  <strong>"السعر شاملاً ض.ق.م"</strong> هو المرجع للمقارنة.
                </span>
              </div>
            )}

            {offersLoading ? (
              <div className="bg-card border border-border rounded-lg p-8 text-center text-muted-foreground text-sm flex items-center justify-center gap-2">
                <svg
                  className="animate-spin h-4 w-4 text-muted-foreground"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                جار تحميل العروض...
              </div>
            ) : !hasOffers ? (
              <div className="bg-card border border-border rounded-lg p-8 text-center text-muted-foreground text-sm">
                لا توجد عروض حتى الآن.
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
                    notes: (o as OfferRow).notes ?? null,
                    isApproved: (o as OfferRow).isApproved ?? false,
                    offerItemId: (o as OfferRow).offerItemId,
                  }));

                  return (
                    <div
                      key={item.rfqItemId}
                      className="bg-card border border-border rounded-lg overflow-hidden"
                    >
                      {/* Item header */}
                      <div className="px-5 py-3 border-b border-border bg-muted/20">
                        <p className="font-medium text-foreground text-sm">{item.description}</p>
                        <p className="text-muted-foreground text-xs mt-0.5">
                          {item.partNo && <span className="font-mono mr-2">{item.partNo}</span>}
                          {item.qty && `QTY: ${item.qty} ${item.uom ?? ""}`}
                          {item.referencePrice != null && (
                            <span className="ml-2">
                              Ref: EGP{" "}
                              {item.referencePrice.toLocaleString("en-EG", {
                                minimumFractionDigits: 2,
                              })}
                            </span>
                          )}
                        </p>
                      </div>

                      {enrichedOffers.length === 0 ? (
                        <div className="px-5 py-4 text-muted-foreground text-xs">
                          No quotes for this item yet
                        </div>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="bg-muted/10 border-b border-border text-left">
                                <th className="px-4 py-2 text-muted-foreground text-xs font-medium">
                                  المورد
                                </th>
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
                                <th className="px-4 py-2 text-muted-foreground text-xs font-medium">
                                  ملاحظات البند
                                </th>
                                <th className="px-4 py-2 text-muted-foreground text-xs font-medium text-right">
                                  مقارنة بالمتوسط
                                </th>
                                <th className="px-4 py-2 text-muted-foreground text-xs font-medium text-center">
                                  اعتماد السعر
                                </th>
                                <th className="px-4 py-2 text-muted-foreground text-xs font-medium">
                                  مرفقات المورد
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {enrichedOffers
                                .slice()
                                .sort((a, b) => a.priceWithVat - b.priceWithVat)
                                .map((o) => (
                                  <tr
                                    key={o.supplierId}
                                    className="border-b border-border last:border-0 hover:bg-muted/5"
                                  >
                                    <td className="px-4 py-2.5 text-foreground text-sm font-medium">
                                      {o.supplierName}
                                    </td>
                                    {/* Original price */}
                                    <td className="px-4 py-2.5 text-right font-mono text-xs text-muted-foreground">
                                      {o.price.toLocaleString("en-EG", {
                                        minimumFractionDigits: 2,
                                      })}
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
                                        notPriced={o.notPriced}
                                      />
                                    </td>
                                    {/* Delivery days */}
                                    <td className="px-4 py-2.5 text-center text-xs text-muted-foreground">
                                      {o.deliveryDays != null ? `${o.deliveryDays} يوم` : "—"}
                                    </td>
                                    {/* Item notes */}
                                    <td className="px-4 py-2.5 text-xs text-muted-foreground max-w-[160px]">
                                      {o.notes ?? "—"}
                                    </td>
                                    {/* Deviation from average (VAT-adjusted) */}
                                    <td
                                      className={cn(
                                        "px-4 py-2.5 text-right text-xs font-medium",
                                        !o.notPriced && o.deviation < 0
                                          ? "text-green-600"
                                          : !o.notPriced
                                            ? "text-red-500"
                                            : "text-muted-foreground",
                                      )}
                                    >
                                      {o.notPriced
                                        ? "—"
                                        : (o.deviation > 0 ? "+" : "") +
                                          o.deviation.toFixed(1) +
                                          "%"}
                                    </td>
                                    {/* Approve supplier price (one per item) */}
                                    <td className="px-4 py-2.5 text-center">
                                      {o.offerItemId != null && !o.notPriced ? (
                                        <button
                                          onClick={() =>
                                            handleToggleApprove(o.offerItemId!, !!o.isApproved)
                                          }
                                          disabled={approvingId === o.offerItemId}
                                          title={
                                            o.isApproved
                                              ? "إلغاء اعتماد هذا السعر"
                                              : "اعتماد هذا السعر للبند (المرجع لفحص الهامش)"
                                          }
                                          className={cn(
                                            "inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                                            o.isApproved
                                              ? "bg-green-100 text-green-800 border border-green-300 hover:bg-green-200"
                                              : "bg-muted text-muted-foreground border border-border hover:bg-accent hover:text-foreground",
                                          )}
                                        >
                                          <BadgeCheck size={13} />
                                          {approvingId === o.offerItemId
                                            ? "..."
                                            : o.isApproved
                                              ? "معتمد"
                                              : "اعتماد"}
                                        </button>
                                      ) : (
                                        <span className="text-xs text-muted-foreground">—</span>
                                      )}
                                    </td>
                                    {/* Supplier attachments */}
                                    <td className="px-4 py-2.5">
                                      {o.attachments && o.attachments.length > 0 ? (
                                        <div className="flex flex-col gap-1">
                                          {o.attachments.map((att) => (
                                            <a
                                              key={att.id}
                                              href={att.downloadUrl}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 hover:underline max-w-[150px]"
                                              title={att.originalName}
                                            >
                                              <Paperclip size={11} className="shrink-0" />
                                              <span className="truncate">{att.originalName}</span>
                                              {att.sizeLabel && (
                                                <span className="text-muted-foreground shrink-0">
                                                  ({att.sizeLabel})
                                                </span>
                                              )}
                                            </a>
                                          ))}
                                        </div>
                                      ) : (
                                        <span className="text-xs text-muted-foreground">—</span>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                            {item.minPrice != null && (
                              <tfoot className="bg-muted/30 border-t border-border">
                                <tr>
                                  <td
                                    className="px-4 py-2 text-xs text-muted-foreground font-semibold"
                                    colSpan={3}
                                  >
                                    ملخص الأسعار شاملة ض.ق.م {VAT_LABEL}
                                  </td>
                                  <td
                                    className="px-4 py-2 text-right text-xs text-foreground font-mono"
                                    colSpan={6}
                                  >
                                    <span className="text-green-700 font-semibold">
                                      أقل:{" "}
                                      {item.minPrice.toLocaleString("en-EG", {
                                        minimumFractionDigits: 2,
                                      })}
                                    </span>
                                    <span className="mx-2 text-muted-foreground">|</span>
                                    <span>
                                      متوسط:{" "}
                                      {item.avgPrice?.toLocaleString("en-EG", {
                                        minimumFractionDigits: 2,
                                      })}
                                    </span>
                                    <span className="mx-2 text-muted-foreground">|</span>
                                    <span className="text-red-500">
                                      أعلى:{" "}
                                      {item.maxPrice?.toLocaleString("en-EG", {
                                        minimumFractionDigits: 2,
                                      })}
                                    </span>
                                  </td>
                                </tr>
                              </tfoot>
                            )}
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
                {/* General Notes per Supplier */}
                {(() => {
                  const offersWithNotes = (
                    offersData?.offers as
                      | Array<{
                          supplierId: number;
                          supplierName: string | null;
                          generalNotes?: string | null;
                        }>
                      | undefined
                  )?.filter((o) => o.generalNotes);
                  if (!offersWithNotes?.length) return null;
                  return (
                    <div className="bg-card border border-border rounded-lg overflow-hidden">
                      <div className="px-5 py-3 border-b border-border bg-muted/20">
                        <p className="font-medium text-foreground text-sm">
                          الملاحظات العامة من الموردين
                        </p>
                      </div>
                      <div className="divide-y divide-border">
                        {offersWithNotes.map((o) => (
                          <div key={o.supplierId} className="px-5 py-3">
                            <p className="text-xs font-semibold text-foreground mb-1">
                              {o.supplierName ?? "مورد"}
                            </p>
                            <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                              {o.generalNotes}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* Supplier Attachments Summary */}
                {(() => {
                  const offersWithAtts = (
                    offersData?.offers as
                      | Array<{
                          supplierId: number;
                          supplierName: string | null;
                          attachments?: Array<{
                            id: number;
                            originalName: string;
                            mimeType?: string;
                            sizeLabel?: string;
                            downloadUrl?: string;
                          }>;
                        }>
                      | undefined
                  )?.filter((o) => o.attachments && o.attachments.length > 0);
                  if (!offersWithAtts?.length) return null;
                  return (
                    <div className="bg-card border border-border rounded-lg overflow-hidden">
                      <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center gap-2">
                        <Paperclip size={14} className="text-muted-foreground" />
                        <p className="font-medium text-foreground text-sm">مرفقات الموردين</p>
                      </div>
                      <div className="divide-y divide-border">
                        {offersWithAtts.map((o) => (
                          <div key={o.supplierId} className="px-5 py-3">
                            <p className="text-xs font-semibold text-foreground mb-2">
                              {o.supplierName ?? "مورد"}
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {o.attachments!.map((att) => (
                                <a
                                  key={att.id}
                                  href={att.downloadUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1.5 text-xs bg-muted/50 border border-border rounded px-2.5 py-1.5 text-blue-600 hover:text-blue-800 hover:bg-blue-50 transition-colors"
                                >
                                  <Paperclip size={11} className="shrink-0" />
                                  <span className="max-w-[200px] truncate">{att.originalName}</span>
                                  {att.sizeLabel && (
                                    <span className="text-muted-foreground">({att.sizeLabel})</span>
                                  )}
                                </a>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        )}
        {/* ── Attachments tab ─────────────────────────────────────── */}
        {tab === "attachments" && (
          <div className="bg-card border border-border rounded-lg p-5">
            <p className="text-sm font-medium text-foreground mb-4">
              المرفقات الفنية للطلب (مواصفات، رسومات، ملفات)
            </p>
            <AttachmentsPanel
              listUrl={`/api/rfq/${rfqId}/attachments`}
              uploadUrl={`/api/rfq/${rfqId}/attachments`}
              deleteUrlBase="/api/rfq/attachments"
            />
          </div>
        )}
      </div>
    </Layout>
  );
}
