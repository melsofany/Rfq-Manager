import { useState, useMemo } from "react";
import { useParams, Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useGetSupplier,
  useGetSupplierScore,
  useUpdateSupplier,
  getGetSupplierQueryKey,
  getGetSupplierScoreQueryKey,
  getListSuppliersQueryKey,
  useListCategories,
  getListCategoriesQueryKey,
} from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ArrowLeft,
  Mail,
  Phone,
  MapPin,
  Pencil,
  Trash2,
  X,
  Check,
  CheckCircle,
  AlertCircle,
  FileText,
  ShoppingCart,
  ChevronRight,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

// ── Helpers ──────────────────────────────────────────────────────────────────

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-xs font-medium text-foreground">{value}</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${value >= 70 ? "bg-green-500" : value >= 50 ? "bg-amber-500" : "bg-red-500"}`}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}

function parseCategories(cat: string | null | undefined): string[] {
  if (!cat) return [];
  return cat
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const RFQ_STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  SENT: "bg-blue-50 text-blue-700",
  QUOTED: "bg-purple-50 text-purple-700",
  SUCCESS: "bg-green-50 text-green-700",
  FAILED: "bg-red-50 text-red-600",
};

const PO_STATUS_STYLES: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  sent: "bg-blue-50 text-blue-700",
  confirmed: "bg-green-50 text-green-700",
};

const PO_PROGRESS_TONES: Record<string, string> = {
  received: "bg-emerald-50 text-emerald-700",
  partial: "bg-amber-50 text-amber-700",
  default: "",
};

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ar-EG", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface SupplierRfq {
  id: number;
  internalRfqNo: string;
  customerRfqNo: string;
  status: string;
  sentAt: string | null;
  hasOffer: boolean;
  createdAt: string;
}

