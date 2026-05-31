import { useState } from "react";
import { useParams, useLocation, Link } from "wouter";
import {
  useGetRfq,
  useListRfqItems,
  useGetRfqSentLog,
  useGetRfqOffers,
  getGetRfqQueryKey,
  getListRfqItemsQueryKey,
  getGetRfqSentLogQueryKey,
  getGetRfqOffersQueryKey,
} from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Send, Eye, CheckCircle2, XCircle, AlertTriangle, FileSpreadsheet, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type Tab = "items" | "sent" | "offers";

function PriceCell({ value, isLowest, isAnomaly }: { value: number; isLowest: boolean; isAnomaly: boolean }) {
  return (
    <span className={cn(
      "font-mono text-xs",
      isLowest && "text-green-700 font-bold",
      isAnomaly && "text-amber-600"
    )}>
      {value.toLocaleString("en-EG", { minimumFractionDigits: 2 })}
      {isLowest && <span className="ml-1 text-green-600 text-[10px]">LOW</span>}
      {isAnomaly && <span className="ml-1 text-amber-600 text-[10px]"><AlertTriangle size={10} className="inline" /></span>}
    </span>
  );
}

type OffersData = {
  analysis?: {
    itemAnalysis?: Array<{
      rfqItemId: number;
      description: string;
      partNo?: string | null;
      qty?: string | null;
      uom?: string | null;
      referencePrice?: number | null;
      minPrice?: number | null;
      maxPrice?: number | null;
      avgPrice?: number | null;
      offers: Array<{
        supplierId: number;
        supplierName: string;
        price: number;
        taxIncluded: boolean;
        deliveryDays?: number | null;
        deviation: number;
        isLowest: boolean;
        isAnomaly: boolean;
      }>;
    }>;
  };
  offers?: unknown[];
};

async function exportToExcel(rfqNo: string, customerRfqNo: string, offersData: OffersData) {
  const { utils, writeFile } = await import("xlsx");
  const wb = utils.book_new();

  const items = offersData.analysis?.itemAnalysis ?? [];

  const summaryRows: unknown[][] = [
    ["Cortoba Supplies - قرطبة للتوريدات"],
    ["RFQ Price Comparison Report"],
    [`Internal RFQ: ${rfqNo}`, `Customer RFQ: ${customerRfqNo}`],
    [`Exported: ${new Date().toLocaleDateString("en-EG")}`],
    [],
    ["#", "Part No", "Description", "QTY", "UOM", "Ref. Price (EGP)", "Supplier", "Unit Price (EGP)", "Tax Inc.", "Lead (days)", "vs. Avg %", "Lowest?"],
  ];

  items.forEach((item, idx) => {
    const sorted = item.offers.slice().sort((a, b) => a.price - b.price);
    if (sorted.length === 0) {
      summaryRows.push([
        idx + 1, item.partNo ?? "-", item.description, item.qty ?? "-", item.uom ?? "-",
        item.referencePrice ?? "-", "No offers yet", "", "", "", "", "",
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
          o.deliveryDays ?? "-",
          `${o.deviation > 0 ? "+" : ""}${o.deviation.toFixed(1)}%`,
          o.isLowest ? "YES" : "",
        ]);
      });
      summaryRows.push([
        "", "", "", "", "", "",
        "Summary",
        `Min: ${item.minPrice?.toFixed(2) ?? "-"} | Avg: ${item.avgPrice?.toFixed(2) ?? "-"} | Max: ${item.maxPrice?.toFixed(2) ?? "-"}`,
        "", "", "", "",
      ]);
      summaryRows.push([]);
    }
  });

  const ws = utils.aoa_to_sheet(summaryRows);
  ws["!cols"] = [
    { wch: 4 }, { wch: 14 }, { wch: 40 }, { wch: 8 }, { wch: 8 },
    { wch: 16 }, { wch: 28 }, { wch: 16 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 8 },
  ];
  utils.book_append_sheet(wb, ws, "Price Comparison");
  writeFile(wb, `RFQ-Comparison-${rfqNo}.xlsx`);
}

async function exportToPdf(rfqId: number, rfqNo: string): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 35_000);
  try {
    const response = await fetch(`/api/rfq/${rfqId}/offers/pdf`, {
      credentials: "include",
      signal: controller.signal,
    });
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
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `RFQ-Comparison-${rfqNo}.pdf`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Delay revoke so the browser finishes reading the blob before it is freed
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } finally {
    clearTimeout(timeoutId);
  }
}

