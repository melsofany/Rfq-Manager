import { useState } from "react";
import { useParams, useLocation, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetRfq,
  useListSuppliers,
  useListCategories,
  useSendRfqToSuppliers,
  getGetRfqQueryKey,
  getListSuppliersQueryKey,
  getGetRfqSentLogQueryKey,
  getListCategoriesQueryKey,
} from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ArrowLeft,
  Send,
  CheckSquare,
  Square,
  Search,
  CheckCircle2,
  XCircle,
  MinusCircle,
  MessageCircle,
  Mail,
} from "lucide-react";

function parseCategories(cat: string | null | undefined): string[] {
  if (!cat) return [];
  return cat
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

type SendResult = {
  supplierId: number;
  supplierName: string;
  status: string;
  reason: string | null;
  email?: { status: string; error?: string | null };
  whatsapp?: { status: string; error?: string | null };
};

export default function SendRfqPage() {
  const { id } = useParams<{ id: string }>();
  const rfqId = parseInt(id, 10);
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [closeDate, setCloseDate] = useState("");
  const [sendResults, setSendResults] = useState<SendResult[] | null>(null);

  const { data: dbCategories = [] } = useListCategories({
    query: { queryKey: getListCategoriesQueryKey() },
  });
  const CATEGORIES = ["all", ...dbCategories.map((c) => c.name)];

  const { data: rfq } = useGetRfq(rfqId, {
    query: { queryKey: getGetRfqQueryKey(rfqId), enabled: !!rfqId },
  });
  const { data: suppliers } = useListSuppliers(
    { category: category !== "all" ? category : undefined, search: search || undefined },
    {
      query: {
        queryKey: getListSuppliersQueryKey({
          category: category !== "all" ? category : undefined,
          search: search || undefined,
        }),
      },
    },
  );

  const sendMutation = useSendRfqToSuppliers({
    mutation: {
      onSuccess: (data: { details?: SendResult[]; sent?: number } | unknown) => {
        queryClient.invalidateQueries({ queryKey: getGetRfqSentLogQueryKey(rfqId) });
        queryClient.invalidateQueries({ queryKey: getGetRfqQueryKey(rfqId) });
        const details = (data as { details?: SendResult[] })?.details;
        if (details?.length) {
          setSendResults(details);
        } else {
          navigate(`/rfq/${rfqId}`);
        }
      },
    },
  });

  const toggleSupplier = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (!suppliers) return;
    const allActive = suppliers.filter((s) => s.isActive);
    if (selectedIds.size === allActive.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allActive.map((s) => s.id)));
    }
  };

  const handleSend = () => {
    if (!selectedIds.size) return;
    sendMutation.mutate({
      id: rfqId,
      data: { supplierIds: Array.from(selectedIds), closeDate: closeDate || undefined },
    });
  };

  const activeSuppliers = suppliers?.filter((s) => s.isActive) ?? [];
  const allSelected = activeSuppliers.length > 0 && selectedIds.size === activeSuppliers.length;

  // ── Results view ──────────────────────────────────────────────────────────
  if (sendResults) {
    const waFailed = sendResults.filter((r) => r.whatsapp?.status === "failed");
    const waOk = sendResults.filter((r) => r.whatsapp?.status === "sent");
    const noPhone = sendResults.filter((r) => r.whatsapp?.status === "no_phone");

    return (
      <Layout>
        <div className="p-4 sm:p-6 max-w-3xl space-y-5">
          <div className="flex items-center gap-3">
            <Link href={`/rfq/${rfqId}`}>
              <a className="text-muted-foreground hover:text-foreground">
                <ArrowLeft size={18} />
              </a>
            </Link>
            <h1 className="text-xl font-bold text-foreground">نتيجة الإرسال</h1>
          </div>

          {/* Summary */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-green-700">{waOk.length}</p>
              <p className="text-xs text-green-600 mt-0.5">واتساب أُرسل ✓</p>
            </div>
            <div
              className={`border rounded-lg p-3 text-center ${waFailed.length ? "bg-red-50 border-red-200" : "bg-muted/30 border-border"}`}
            >
              <p
                className={`text-2xl font-bold ${waFailed.length ? "text-red-700" : "text-muted-foreground"}`}
              >
                {waFailed.length}
              </p>
              <p
                className={`text-xs mt-0.5 ${waFailed.length ? "text-red-600" : "text-muted-foreground"}`}
              >
                واتساب فشل ✗
              </p>
            </div>
            <div className="bg-muted/30 border border-border rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-muted-foreground">{noPhone.length}</p>
              <p className="text-xs text-muted-foreground mt-0.5">بدون رقم هاتف</p>
            </div>
          </div>

          {/* Per-supplier detail */}
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border bg-muted/20">
              <p className="text-sm font-medium text-foreground">تفاصيل كل مورد</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-right">
                    <th className="px-4 py-2 text-muted-foreground text-xs font-medium">المورد</th>
                    <th className="px-4 py-2 text-muted-foreground text-xs font-medium text-center">
                      <span className="flex items-center justify-center gap-1">
                        <MessageCircle size={12} /> واتساب
                      </span>
                    </th>
                    <th className="px-4 py-2 text-muted-foreground text-xs font-medium text-center">
                      <span className="flex items-center justify-center gap-1">
                        <Mail size={12} /> إيميل
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sendResults.map((r) => (
                    <tr key={r.supplierId} className="border-b border-border last:border-0">
                      <td className="px-4 py-3 font-medium text-foreground">{r.supplierName}</td>
                      <td className="px-4 py-3 text-center">
                        {r.whatsapp?.status === "sent" && (
                          <span className="inline-flex items-center gap-1 text-green-600 text-xs">
                            <CheckCircle2 size={13} /> أُرسل
                          </span>
                        )}
                        {r.whatsapp?.status === "failed" && (
                          <div>
                            <span className="inline-flex items-center gap-1 text-red-600 text-xs">
                              <XCircle size={13} /> فشل
                            </span>
                            {r.whatsapp.error && (
                              <p className="text-[10px] text-red-500 mt-0.5 max-w-xs break-all">
                                {r.whatsapp.error}
                              </p>
                            )}
                          </div>
                        )}
                        {r.whatsapp?.status === "no_phone" && (
                          <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
                            <MinusCircle size={13} /> بدون رقم
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {r.email?.status === "sent" && (
                          <span className="inline-flex items-center gap-1 text-green-600 text-xs">
                            <CheckCircle2 size={13} /> أُرسل
                          </span>
                        )}
                        {r.email?.status === "failed" && (
                          <span className="inline-flex items-center gap-1 text-red-600 text-xs">
                            <XCircle size={13} /> فشل
                          </span>
                        )}
                        {r.email?.status === "no_email" && (
                          <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
                            <MinusCircle size={13} /> بدون إيميل
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={() => navigate(`/rfq/${rfqId}`)}>
              <ArrowLeft size={14} className="ml-1" /> العودة لطلب التسعير
            </Button>
          </div>
        </div>
      </Layout>
    );
  }

  // ── Send form ─────────────────────────────────────────────────────────────
  return (
    <Layout>
      <div className="p-4 sm:p-6 max-w-4xl space-y-5">
        <div className="flex items-center gap-3">
          <Link href={`/rfq/${rfqId}`}>
            <a className="text-muted-foreground hover:text-foreground">
              <ArrowLeft size={18} />
            </a>
          </Link>
          <div>
            <h1 className="text-xl font-bold text-foreground">Send RFQ to Suppliers</h1>
            {rfq && <p className="text-muted-foreground text-sm font-mono">{rfq.internalRfqNo}</p>}
          </div>
        </div>

        <div className="bg-card border border-border rounded-lg p-5">
          <div className="flex items-end gap-4">
            <div className="space-y-1.5">
              <Label>Close Date (optional)</Label>
              <Input
                type="date"
                value={closeDate}
                onChange={(e) => setCloseDate(e.target.value)}
                className="w-48"
                min={new Date().toISOString().split("T")[0]}
              />
            </div>
            <p className="text-muted-foreground text-xs pb-2">
              Suppliers won't be able to submit after this date.
            </p>
          </div>
        </div>

        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className={`px-2.5 py-1 rounded text-xs font-medium capitalize transition-colors ${
                    category === c
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search
                size={13}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="pl-8 h-7 text-xs w-40"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/30 border-b border-border text-left">
                  <th className="px-4 py-2.5 w-10">
                    <button onClick={toggleAll}>
                      {allSelected ? (
                        <CheckSquare size={16} className="text-primary" />
                      ) : (
                        <Square size={16} className="text-muted-foreground" />
                      )}
                    </button>
                  </th>
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                    Supplier
                  </th>
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Contact</th>
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Email</th>
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                    Categories
                  </th>
                </tr>
              </thead>
              <tbody>
                {!activeSuppliers.length ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground text-sm">
                      No active suppliers found
                    </td>
                  </tr>
                ) : (
                  activeSuppliers.map((s) => {
                    const cats = parseCategories(s.category);
                    return (
                      <tr
                        key={s.id}
                        className={`border-b border-border last:border-0 cursor-pointer transition-colors ${
                          selectedIds.has(s.id) ? "bg-primary/5" : "hover:bg-muted/20"
                        }`}
                        onClick={() => toggleSupplier(s.id)}
                      >
                        <td className="px-4 py-3">
                          {selectedIds.has(s.id) ? (
                            <CheckSquare size={16} className="text-primary" />
                          ) : (
                            <Square size={16} className="text-muted-foreground" />
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-foreground">{s.name}</p>
                          {s.supplierId && (
                            <p className="text-muted-foreground text-xs font-mono">
                              {s.supplierId}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">
                          {s.contactPerson ?? "-"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">
                          {s.email ?? <span className="text-amber-500">No email</span>}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {cats.map((cat) => (
                              <span
                                key={cat}
                                className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground capitalize"
                              >
                                {cat}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {selectedIds.size} supplier{selectedIds.size !== 1 ? "s" : ""} selected
          </p>
          <div className="flex flex-col-reverse sm:flex-row gap-3 sm:self-end">
            <Link href={`/rfq/${rfqId}`}>
              <a className="inline-flex items-center px-4 py-2 text-sm rounded border border-border text-muted-foreground hover:text-foreground">
                Cancel
              </a>
            </Link>
            <Button
              onClick={handleSend}
              disabled={!selectedIds.size || sendMutation.isPending}
              className="gap-1.5"
            >
              <Send size={14} />
              {sendMutation.isPending
                ? "جاري الإرسال..."
                : `إرسال لـ ${selectedIds.size} مورد${selectedIds.size !== 1 ? "ين" : ""}`}
            </Button>
          </div>
        </div>

        {sendMutation.isError && (
          <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
            حدث خطأ أثناء الإرسال. يرجى المحاولة مجدداً.
          </div>
        )}
      </div>
    </Layout>
  );
}