interface SupplierPo {
  id: number;
  internalPoNo: string;
  sheetPoNo: string;
  status: string;
  progressStatus?: string;
  progressStatusLabel?: string;
  progressTone?: 'default' | 'received' | 'partial';
  itemCount: number;
  receipt: { total: number; received: number; rejected: number } | null;
  createdAt: string;
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function SupplierDetailPage() {
  const { id } = useParams<{ id: string }>();
  const supplierId = parseInt(id, 10);
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { employee } = useAuth();

  const canDelete = employee?.role === "admin" || employee?.role === "manager";

  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [form, setForm] = useState<Record<string, string | boolean>>({});
  const [selectedCats, setSelectedCats] = useState<Set<string>>(new Set());
  const [serverError, setServerError] = useState<string | null>(null);

  const { data: categories = [] } = useListCategories({
    query: { queryKey: getListCategoriesQueryKey() },
  });

  const { data: supplier, isLoading } = useGetSupplier(supplierId, {
    query: { queryKey: getGetSupplierQueryKey(supplierId), enabled: !!supplierId },
  });
  const { data: score } = useGetSupplierScore(supplierId, {
    query: { queryKey: getGetSupplierScoreQueryKey(supplierId), enabled: !!supplierId },
  });

  // ── Supplier RFQs ──────────────────────────────────────────────────────────
  const { data: supplierRfqs = [], isLoading: rfqsLoading } = useQuery<SupplierRfq[]>({
    queryKey: ["supplier-rfqs", supplierId],
    queryFn: async () => {
      const res = await fetch(`/api/suppliers/${supplierId}/rfqs`);
      if (!res.ok) throw new Error("Failed to fetch supplier RFQs");
      return res.json() as Promise<SupplierRfq[]>;
    },
    enabled: !!supplierId,
    staleTime: 30_000,
  });

  // ── Supplier POs ───────────────────────────────────────────────────────────
  const { data: supplierPos = [], isLoading: posLoading } = useQuery<SupplierPo[]>({
    queryKey: ["supplier-pos", supplierId],
    queryFn: async () => {
      const res = await fetch(`/api/suppliers/${supplierId}/pos`);
      if (!res.ok) throw new Error("Failed to fetch supplier POs");
      return res.json() as Promise<SupplierPo[]>;
    },
    enabled: !!supplierId,
    staleTime: 30_000,
  });

  // ── Categories merge ───────────────────────────────────────────────────────
  const mergedCategories = useMemo(() => {
    const base = [...categories];
    const existingNames = new Set(base.map((c) => c.name));
    for (const catName of parseCategories(supplier?.category)) {
      if (!existingNames.has(catName)) {
        base.push({ id: -(existingNames.size + 1), name: catName });
        existingNames.add(catName);
      }
    }
    return base.sort((a, b) => a.name.localeCompare(b.name));
  }, [categories, supplier?.category]);

  const updateMutation = useUpdateSupplier({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSupplierQueryKey(supplierId) });
        queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
        setEditing(false);
        setServerError(null);
      },
      onError: (err: unknown) => {
        const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
        setServerError(msg ?? "حدث خطأ أثناء الحفظ");
      },
    },
  });

  const startEdit = () => {
    if (!supplier) return;
    setForm({
      name: supplier.name,
      contactPerson: supplier.contactPerson ?? "",
      email: supplier.email ?? "",
      phone: supplier.phone ?? "",
      address: supplier.address ?? "",
      isActive: supplier.isActive ?? false,
    });
    setSelectedCats(new Set(parseCategories(supplier.category)));
    setServerError(null);
    setEditing(true);
  };

  const saveEdit = () => {
    if (selectedCats.size === 0) {
      setServerError("يجب اختيار تصنيف واحد على الأقل");
      return;
    }
    setServerError(null);
    const category = Array.from(selectedCats).join(",");
    updateMutation.mutate({
      id: supplierId,
      data: { ...form, category } as Parameters<typeof updateMutation.mutate>[0]["data"],
    });
  };

  const toggleCat = (name: string) => {
    setSelectedCats((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const response = await fetch(`/api/suppliers/${supplierId}`, { method: "DELETE" });
      if (!response.ok) {
        let msg = `فشل الحذف (${response.status})`;
        try {
          const body = await response.json();
          if (body?.error) msg = body.error;
        } catch {
          /* ignore */
        }
        setServerError(msg);
        setConfirmDelete(false);
        return;
      }
      queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
      navigate("/suppliers");
    } catch {
      setServerError("حدث خطأ في الاتصال بالخادم");
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  const upd = (field: string, value: string | boolean) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  if (isLoading) {
    return (
      <Layout>
        <div className="p-4 sm:p-6 text-muted-foreground text-sm">Loading...</div>
      </Layout>
    );
  }
  if (!supplier) {
    return (
      <Layout>
        <div className="p-4 sm:p-6 text-muted-foreground text-sm">Supplier not found.</div>
      </Layout>
    );
  }

  const supplierCategories = parseCategories(supplier.category);

  return (
    <Layout>
      <div className="p-4 sm:p-6 max-w-4xl space-y-5">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link href="/suppliers">
              <a className="text-muted-foreground hover:text-foreground">
                <ArrowLeft size={18} />
              </a>
            </Link>
            <div>
              <h1 className="text-xl font-bold text-foreground">{supplier.name}</h1>
              <p className="text-muted-foreground text-xs font-mono">{supplier.supplierId}</p>
            </div>
          </div>
          {!editing && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={startEdit}>
                <Pencil size={13} /> Edit
              </Button>
              {canDelete && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-destructive hover:bg-destructive/10 border-destructive/30"
                  onClick={() => {
                    setConfirmDelete(true);
                    setServerError(null);
                  }}
                >
                  <Trash2 size={13} /> Delete
                </Button>
              )}
            </div>
          )}
          {editing && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  setEditing(false);
                  setServerError(null);
                }}
              >
                <X size={13} /> Cancel
              </Button>
              <Button
                size="sm"
                className="gap-1.5"
                onClick={saveEdit}
                disabled={updateMutation.isPending}
              >
                <Check size={13} /> {updateMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          )}
        </div>

        {/* Delete confirmation */}
        {confirmDelete && canDelete && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 flex items-center justify-between gap-4">
            <p className="text-sm text-destructive font-medium">
              Delete <strong>{supplier.name}</strong>? This action cannot be undone.
            </p>
            <div className="flex gap-2 shrink-0">
              <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="destructive" disabled={deleting} onClick={handleDelete}>
                {deleting ? "Deleting..." : "Yes, Delete"}
              </Button>
            </div>
          </div>
        )}

        {/* Delete error */}
        {!editing && serverError && (
          <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3">
            <AlertCircle size={14} />
            <span>{serverError}</span>
          </div>
        )}

        {/* Info + Scorecard */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Info / Edit Form */}
          <div className="bg-card border border-border rounded-lg p-5 space-y-4">
            <h2 className="font-semibold text-sm text-foreground">Contact Information</h2>

            {editing ? (
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label>Company Name *</Label>
                  <Input
                    value={String(form.name ?? "")}
                    onChange={(e) => upd("name", e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label>Contact Person</Label>
                  <Input
                    value={String(form.contactPerson ?? "")}
                    onChange={(e) => upd("contactPerson", e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Email</Label>
                  <Input
                    type="email"
                    value={String(form.email ?? "")}
                    onChange={(e) => upd("email", e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Phone</Label>
                  <Input
                    value={String(form.phone ?? "")}
                    onChange={(e) => upd("phone", e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Address</Label>
                  <Input
                    value={String(form.address ?? "")}
                    onChange={(e) => upd("address", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>
                    Categories *{" "}
                    <span className="text-muted-foreground font-normal text-xs">
                      (يمكن اختيار أكثر من تصنيف)
                    </span>
                  </Label>
                  <div className="flex flex-wrap gap-2">
                    {mergedCategories.map((c) => {
                      const active = selectedCats.has(c.name);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => toggleCat(c.name)}
                          className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors capitalize ${
                            active
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-muted text-muted-foreground border-border hover:border-primary/50"
                          }`}
                        >
                          {c.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="isActive"
                    checked={Boolean(form.isActive)}
                    onChange={(e) => upd("isActive", e.target.checked)}
                    className="w-4 h-4 accent-primary"
                  />
                  <Label htmlFor="isActive">Active supplier</Label>
                </div>
                {serverError && (
                  <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
                    <AlertCircle size={12} />
                    <span>{serverError}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3 text-sm">
                {supplier.contactPerson && (
                  <div>
                    <p className="text-muted-foreground text-xs">Contact Person</p>
                    <p className="text-foreground font-medium">{supplier.contactPerson}</p>
                  </div>
                )}
                {supplier.email && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Mail size={13} />
                    <a href={`mailto:${supplier.email}`} className="hover:text-primary text-xs">
                      {supplier.email}
                    </a>
                  </div>
                )}
                {supplier.phone && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Phone size={13} />
                    <span className="text-xs">{supplier.phone}</span>
                  </div>
                )}
                {supplier.address && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <MapPin size={13} />
                    <span className="text-xs">{supplier.address}</span>
                  </div>
                )}
                <div>
                  <p className="text-muted-foreground text-xs mb-1">Categories</p>
                  <div className="flex flex-wrap gap-1">
                    {supplierCategories.length > 0 ? (
                      supplierCategories.map((cat) => (
                        <span
                          key={cat}
                          className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground capitalize"
                        >
                          {cat}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Status</p>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium mt-0.5 ${
                      supplier.isActive
                        ? "bg-green-50 text-green-700"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {supplier.isActive ? "Active" : "Inactive"}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Scorecard */}
          <div className="bg-card border border-border rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm text-foreground">Supplier Scorecard</h2>
              {score && score.totalScore !== null && score.totalScore !== undefined && (
                <div
                  className={`text-2xl font-bold ${
                    score.totalScore >= 70
                      ? "text-green-600"
                      : score.totalScore >= 50
                        ? "text-amber-600"
                        : "text-red-600"
                  }`}
                >
                  {score.totalScore}
                </div>
              )}
            </div>
            {score ? (
              <div className="space-y-3">
                {([
                  { label: "Response Rate", value: score.commitmentScore },
                  { label: "Response Speed", value: score.responseSpeedScore },
                  { label: "Price Competitiveness", value: score.priceScore },
                  { label: "Win Rate", value: score.winScore },
                  { label: "Receipt Quality", value: score.receiptQualityScore },
                  { label: "Delivery Time", value: score.deliveryScore },
                ].map((m) =>
                  m.value !== null && m.value !== undefined ? (
                    <ScoreBar key={m.label} label={m.label} value={m.value ?? 0} />
                  ) : null,
                ))}
                <div className="pt-2 border-t border-border grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <p className="text-muted-foreground">RFQs Received</p>
                    <p className="font-medium text-foreground">{score.totalRfqsReceived ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Offered Items</p>
                    <p className="font-medium text-foreground">{score.totalItemsOffered ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Response Rate</p>
                    <p className="font-medium text-foreground">
                      {score.responseRate !== null && score.responseRate !== undefined
                        ? `${score.responseRate}%`
                        : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Win Rate</p>
                    <p className="font-medium text-foreground">
                      {score.wins ?? 0}/{score.totalItemsOffered ?? 0} items
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Accepted / Rejected</p>
                    <p className="font-medium text-foreground">
                      {typeof score.acceptedQty === "number" || typeof score.rejectedQty === "number"
                        ? `${score.acceptedQty ?? 0} / ${score.rejectedQty ?? 0}`
                        : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Avg. delivery</p>
                    <p className="font-medium text-foreground">
                      {score.avgDeliveryDays !== null && score.avgDeliveryDays !== undefined
                        ? `${score.avgDeliveryDays} days`
                        : "—"}
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-muted-foreground text-xs">No score data yet</div>
            )}
          </div>
        </div>

        {/* ── طلبات التسعير ──────────────────────────────────────────────────── */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-muted/20">
            <div className="flex items-center gap-2">
              <FileText size={15} className="text-muted-foreground" />
              <h2 className="font-semibold text-sm text-foreground">طلبات التسعير المرسلة</h2>
              {supplierRfqs.length > 0 && (
                <span className="bg-primary/10 text-primary text-xs font-medium px-1.5 py-0.5 rounded">
                  {supplierRfqs.length}
                </span>
              )}
            </div>
            <Link href="/rfq">
              <a className="text-xs text-muted-foreground hover:text-primary flex items-center gap-0.5">
                كل الطلبات <ChevronRight size={13} />
              </a>
            </Link>
          </div>

          {rfqsLoading ? (
            <div className="p-6 text-center text-muted-foreground text-sm">Loading...</div>
          ) : supplierRfqs.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              لم يُرسل لهذا المورد أي طلب تسعير بعد
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-right">
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-right">
                      رقم الطلب
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-right">
                      رقم العميل
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                      الحالة
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                      الاستلام
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                      عرض سعر؟
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-right">
                      تاريخ الإرسال
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {supplierRfqs.map((rfq) => (
                    <tr
                      key={rfq.id}
                      className="border-b border-border last:border-0 hover:bg-muted/20 cursor-pointer"
                      onClick={() => navigate(`/rfq/${rfq.id}`)}
                    >
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs font-medium text-foreground">
                          {rfq.internalRfqNo}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {rfq.customerRfqNo}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${RFQ_STATUS_STYLES[rfq.status] ?? "bg-muted text-muted-foreground"}`}
                        >
                          {rfq.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {rfq.hasOffer ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-50 text-green-700">
                            ✓ نعم
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {fmtDate(rfq.sentAt ?? rfq.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── أوامر الشراء ───────────────────────────────────────────────────── */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-muted/20">
            <div className="flex items-center gap-2">
              <ShoppingCart size={15} className="text-muted-foreground" />
              <h2 className="font-semibold text-sm text-foreground">أوامر الشراء</h2>
              {supplierPos.length > 0 && (
                <span className="bg-primary/10 text-primary text-xs font-medium px-1.5 py-0.5 rounded">
                  {supplierPos.length}
                </span>
              )}
            </div>
            <Link href="/purchase-orders">
              <a className="text-xs text-muted-foreground hover:text-primary flex items-center gap-0.5">
                كل الأوامر <ChevronRight size={13} />
              </a>
            </Link>
          </div>

          {posLoading ? (
            <div className="p-6 text-center text-muted-foreground text-sm">Loading...</div>
          ) : supplierPos.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              لا توجد أوامر شراء مرتبطة بهذا المورد
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-right">
                      رقم أمر الشراء
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-right">
                      رقم PO (العميل)
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                      الحالة
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                      الاستلام
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                      عدد البنود
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-right">
                      تاريخ الإنشاء
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {supplierPos.map((po) => (
                    <tr
                      key={po.id}
                      className="border-b border-border last:border-0 hover:bg-muted/20 cursor-pointer"
                      onClick={() => navigate(`/purchase-orders/${po.id}`)}
                    >
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs font-medium text-foreground">
                          {po.internalPoNo}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{po.sheetPoNo}</td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${(PO_PROGRESS_TONES[po.progressTone ?? 'default'] || PO_STATUS_STYLES[po.progressStatus ?? po.status]) ?? "bg-muted text-muted-foreground"}`}
                        >
                          {po.progressStatusLabel ?? po.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center text-xs font-medium">
                        {po.receipt == null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span
                            className={`inline-flex items-center gap-1 ${po.receipt.rejected > 0 ? "text-amber-700" : po.receipt.total > 0 && po.receipt.received === po.receipt.total ? "text-emerald-700" : "text-foreground"}`}
                            title={`المستلم ${po.receipt.received} من ${po.receipt.total}${po.receipt.rejected > 0 ? ` (+ ${po.receipt.rejected} مرفوض)` : ""}`}
                          >
                            {po.receipt.total > 0 && po.receipt.received === po.receipt.total ? (
                              <CheckCircle className="h-3.5 w-3.5" />
                            ) : null}
                            {po.receipt.received}/{po.receipt.total}
                            {po.receipt.rejected > 0 ? (
                              <span className="text-amber-600">+{po.receipt.rejected}</span>
                            ) : null}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center text-xs text-foreground font-medium">
                        {po.itemCount}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {fmtDate(po.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