export default function RfqDetailPage() {
  const { id } = useParams<{ id: string }>();
  const rfqId = parseInt(id, 10);
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<Tab>("items");
  const [exporting, setExporting] = useState<"excel" | "pdf" | null>(null);

  const { data: rfq, isLoading } = useGetRfq(rfqId, { query: { queryKey: getGetRfqQueryKey(rfqId), enabled: !!rfqId } });
  const { data: items } = useListRfqItems(rfqId, { query: { queryKey: getListRfqItemsQueryKey(rfqId), enabled: !!rfqId } });
  const { data: sentLog } = useGetRfqSentLog(rfqId, { query: { queryKey: getGetRfqSentLogQueryKey(rfqId), enabled: tab === "sent" && !!rfqId } });
  const { data: offersData } = useGetRfqOffers(rfqId, { query: { queryKey: getGetRfqOffersQueryKey(rfqId), enabled: (tab === "offers" || exporting != null) && !!rfqId } });

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

  const handleExportPdf = async () => {
    if (!rfq) return;
    setExporting("pdf");
    try {
      await exportToPdf(rfqId, rfq.internalRfqNo);
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
              <p className="text-muted-foreground text-sm mt-0.5">Customer RFQ: <span className="font-mono">{rfq.customerRfqNo}</span></p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {rfq.status !== "closed" && (
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

          {/* Export buttons — shown only on Offers tab when there's data */}
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
                {exporting === "excel" ? "Exporting..." : "Export Excel"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs h-8"
                onClick={handleExportPdf}
                disabled={exporting !== null}
              >
                <FileText size={14} className="text-red-500" />
                {exporting === "pdf" ? "Exporting..." : "Export PDF"}
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
            {!sentLog?.length ? (
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
            {!hasOffers ? (
              <div className="bg-card border border-border rounded-lg p-8 text-center text-muted-foreground text-sm">
                No offers received yet.
              </div>
            ) : (
              <>
                {offersData?.analysis?.itemAnalysis?.map((item) => (
                  <div key={item.rfqItemId} className="bg-card border border-border rounded-lg overflow-hidden">
                    <div className="px-5 py-3 border-b border-border bg-muted/20">
                      <p className="font-medium text-foreground text-sm">{item.description}</p>
                      <p className="text-muted-foreground text-xs mt-0.5">
                        {item.partNo && <span className="font-mono mr-2">{item.partNo}</span>}
                        {item.qty && `QTY: ${item.qty} ${item.uom ?? ""}`}
                        {item.referencePrice != null && (
                          <span className="ml-2">Ref: EGP {item.referencePrice.toLocaleString("en-EG", { minimumFractionDigits: 2 })}</span>
                        )}
                      </p>
                    </div>
                    {item.offers.length === 0 ? (
                      <div className="px-5 py-4 text-muted-foreground text-xs">No quotes for this item yet</div>
                    ) : (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-muted/10 border-b border-border text-left">
                            <th className="px-4 py-2 text-muted-foreground text-xs font-medium">Supplier</th>
                            <th className="px-4 py-2 text-muted-foreground text-xs font-medium text-right">Unit Price (EGP)</th>
                            <th className="px-4 py-2 text-muted-foreground text-xs font-medium text-center">Tax Inc.</th>
                            <th className="px-4 py-2 text-muted-foreground text-xs font-medium text-center">Lead (days)</th>
                            <th className="px-4 py-2 text-muted-foreground text-xs font-medium text-right">vs. Avg</th>
                          </tr>
                        </thead>
                        <tbody>
                          {item.offers
                            .slice()
                            .sort((a, b) => a.price - b.price)
                            .map((o) => (
                              <tr key={o.supplierId} className="border-b border-border last:border-0">
                                <td className="px-4 py-2.5 text-foreground text-sm">{o.supplierName}</td>
                                <td className="px-4 py-2.5 text-right">
                                  <PriceCell value={o.price} isLowest={o.isLowest} isAnomaly={o.isAnomaly} />
                                </td>
                                <td className="px-4 py-2.5 text-center text-xs text-muted-foreground">
                                  {o.taxIncluded ? "Yes" : "No"}
                                </td>
                                <td className="px-4 py-2.5 text-center text-xs text-muted-foreground">
                                  {o.deliveryDays ?? "-"}
                                </td>
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
                          <tfoot className="bg-muted/20">
                            <tr>
                              <td className="px-4 py-2 text-xs text-muted-foreground font-medium">Summary</td>
                              <td className="px-4 py-2 text-right text-xs text-muted-foreground" colSpan={2}>
                                Min: {item.minPrice?.toLocaleString("en-EG", { minimumFractionDigits: 2 })}
                                &nbsp;|&nbsp;Avg: {item.avgPrice?.toLocaleString("en-EG", { minimumFractionDigits: 2 })}
                                &nbsp;|&nbsp;Max: {item.maxPrice?.toLocaleString("en-EG", { minimumFractionDigits: 2 })}
                              </td>
                              <td colSpan={2} />
                            </tr>
                          </tfoot>
                        )}
                      </table>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
}
