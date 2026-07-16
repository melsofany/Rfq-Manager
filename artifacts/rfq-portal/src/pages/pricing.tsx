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
  const [generalNotes, setGeneralNotes] = useState("");
  const [prices, setPrices] = useState<Record<number, ItemPrice>>({});

  const { data, isLoading, error } = useGetPricingPage(token, {
    query: { queryKey: getGetPricingPageQueryKey(token), enabled: !!token },
  });

  const trackMutation = useTrackLinkOpen();
  const submitMutation = useSubmitOffer({
    mutation: {
      onSuccess: () => setSubmitted(true),
    },
  });

  useEffect(() => {
    if (token && data) {
      trackMutation.mutate({ token });
    }
  }, [token, data?.rfqNo]);

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
    // Only submit items where the supplier actually entered a price
    const items = Object.values(prices)
      .filter((p) => p.price.trim() !== "")
      .map((p) => ({
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
    submitMutation.mutate({ token, data: { items, generalNotes: generalNotes || undefined } });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center" dir="rtl">
        <div className="text-muted-foreground text-sm">جاري تحميل بيانات طلب العرض...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4" dir="rtl">
        <div className="text-center max-w-sm">
          <AlertTriangle size={40} className="mx-auto text-amber-500 mb-3" />
          <h2 className="text-lg font-bold text-foreground">الرابط غير صالح</h2>
          <p className="text-muted-foreground text-sm mt-2">
            هذا الرابط غير صالح أو انتهت صلاحيته. يرجى التواصل مع قرطبة للتوريدات للحصول على رابط جديد.
          </p>
        </div>
      </div>
    );
  }

  if (data.isExpired) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4" dir="rtl">
        <div className="text-center max-w-sm">
          <Clock size={40} className="mx-auto text-muted-foreground mb-3" />
          <h2 className="text-lg font-bold text-foreground">انتهى وقت تقديم العروض</h2>
          <p className="text-muted-foreground text-sm mt-2">
            لقد انتهى تاريخ الإغلاق لطلب العرض <strong>{data.rfqNo}</strong>. لم يعد بالإمكان تقديم عروض جديدة.
          </p>
        </div>
      </div>
    );
  }

  if (submitted || data.alreadySubmitted) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4" dir="rtl">
        <div className="text-center max-w-sm">
          <CheckCircle2 size={40} className="mx-auto text-green-500 mb-3" />
          <h2 className="text-lg font-bold text-foreground">تم استلام عرض السعر</h2>
          <p className="text-muted-foreground text-sm mt-2">
            شكراً لكم. تم استلام عرض سعركم لطلب العرض <strong>{data.rfqNo}</strong> بنجاح.
            سيتم التواصل معكم في حال الاختيار.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background" dir="rtl">
      {/* Header */}
      <div className="bg-[hsl(221,83%,20%)] text-white px-6 py-5 shadow-sm">
        <div className="max-w-5xl mx-auto flex items-center gap-4">
          <img src="/logo.png" alt="Cortoba Supplies" className="h-14 w-14 object-contain flex-shrink-0 rounded-md" />
          <div>
          <h1 className="text-lg font-bold">Cortoba Supplies</h1>
          <p className="text-white/70 text-sm">قرطبة للتوريدات</p>
          <p className="text-white/40 text-[11px] mt-0.5">
            ش.الاسكندرية - برج نجمة مطروح الدور الرابع - مرسي مطروح
            &nbsp;|&nbsp; ب-ض: 432-972-587 &nbsp;|&nbsp; س-ت: 21618
          </p>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
            <span>رقم الطلب: <strong className="font-mono">{data.rfqNo}</strong></span>
            <span>تاريخ الإغلاق: <strong>{data.closeDate}</strong></span>
            <span>المورد: <strong>{data.supplierName}</strong></span>
            {data.contactPerson && <span>الشخص المسؤول: <strong>{data.contactPerson}</strong></span>}
          </div>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto p-6">
        <p className="text-muted-foreground text-sm mb-5">
          يرجى إدخال أفضل أسعاركم للبنود التي تستطيعون توريدها ثم إرسال العرض — يمكنكم تسعير بعض البنود فقط.
          هذا الرابط مخصص لشركتكم فقط — لا تشاركه مع أي جهة أخرى.
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Items Table */}
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ direction: "rtl" }}>
                <thead>
                  <tr className="bg-muted/30 border-b border-border text-right">
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium w-8">#</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">رقم القطعة</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">الوصف</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">الكمية</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">الوحدة</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">سعر الوحدة (جنيه)</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">شامل الضريبة</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">مدة التوريد (أيام)</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">ملاحظات</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item, i) => {
                    const row = prices[item.id] ?? { price: "", taxIncluded: false, deliveryDays: "", notes: "" };
                    return (
                      <tr key={item.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-3 text-muted-foreground text-xs text-center">{i + 1}</td>
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{item.partNo ?? "-"}</td>
                        <td className="px-4 py-3 text-foreground text-sm max-w-[200px]">{item.description}</td>
                        <td className="px-4 py-3 text-center text-xs text-foreground">{item.qty ?? "-"}</td>
                        <td className="px-4 py-3 text-center text-xs text-foreground">{item.uom ?? "-"}</td>
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

          {submitMutation.isError && (
            <div className="bg-destructive/10 border border-destructive/20 rounded p-3 text-sm text-destructive">
              حدث خطأ أثناء الإرسال. يرجى المحاولة مرة أخرى.
            </div>
          )}

          <div className="flex justify-start">
            <Button type="submit" disabled={submitMutation.isPending} className="px-8">
              {submitMutation.isPending ? "جاري الإرسال..." : "إرسال عرض السعر"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
