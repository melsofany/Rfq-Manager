import { useState, useEffect } from "react";
import { useParams } from "wouter";
import {
  useGetPricingPage,
  useSubmitOffer,
  useTrackLinkOpen,
  getGetPricingPageQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle2, Clock, AlertTriangle } from "lucide-react";

/** Row shown in the read-only submitted view */
interface SubmittedRow {
  rfqItemId: number;
  partNo?: string | null;
  description?: string | null;
  qty?: number | null;
  uom?: string | null;
  price: number;
  taxIncluded: boolean;
  deliveryDays?: number | null;
  notes?: string | null;
}

interface ItemPrice {
  rfqItemId: number;
  price: string;
  taxIncluded: boolean;
  deliveryDays: string;
  notes: string;
}

export default function PricingPage() {
  const { token } = useParams<{ token: string }>();
  const [submitted, setSubmitted] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [submittedRows, setSubmittedRows] = useState<SubmittedRow[]>([]);
  const [submittedGeneralNotes, setSubmittedGeneralNotes] = useState("");
  const [generalNotes, setGeneralNotes] = useState("");
  const [rfqAttachments, setRfqAttachments] = useState<
    Array<{
      id: number;
      originalName: string;
      mimeType: string;
      sizeLabel: string;
      downloadUrl: string;
    }>
  >([]);
  const [rfqAttachmentsLoaded, setRfqAttachmentsLoaded] = useState(false);
  const [offerFiles, setOfferFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadedOfferAtts, setUploadedOfferAtts] = useState<
    Array<{ id: number; originalName: string; sizeLabel: string }>
  >([]);
  const [prices, setPrices] = useState<Record<number, ItemPrice>>({});

  const { data, isLoading, error } = useGetPricingPage(token, {
    query: { queryKey: getGetPricingPageQueryKey(token), enabled: !!token },
  });

  const trackMutation = useTrackLinkOpen();
  const enterEditMode = () => {
    const existingOffer = (
      data as unknown as { existingOffer?: { items: SubmittedRow[]; generalNotes?: string | null } }
    ).existingOffer;
    if (data?.items) {
      const prefilled: Record<number, ItemPrice> = {};
      for (const item of data.items) {
        const ei = existingOffer?.items?.find((x) => x.rfqItemId === item.id);
        const sr = submittedRows.find((x) => x.rfqItemId === item.id);
        const price = ei?.price ?? sr?.price;
        const taxIncluded = ei?.taxIncluded ?? sr?.taxIncluded ?? false;
        const deliveryDays = ei?.deliveryDays ?? sr?.deliveryDays;
        const notes = ei?.notes ?? sr?.notes ?? "";
        prefilled[item.id] = {
          rfqItemId: item.id,
          price: price != null ? String(price) : "",
          taxIncluded,
          deliveryDays: deliveryDays != null ? String(deliveryDays) : "",
          notes,
        };
      }
      setPrices(prefilled);
      setGeneralNotes(existingOffer?.generalNotes ?? submittedGeneralNotes ?? "");
    }
    setSubmitted(false);
    setIsEditing(true);
  };

  const submitMutation = useSubmitOffer({
    mutation: {
      onSuccess: async () => {
        setIsEditing(false);
        setSubmitted(true);
        if (offerFiles.length > 0) {
          setUploading(true);
          const uploaded: Array<{ id: number; originalName: string; sizeLabel: string }> = [];
          for (const file of offerFiles) {
            try {
              const fd = new FormData();
              fd.append("file", file);
              const r = await fetch(`/api/pricing/${token}/offer-attachments`, {
                method: "POST",
                body: fd,
              });
              if (r.ok) {
                const d = await r.json();
                uploaded.push(d);
              }
            } catch {}
          }
          setUploadedOfferAtts(uploaded);
          setUploading(false);
        }
      },
    },
  });

  useEffect(() => {
    if (token && data) {
      trackMutation.mutate({ token });
    }
  }, [token, data?.rfqNo]);

  useEffect(() => {
    if (token && data && !rfqAttachmentsLoaded) {
      setRfqAttachmentsLoaded(true);
      fetch(`/api/pricing/${token}/rfq-attachments`)
        .then((r) => (r.ok ? r.json() : []))
        .then(setRfqAttachments)
        .catch(() => {});
    }
  }, [token, data]);

  useEffect(() => {
    if (data?.items) {
      const initial: Record<number, ItemPrice> = {};
      for (const item of data.items) {
        initial[item.id] = {
          rfqItemId: item.id,
          price: "",
          taxIncluded: false,
          deliveryDays: "",
          notes: "",
        };
      }
      setPrices(initial);
    }
  }, [data?.items?.length]);

  const updatePrice = (itemId: number, field: keyof ItemPrice, value: string | boolean) => {
    setPrices((prev) => ({
      ...prev,
      [itemId]: { ...prev[itemId], [field]: value },
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const pricedEntries = Object.values(prices).filter((p) => p.price.trim() !== "");
    const items = pricedEntries.map((p) => ({
      rfqItemId: p.rfqItemId,
      price: parseFloat(p.price) || 0,
      taxIncluded: p.taxIncluded,
      deliveryDays: p.deliveryDays ? parseInt(p.deliveryDays, 10) : undefined,
      notes: p.notes || undefined,
    }));
    if (items.length === 0) {
      alert("يرجى إدخال سعر بند واحد على الأقل");
      return;
    }
    const rows: SubmittedRow[] = pricedEntries.map((p) => {
      const rfqItem = data?.items.find((i) => i.id === p.rfqItemId);
      return {
        rfqItemId: p.rfqItemId,
        partNo: rfqItem?.partNo ?? null,
        description: rfqItem?.description ?? null,
        qty: rfqItem?.qty ?? null,
        uom: rfqItem?.uom ?? null,
        price: parseFloat(p.price) || 0,
        taxIncluded: p.taxIncluded,
        deliveryDays: p.deliveryDays ? parseInt(p.deliveryDays, 10) : null,
        notes: p.notes || null,
      };
    });
    setSubmittedRows(rows);
    setSubmittedGeneralNotes(generalNotes);
    submitMutation.mutate({ token, data: { items, generalNotes: generalNotes || undefined } });
  };

  /* ── Loading ──────────────────────────────────────────────────────────── */
  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center" dir="rtl">
        <div className="text-muted-foreground text-sm">جاري تحميل بيانات طلب العرض...</div>
      </div>
    );
  }

  /* ── Error ────────────────────────────────────────────────────────────── */
  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4" dir="rtl">
        <div className="text-center max-w-sm">
          <AlertTriangle size={40} className="mx-auto text-amber-500 mb-3" />
          <h2 className="text-lg font-bold text-foreground">الرابط غير صالح</h2>
          <p className="text-muted-foreground text-sm mt-2">
            هذا الرابط غير صالح أو انتهت صلاحيته. يرجى التواصل مع قرطبة للتوريدات للحصول على رابط
            جديد.
          </p>
        </div>
      </div>
    );
  }

  /* ── Expired ──────────────────────────────────────────────────────────── */
  if (data.isExpired) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4" dir="rtl">
        <div className="text-center max-w-sm">
          <Clock size={40} className="mx-auto text-muted-foreground mb-3" />
          <h2 className="text-lg font-bold text-foreground">انتهى وقت تقديم العروض</h2>
          <p className="text-muted-foreground text-sm mt-2">
            لقد انتهى تاريخ الإغلاق لطلب العرض <strong>{data.rfqNo}</strong>. لم يعد بالإمكان تقديم
            عروض جديدة.
          </p>
        </div>
      </div>
    );
  }

  /* ── Shared header component ──────────────────────────────────────────── */
  const PageHeader = () => (
    <div className="bg-[hsl(221,83%,20%)] text-white px-4 sm:px-6 py-4 sm:py-5 shadow-sm">
      <div className="max-w-5xl mx-auto flex items-start gap-3 sm:gap-4">
        <img
          src="/logo.png"
          alt="Cortoba Supplies"
          className="h-10 w-10 sm:h-14 sm:w-14 object-contain flex-shrink-0 rounded-md mt-0.5"
        />
        <div className="flex-1 min-w-0">
          <h1 className="text-base sm:text-lg font-bold">Cortoba Supplies</h1>
          <p className="text-white/70 text-xs sm:text-sm">قرطبة للتوريدات</p>
          <p className="text-white/40 text-[10px] sm:text-[11px] mt-0.5 leading-relaxed">
            ش.الاسكندرية - برج نجمة مطروح الدور الرابع - مرسي مطروح &nbsp;|&nbsp; ب-ض: 432-972-587
            &nbsp;|&nbsp; س-ت: 21618
          </p>
          <div className="mt-2 sm:mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs sm:text-sm">
            <span>
              رقم الطلب: <strong className="font-mono">{data.rfqNo}</strong>
            </span>
            <span>
              تاريخ الإغلاق: <strong>{data.closeDate}</strong>
            </span>
            <span>
              المورد: <strong>{data.supplierName}</strong>
            </span>
            {data.contactPerson && (
              <span>
                الشخص المسؤول: <strong>{data.contactPerson}</strong>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  /* ── Already Submitted (read-only view) ───────────────────────────────── */
  if ((submitted || data.alreadySubmitted) && !isEditing) {
    const displayRows: SubmittedRow[] =
      submittedRows.length > 0
        ? submittedRows
        : ((
            data as unknown as {
              existingOffer?: { items: SubmittedRow[]; generalNotes?: string | null };
            }
          ).existingOffer?.items ?? []);
    const displayGeneralNotes =
      submittedRows.length > 0
        ? submittedGeneralNotes
        : ((data as unknown as { existingOffer?: { generalNotes?: string | null } }).existingOffer
            ?.generalNotes ?? "");

    return (
      <div className="min-h-screen bg-background" dir="rtl">
        <PageHeader />

        <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-4 sm:space-y-5">
          {/* Success banner */}
          <div className="flex items-start gap-3 bg-green-50 border border-green-200 rounded-lg px-4 sm:px-5 py-3 sm:py-4">
            <CheckCircle2 size={20} className="text-green-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-green-800 text-sm">تم استلام عرض السعر بنجاح</p>
              <p className="text-green-700 text-xs mt-0.5">
                شكراً لكم. تم استلام عرض سعركم لطلب العرض <strong>{data.rfqNo}</strong>. سيتم
                التواصل معكم في حال الاختيار.
              </p>
            </div>
            {!data.isExpired && (
              <button
                onClick={enterEditMode}
                className="text-xs text-blue-700 border border-blue-300 bg-blue-50 hover:bg-blue-100 rounded px-2.5 sm:px-3 py-1.5 flex-shrink-0 font-medium whitespace-nowrap"
              >
                تعديل العرض
              </button>
            )}
          </div>

          {/* Uploaded offer attachments */}
          {uploadedOfferAtts.length > 0 && (
            <div className="bg-card border border-border rounded-lg p-4">
              <p className="text-sm font-semibold text-foreground mb-2">
                📎 الملفات المُرفقة مع عرضك
              </p>
              <ul className="space-y-1">
                {uploadedOfferAtts.map((a) => (
                  <li
                    key={a.id}
                    className="text-xs text-foreground flex items-center gap-2 bg-muted/30 rounded px-3 py-1.5"
                  >
                    <span className="flex-1 truncate">{a.originalName}</span>
                    <span className="text-muted-foreground">{a.sizeLabel}</span>
                    <span className="text-green-600 font-medium">✓ تم الرفع</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {uploading && (
            <div className="text-sm text-muted-foreground text-center py-2">
              جاري رفع المرفقات...
            </div>
          )}

          {/* Read-only submitted rows */}
          {displayRows.length > 0 && (
            <div className="bg-card border border-border rounded-lg overflow-hidden">
              <div className="px-4 sm:px-5 py-3 border-b border-border bg-muted/20">
                <p className="font-medium text-foreground text-sm">الأسعار المُرسلة</p>
              </div>

              {/* Desktop table — hidden on mobile */}
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-sm" style={{ direction: "rtl" }}>
                  <thead>
                    <tr className="bg-muted/30 border-b border-border text-right">
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium w-8">
                        #
                      </th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                        رقم القطعة
                      </th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                        الوصف
                      </th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                        الكمية
                      </th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                        الوحدة
                      </th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-left">
                        سعر الوحدة (جنيه)
                      </th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                        شامل الضريبة
                      </th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                        مدة التوريد
                      </th>
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                        ملاحظات
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map((row, i) => (
                      <tr key={row.rfqItemId} className="border-b border-border last:border-0">
                        <td className="px-4 py-3 text-muted-foreground text-xs text-center">
                          {i + 1}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                          {row.partNo ?? "-"}
                        </td>
                        <td className="px-4 py-3 text-foreground text-sm max-w-[200px]">
                          {row.description ?? "-"}
                        </td>
                        <td className="px-4 py-3 text-center text-xs text-foreground">
                          {row.qty ?? "-"}
                        </td>
                        <td className="px-4 py-3 text-center text-xs text-foreground">
                          {row.uom ?? "-"}
                        </td>
                        <td
                          className="px-4 py-3 text-left font-mono text-sm font-semibold text-foreground"
                          dir="ltr"
                        >
                          {row.price.toLocaleString("en-EG", { minimumFractionDigits: 2 })}
                        </td>
                        <td className="px-4 py-3 text-center text-xs">
                          {row.taxIncluded ? (
                            <span className="inline-flex items-center gap-0.5 text-green-700 bg-green-50 border border-green-200 rounded px-1.5 py-0.5">
                              <CheckCircle2 size={10} /> نعم
                            </span>
                          ) : (
                            <span className="text-muted-foreground">لا</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center text-xs text-foreground">
                          {row.deliveryDays != null ? `${row.deliveryDays} يوم` : "-"}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {row.notes ?? "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards — shown on mobile only */}
              <div className="sm:hidden divide-y divide-border">
                {displayRows.map((row, i) => (
                  <div key={row.rfqItemId} className="p-4 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs text-muted-foreground">#{i + 1}</span>
                      <span className="text-base font-bold font-mono text-foreground" dir="ltr">
                        {row.price.toLocaleString("en-EG", { minimumFractionDigits: 2 })} جنيه
                      </span>
                    </div>
                    {row.description && (
                      <p className="text-sm text-foreground font-medium">{row.description}</p>
                    )}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {row.partNo && (
                        <span>
                          رقم القطعة:{" "}
                          <span className="font-mono text-foreground">{row.partNo}</span>
                        </span>
                      )}
                      {row.qty != null && (
                        <span>
                          الكمية:{" "}
                          <span className="text-foreground">
                            {row.qty} {row.uom ?? ""}
                          </span>
                        </span>
                      )}
                      <span>
                        الضريبة:{" "}
                        {row.taxIncluded ? (
                          <span className="text-green-700 font-medium">شاملة</span>
                        ) : (
                          <span className="text-foreground">غير شاملة</span>
                        )}
                      </span>
                      {row.deliveryDays != null && (
                        <span>
                          مدة التوريد:{" "}
                          <span className="text-foreground">{row.deliveryDays} يوم</span>
                        </span>
                      )}
                    </div>
                    {row.notes && (
                      <p className="text-xs text-muted-foreground bg-muted/30 rounded px-2 py-1">
                        ملاحظة: {row.notes}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* General notes read-only */}
          {displayGeneralNotes && (
            <div className="bg-card border border-border rounded-lg p-4">
              <p className="text-sm font-medium text-foreground mb-1">ملاحظات عامة</p>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                {displayGeneralNotes}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ── Main form (first-time or edit mode) ─────────────────────────────── */
  return (
    <div className="min-h-screen bg-background" dir="rtl">
      <PageHeader />

      <div className="max-w-5xl mx-auto p-4 sm:p-6">
        <p className="text-muted-foreground text-sm mb-4 sm:mb-5">
          يرجى إدخال أفضل أسعاركم للبنود التي تستطيعون توريدها ثم إرسال العرض — يمكنكم تسعير بعض
          البنود فقط. هذا الرابط مخصص لشركتكم فقط — لا تشاركه مع أي جهة أخرى.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-5">
          {/* ── Desktop table (sm and above) ─────────────────────────────── */}
          <div className="hidden sm:block bg-card border border-border rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ direction: "rtl" }}>
                <thead>
                  <tr className="bg-muted/30 border-b border-border text-right">
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium w-8">#</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                      رقم القطعة
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">الوصف</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                      الكمية
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                      الوحدة
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                      سعر الوحدة (جنيه)
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                      شامل الضريبة
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                      مدة التوريد (أيام)
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                      ملاحظات
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item, i) => {
                    const row = prices[item.id] ?? {
                      price: "",
                      taxIncluded: false,
                      deliveryDays: "",
                      notes: "",
                    };
                    return (
                      <tr key={item.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-3 text-muted-foreground text-xs text-center">
                          {i + 1}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                          {item.partNo ?? "-"}
                        </td>
                        <td className="px-4 py-3 text-foreground text-sm max-w-[200px]">
                          {item.description}
                        </td>
                        <td className="px-4 py-3 text-center text-xs text-foreground">
                          {item.qty ?? "-"}
                        </td>
                        <td className="px-4 py-3 text-center text-xs text-foreground">
                          {item.uom ?? "-"}
                        </td>
                        <td className="px-4 py-3">
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            value={row.price}
                            onChange={(e) => updatePrice(item.id, "price", e.target.value)}
                            className="h-7 text-xs w-28 text-left"
                            placeholder="0.00"
                            dir="ltr"
                          />
                        </td>
                        <td className="px-4 py-3 text-center">
                          <input
                            type="checkbox"
                            checked={row.taxIncluded}
                            onChange={(e) => updatePrice(item.id, "taxIncluded", e.target.checked)}
                            className="w-4 h-4 accent-primary"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <Input
                            type="number"
                            min="0"
                            value={row.deliveryDays}
                            onChange={(e) => updatePrice(item.id, "deliveryDays", e.target.value)}
                            className="h-7 text-xs w-16 text-left"
                            placeholder="0"
                            dir="ltr"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <Input
                            value={row.notes}
                            onChange={(e) => updatePrice(item.id, "notes", e.target.value)}
                            className="h-7 text-xs w-32"
                            placeholder="اختياري"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Mobile cards (below sm) ──────────────────────────────────── */}
          <div className="sm:hidden space-y-3">
            {data.items.map((item, i) => {
              const row = prices[item.id] ?? {
                price: "",
                taxIncluded: false,
                deliveryDays: "",
                notes: "",
              };
              return (
                <div
                  key={item.id}
                  className="bg-card border border-border rounded-lg overflow-hidden"
                >
                  {/* Item header */}
                  <div className="bg-muted/30 border-b border-border px-4 py-2.5 flex items-start gap-2">
                    <span className="text-xs text-muted-foreground bg-muted rounded-full w-5 h-5 flex items-center justify-center flex-shrink-0 mt-0.5">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground leading-snug">
                        {item.description}
                      </p>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5 text-xs text-muted-foreground">
                        {item.partNo && (
                          <span>
                            رقم القطعة: <span className="font-mono">{item.partNo}</span>
                          </span>
                        )}
                        {item.qty != null && (
                          <span>
                            الكمية: {item.qty} {item.uom ?? ""}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Input fields */}
                  <div className="p-4 space-y-3">
                    {/* Price */}
                    <div>
                      <label className="block text-xs font-medium text-foreground mb-1">
                        سعر الوحدة (جنيه)
                      </label>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={row.price}
                        onChange={(e) => updatePrice(item.id, "price", e.target.value)}
                        className="h-10 text-sm text-left w-full"
                        placeholder="0.00"
                        dir="ltr"
                        inputMode="decimal"
                      />
                    </div>

                    {/* Delivery days + Tax — side by side */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-foreground mb-1">
                          مدة التوريد (أيام)
                        </label>
                        <Input
                          type="number"
                          min="0"
                          value={row.deliveryDays}
                          onChange={(e) => updatePrice(item.id, "deliveryDays", e.target.value)}
                          className="h-10 text-sm text-left w-full"
                          placeholder="0"
                          dir="ltr"
                          inputMode="numeric"
                        />
                      </div>
                      <div className="flex flex-col justify-end">
                        <label className="flex items-center gap-2.5 cursor-pointer select-none py-2 px-3 border border-border rounded-md h-10 bg-background">
                          <input
                            type="checkbox"
                            checked={row.taxIncluded}
                            onChange={(e) => updatePrice(item.id, "taxIncluded", e.target.checked)}
                            className="w-4 h-4 accent-primary flex-shrink-0"
                          />
                          <span className="text-sm text-foreground">شامل الضريبة</span>
                        </label>
                      </div>
                    </div>

                    {/* Notes */}
                    <div>
                      <label className="block text-xs font-medium text-foreground mb-1">
                        ملاحظات (اختياري)
                      </label>
                      <Input
                        value={row.notes}
                        onChange={(e) => updatePrice(item.id, "notes", e.target.value)}
                        className="h-10 text-sm w-full"
                        placeholder="أي ملاحظات على هذا البند"
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* General Notes */}
          <div className="bg-card border border-border rounded-lg p-4 space-y-2">
            <label className="text-sm font-medium text-foreground">ملاحظات عامة (اختياري)</label>
            <textarea
              value={generalNotes}
              onChange={(e) => setGeneralNotes(e.target.value)}
              className="w-full h-20 px-3 py-2 text-sm border border-input rounded bg-background text-foreground resize-none"
              placeholder="شروط الدفع، ظروف التسليم، مدة صلاحية العرض، إلخ."
            />
          </div>

          {/* RFQ Attachments (specs/drawings from buyer) */}
          {rfqAttachments.length > 0 && (
            <div className="bg-card border border-border rounded-lg p-4 space-y-3">
              <p className="text-sm font-semibold text-foreground flex items-center gap-2">
                📎 المرفقات الفنية من المشتري
              </p>
              <div className="divide-y divide-border border border-border rounded-lg overflow-hidden">
                {rfqAttachments.map((att) => (
                  <div
                    key={att.id}
                    className="flex items-center gap-3 px-4 py-2.5 bg-background hover:bg-muted/20"
                  >
                    <span className="text-sm flex-1 truncate">{att.originalName}</span>
                    <span className="text-xs text-muted-foreground hidden sm:inline">
                      {att.sizeLabel}
                    </span>
                    <a
                      href={att.downloadUrl}
                      download={att.originalName}
                      className="text-xs text-primary underline underline-offset-2 hover:no-underline whitespace-nowrap"
                    >
                      تحميل
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Offer Attachments (supplier uploads) */}
          <div className="bg-card border border-border rounded-lg p-4 space-y-2">
            <label className="text-sm font-medium text-foreground flex items-center gap-2">
              📎 إرفاق ملفات مع عرضك (اختياري)
            </label>
            <p className="text-xs text-muted-foreground">
              يمكنك إرفاق كتالوجات، شهادات، مواصفات فنية، أو أي وثائق ذات صلة
            </p>
            <input
              type="file"
              multiple
              accept=".pdf,.jpg,.jpeg,.png,.webp,.gif,.xlsx,.xls,.docx,.doc,.dwg,.dxf,.svg"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                setOfferFiles((prev) => [...prev, ...files].slice(0, 5));
                e.target.value = "";
              }}
              className="block w-full text-sm text-muted-foreground file:mr-3 file:py-1.5 file:px-3 file:rounded file:border file:border-border file:text-xs file:bg-muted file:text-foreground hover:file:bg-muted/70 cursor-pointer"
            />
            {offerFiles.length > 0 && (
              <ul className="space-y-1 mt-2">
                {offerFiles.map((f, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-2 text-xs text-foreground bg-muted/30 rounded px-3 py-1.5"
                  >
                    <span className="flex-1 truncate">{f.name}</span>
                    <span className="text-muted-foreground hidden sm:inline">
                      {(f.size / 1024).toFixed(0)} KB
                    </span>
                    <button
                      type="button"
                      onClick={() => setOfferFiles((prev) => prev.filter((_, j) => j !== i))}
                      className="text-destructive hover:text-destructive/80 font-medium"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {submitMutation.isError && (
            <div className="bg-destructive/10 border border-destructive/20 rounded p-3 text-sm text-destructive">
              حدث خطأ أثناء الإرسال. يرجى المحاولة مرة أخرى.
            </div>
          )}

          <div className="flex justify-start pb-6">
            <Button
              type="submit"
              disabled={submitMutation.isPending}
              className="w-full sm:w-auto px-8 h-11 sm:h-9 text-base sm:text-sm"
            >
              {submitMutation.isPending ? "جاري الإرسال..." : "إرسال عرض السعر"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
