import { useState } from "react";
import { Link, useParams, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getListPurchaseOrdersQueryKey,
  useListSuppliers,
  getListSuppliersQueryKey,
} from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import {
  ArrowLeft,
  Download,
  Loader2,
  Send,
  CheckCircle2,
  XCircle,
  Mail,
  MessageCircle,
  Link2,
  Link2Off,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import {
  SupplierCombobox,
  RepresentativeNameInput,
  useRepresentatives,
  fetchSupplierPrice,
  RfqCombobox,
  useRfqOptions,
  type RfqOption,
  type PoItemRow,
} from "../components/fields";

interface PoDetail {
  id: number;
  internalPoNo: string;
  sheetPoNo: string;
  receiverName: string | null;
  receiverPhone: string | null;
  status: string;
  employeeId: number | null;
  employeeName: string | null;
  rfqId: number | null;
  linkedRfq: { id: number; internalRfqNo: string; status: string } | null;
  notes: string | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

interface PoItem {
  id: number;
  poId: number;
  supplierId: number | null;
  supplierName: string | null;
  itemId: string | null;
  customerPoItemId: number | null;
  lineItem: string | null;
  partNo: string | null;
  description: string;
  uom: string | null;
  qty: number | null;
  referencePrice: number | null;
  taxIncluded: boolean;
}

interface EmployeeOption {
  id: number;
  name: string;
  email: string;
  role: string;
  phone: string | null;
  isActive: boolean;
}

interface DispatchResult {
  supplierId: number;
  supplierName: string;
  emailSent: boolean;
  emailError: string | null;
  whatsappSent: boolean;
  whatsappError: string | null;
}

interface DispatchResponse {
  poNo: string;
  results: DispatchResult[];
}

function usePoDetail(id: number) {
  return useQuery<PoDetail>({
    queryKey: ["po", id],
    queryFn: async () => {
      const res = await fetch(`/api/po/${id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch PO");
      return res.json();
    },
    enabled: !isNaN(id),
  });
}

function usePoItems(id: number) {
  return useQuery<PoItem[]>({
    queryKey: ["po-items", id],
    queryFn: async () => {
      const res = await fetch(`/api/po/${id}/items`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch PO items");
      return res.json();
    },
    enabled: !isNaN(id),
  });
}

function useEmployees() {
  return useQuery<EmployeeOption[]>({
    queryKey: ["employees"],
    queryFn: async () => {
      const res = await fetch("/api/employees", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch employees");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}

// Group items by supplier
function groupBySupplier(
  items: PoItem[],
): Map<string, { supplierId: number | null; supplierName: string | null; items: PoItem[] }> {
  const map = new Map<
    string,
    { supplierId: number | null; supplierName: string | null; items: PoItem[] }
  >();
  for (const item of items) {
    const key = item.supplierId != null ? `supplier-${item.supplierId}` : "no-supplier";
    if (!map.has(key)) {
      map.set(key, { supplierId: item.supplierId, supplierName: item.supplierName, items: [] });
    }
    map.get(key)!.items.push(item);
  }
  return map;
}

function fmt(v: number | null | undefined): string {
  if (v == null) return "—";
  return String(v);
}

export default function PurchaseOrderDetailPage() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id ?? "", 10);
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  const { data: po, isLoading: poLoading } = usePoDetail(id);
  const { data: items, isLoading: itemsLoading } = usePoItems(id);
  const { data: rfqOptions } = useRfqOptions();

  const [dispatching, setDispatching] = useState(false);
  const [dispatchResult, setDispatchResult] = useState<DispatchResponse | null>(null);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [downloadingPdf, setDownloadingPdf] = useState<number | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const [showLinkPanel, setShowLinkPanel] = useState(false);
  const [selectedRfqId, setSelectedRfqId] = useState<string>("");
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  // ── Edit mode (draft only) ───────────────────────────────────────────────
  const { data: representativesData } = useRepresentatives();
  const representatives = representativesData ?? [];
  const { data: employees } = useEmployees();
  const { data: suppliers } = useListSuppliers(
    {},
    { query: { queryKey: getListSuppliersQueryKey({}) } },
  );
  const activeSuppliers = (suppliers ?? []).filter((s) => s.isActive);

  const [editMode, setEditMode] = useState(false);
  const [editItems, setEditItems] = useState<PoItemRow[]>([]);
  const [editSheetPoNo, setEditSheetPoNo] = useState("");
  const [editReceiverName, setEditReceiverName] = useState("");
  const [editReceiverPhone, setEditReceiverPhone] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editEmployeeId, setEditEmployeeId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [priceLoadingIds, setPriceLoadingIds] = useState<Set<string>>(new Set());

  const isDraft = po?.status === "draft";

  const startEdit = () => {
    if (!po) return;
    setEditSheetPoNo(po.sheetPoNo ?? "");
    setEditReceiverName(po.receiverName ?? "");
    setEditReceiverPhone(po.receiverPhone ?? "");
    setEditNotes(po.notes ?? "");
    setEditEmployeeId(po.employeeId != null ? String(po.employeeId) : "");
    setEditItems(
      (items ?? []).map((it, idx) => ({
        id: `item-${it.id}-${idx}`,
        itemId: it.itemId,
        customerPoItemId: it.customerPoItemId ?? null,
        lineItem: it.lineItem,
        partNo: it.partNo,
        description: it.description,
        uom: it.uom,
        qty: it.qty != null ? String(it.qty) : "",
        unitPrice: it.referencePrice != null ? String(it.referencePrice) : "",
        supplierId: it.supplierId != null ? String(it.supplierId) : "",
        taxIncluded: it.taxIncluded ?? false,
      })),
    );
    setSaveError(null);
    setEditMode(true);
  };

  const cancelEdit = () => {
    setEditMode(false);
    setSaveError(null);
    setPriceLoadingIds(new Set());
  };

  const addEditItem = () => {
    const nid = `new-${Date.now()}`;
    setEditItems((prev) => [
      ...prev,
      {
        id: nid,
        itemId: null,
        customerPoItemId: null,
        lineItem: null,
        partNo: "",
        description: "",
        uom: "",
        qty: "",
        unitPrice: "",
        supplierId: "",
        taxIncluded: false,
      },
    ]);
  };

  const removeEditItem = (rowId: string) =>
    setEditItems((prev) => prev.filter((i) => i.id !== rowId));

  const updateEditField = <K extends keyof PoItemRow>(rowId: string, key: K, value: PoItemRow[K]) =>
    setEditItems((prev) => prev.map((i) => (i.id === rowId ? { ...i, [key]: value } : i)));

  const updateEditSupplier = (rowId: string, supplierId: string) => {
    setEditItems((prev) => prev.map((i) => (i.id === rowId ? { ...i, supplierId } : i)));
    if (supplierId) {
      const item = editItems.find((i) => i.id === rowId);
      if (item && item.description) {
        setPriceLoadingIds((prev) => new Set([...prev, rowId]));
        fetchSupplierPrice(parseInt(supplierId, 10), item.description, item.partNo)
          .then((price) => {
            setEditItems((prev) =>
              prev.map((i) =>
                i.id === rowId ? { ...i, unitPrice: price != null ? String(price) : "" } : i,
              ),
            );
          })
          .finally(() => {
            setPriceLoadingIds((prev) => {
              const next = new Set(prev);
              next.delete(rowId);
              return next;
            });
          });
      }
    }
  };

  const handleSave = async () => {
    const validItems = editItems.filter((i) => i.description.trim());
    if (!editSheetPoNo.trim()) {
      setSaveError("رقم أمر الشراء (Sheet PO) مطلوب");
      return;
    }
    if (validItems.length === 0) {
      setSaveError("يجب وجود صنف واحد على الأقل");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/po/${id}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sheetPoNo: editSheetPoNo.trim(),
          receiverName: editReceiverName || null,
          receiverPhone: editReceiverPhone || null,
          notes: editNotes || null,
          employeeId: editEmployeeId ? parseInt(editEmployeeId, 10) : null,
          items: validItems.map((i) => ({
            itemId: i.itemId || null,
            customerPoItemId: i.customerPoItemId ?? null,
            lineItem: i.lineItem || null,
            partNo: i.partNo || null,
            description: i.description.trim(),
            uom: i.uom || null,
            qty: i.qty ? parseFloat(i.qty) : null,
            referencePrice: i.unitPrice ? parseFloat(i.unitPrice) : null,
            supplierId: i.supplierId ? parseInt(i.supplierId, 10) : null,
            taxIncluded: i.taxIncluded,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSaveError(data.error ?? "فشل حفظ التعديلات");
      } else {
        await queryClient.invalidateQueries({ queryKey: ["po", id] });
        await queryClient.invalidateQueries({ queryKey: ["po-items", id] });
        await queryClient.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
        setEditMode(false);
      }
    } catch {
      setSaveError("خطأ في الشبكة — تعذّر الوصول للخادم");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!po) return;
    const confirmed = window.confirm(
      `هل أنت متأكد من حذف أمر الشراء "${po.internalPoNo}"؟\nسيتم حذف جميع البنود المرتبطة به. لا يمكن التراجع عن هذا الإجراء.`,
    );
    if (!confirmed) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/po/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleteError(data.error ?? "فشل حذف أمر الشراء");
      } else {
        await queryClient.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
        await queryClient.removeQueries({ queryKey: ["po", id] });
        navigate("/purchase-orders");
      }
    } catch {
      setDeleteError("خطأ في الشبكة — تعذّر الوصول للخادم");
    } finally {
      setDeleting(false);
    }
  };

  // Live totals for the editable items table
  const editGrandTotal = editItems.reduce((sum, i) => {
    const qty = parseFloat(i.qty) || 0;
    const price = parseFloat(i.unitPrice) || 0;
    return sum + qty * price;
  }, 0);
  const editVatTotal = editItems.reduce((sum, i) => {
    if (!i.taxIncluded) return sum;
    const qty = parseFloat(i.qty) || 0;
    const price = parseFloat(i.unitPrice) || 0;
    const lineTotal = qty * price;
    return sum + (lineTotal - lineTotal / 1.14);
  }, 0);
  const editPreTaxTotal = editGrandTotal - editVatTotal;
  const editHasAnyPrice = editItems.some((i) => parseFloat(i.unitPrice) > 0);
  const editHasTaxItems = editItems.some((i) => i.taxIncluded && parseFloat(i.unitPrice) > 0);

  const grouped = items
    ? groupBySupplier(items)
    : new Map<
        string,
        { supplierId: number | null; supplierName: string | null; items: PoItem[] }
      >();
  const suppliersWithId = [...grouped.values()].filter((g) => g.supplierId != null);

  const handleDispatch = async () => {
    setDispatching(true);
    setDispatchResult(null);
    setDispatchError(null);
    try {
      const res = await fetch(`/api/po/${id}/dispatch`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) {
        setDispatchError(data.error ?? "Dispatch failed");
      } else {
        setDispatchResult(data as DispatchResponse);
        queryClient.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
        queryClient.invalidateQueries({ queryKey: ["po", id] });
      }
    } catch {
      setDispatchError("Network error — could not reach the server.");
    } finally {
      setDispatching(false);
    }
  };

  const handleLinkRfq = async () => {
    const rfqId = selectedRfqId ? parseInt(selectedRfqId, 10) : null;
    setLinking(true);
    setLinkError(null);
    try {
      const res = await fetch(`/api/po/${id}/link-rfq`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rfqId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLinkError(data.error ?? "فشل الربط");
      } else {
        queryClient.invalidateQueries({ queryKey: ["po", id] });
        queryClient.invalidateQueries({ queryKey: ["rfq"] });
        queryClient.invalidateQueries({ queryKey: ["rfq-options-for-po"] });
        setShowLinkPanel(false);
        setSelectedRfqId("");
      }
    } catch {
      setLinkError("خطأ في الشبكة");
    } finally {
      setLinking(false);
    }
  };

  const downloadPdf = async (supplierId: number, supplierName: string) => {
    setDownloadingPdf(supplierId);
    setPdfError(null);
    try {
      const res = await fetch(`/api/po/${id}/pdf/${supplierId}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `PO-${po?.internalPoNo ?? id}-${supplierName}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setPdfError("فشل تحميل PDF — يرجى المحاولة مرة أخرى.");
    } finally {
      setDownloadingPdf(null);
    }
  };

  if (poLoading || itemsLoading) {
    return (
      <Layout>
        <div className="p-8 flex items-center justify-center text-muted-foreground text-sm gap-2">
          <Loader2 size={16} className="animate-spin" /> Loading...
        </div>
      </Layout>
    );
  }

  if (!po) {
    return (
      <Layout>
        <div className="p-8 text-center text-muted-foreground text-sm">
          Purchase order not found.
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="p-4 sm:p-6 max-w-5xl space-y-5">
        {/* Back + title */}
        <div className="flex items-center gap-3">
          <Link href="/purchase-orders">
            <a className="text-muted-foreground hover:text-foreground">
              <ArrowLeft size={18} />
            </a>
          </Link>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-foreground font-mono">{po.internalPoNo}</h1>
              <StatusBadge status={po.status} />
            </div>
            <p className="text-muted-foreground text-sm">
              Sheet PO: {po.sheetPoNo} · {new Date(po.createdAt).toLocaleDateString()}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {isDraft && !editMode && (
              <Button
                variant="outline"
                onClick={startEdit}
                className="gap-2"
                title="تعديل أمر الشراء"
              >
                <Pencil size={15} /> تعديل
              </Button>
            )}
            {isDraft && !editMode && (
              <Button
                variant="outline"
                onClick={handleDelete}
                disabled={deleting}
                className="gap-2 text-destructive hover:text-destructive border-destructive/40 hover:border-destructive/70"
                title="حذف أمر الشراء"
              >
                {deleting ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                {deleting ? "حذف..." : "حذف"}
              </Button>
            )}
            {editMode && (
              <>
                <Button
                  variant="outline"
                  onClick={cancelEdit}
                  disabled={saving}
                  className="gap-2"
                >
                  <X size={15} /> إلغاء
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={saving}
                  className="gap-2"
                >
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                  {saving ? "حفظ..." : "حفظ التعديلات"}
                </Button>
              </>
            )}
            {!editMode && (
              <Button
                onClick={handleDispatch}
                disabled={dispatching || suppliersWithId.length === 0}
                className="gap-2"
              >
                {dispatching ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                {dispatching ? "إرسال..." : "إرسال للموردين"}
              </Button>
            )}
          </div>
        </div>

        {deleteError && (
          <div className="text-destructive text-sm bg-destructive/10 border border-destructive/30 rounded px-3 py-2">
            {deleteError}
          </div>
        )}

        {/* PO meta — read view */}
        {!editMode && (
          <div className="bg-card border border-border rounded-lg p-4 grid sm:grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">المسؤول</p>
              <p className="font-medium">{po.employeeName ?? "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">المستلم</p>
              <p className="font-medium">
                {po.receiverName ?? "—"}
                {po.receiverPhone && (
                  <span className="text-muted-foreground ml-1">· {po.receiverPhone}</span>
                )}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">ملاحظات</p>
              <p className="font-medium">{po.notes ?? "—"}</p>
            </div>
          </div>
        )}

        {/* PO meta — edit view (draft only) */}
        {editMode && (
          <div className="bg-card border border-border rounded-lg p-4 space-y-4 text-sm">
            {saveError && (
              <div className="text-destructive text-sm bg-destructive/10 border border-destructive/30 rounded px-3 py-2">
                {saveError}
              </div>
            )}
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">رقم أمر الشراء (Sheet PO)</Label>
                <Input
                  value={editSheetPoNo}
                  onChange={(e) => setEditSheetPoNo(e.target.value)}
                  placeholder="PO-XXXX"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">المسؤول / المندوب</Label>
                <select
                  value={editEmployeeId}
                  onChange={(e) => setEditEmployeeId(e.target.value)}
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                >
                  <option value="">— غير محدد —</option>
                  {(employees ?? [])
                    .filter((emp) => emp.isActive)
                    .map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">اسم المستلم</Label>
                <RepresentativeNameInput
                  value={editReceiverName}
                  onChange={setEditReceiverName}
                  onSelect={(rep) => {
                    setEditReceiverName(rep.name);
                    if (rep.phone) setEditReceiverPhone(rep.phone);
                  }}
                  representatives={representatives}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">هاتف المستلم</Label>
                <Input
                  value={editReceiverPhone}
                  onChange={(e) => setEditReceiverPhone(e.target.value)}
                  placeholder="01xxxxxxxxx"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">ملاحظات</Label>
              <textarea
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                rows={2}
                placeholder="ملاحظات إضافية..."
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              />
            </div>
          </div>
        )}

        {/* RFQ Link section */}
        <div className="bg-card border border-border rounded-lg p-4 text-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">طلب التسعير المرتبط</p>
              {po.linkedRfq ? (
                <div className="flex items-center gap-2">
                  <Link href={`/rfq/${po.linkedRfq.id}`}>
                    <a className="font-medium text-primary hover:underline font-mono">
                      {po.linkedRfq.internalRfqNo}
                    </a>
                  </Link>
                  <StatusBadge status={po.linkedRfq.status} />
                </div>
              ) : (
                <p className="text-muted-foreground italic">غير مرتبط بطلب تسعير</p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 flex-shrink-0"
              onClick={() => {
                setShowLinkPanel(!showLinkPanel);
                setLinkError(null);
                setSelectedRfqId(po.linkedRfq ? String(po.linkedRfq.id) : "");
              }}
            >
              {po.linkedRfq ? <Link2Off size={14} /> : <Link2 size={14} />}
              {po.linkedRfq ? "تغيير الربط" : "ربط بطلب تسعير"}
            </Button>
          </div>

          {showLinkPanel && (
            <div className="mt-4 pt-4 border-t border-border space-y-3">
              <p className="text-xs text-muted-foreground">
                اكتب للبحث عن طلب التسعير واختره من القائمة — سيتحول الطلب تلقائياً إلى حالة{" "}
                <strong>SUCCESS</strong>. يمكن ربط نفس طلب التسعير بأكثر من أمر شراء.
              </p>
              <div className="flex gap-2 items-center">
                <RfqCombobox
                  value={selectedRfqId}
                  onChange={setSelectedRfqId}
                  rfqs={rfqOptions ?? []}
                  disabled={linking}
                />
                <Button
                  size="sm"
                  disabled={!selectedRfqId || linking}
                  onClick={handleLinkRfq}
                  className="gap-1"
                >
                  {linking ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
                  ربط
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowLinkPanel(false)}>
                  إلغاء
                </Button>
              </div>
              {linkError && <p className="text-xs text-red-600">{linkError}</p>}
            </div>
          )}
        </div>

        {/* PDF download error */}
        {pdfError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {pdfError}
          </div>
        )}

        {/* Dispatch result */}
        {dispatchError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {dispatchError}
          </div>
        )}
        {dispatchResult && (
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border bg-muted/20 text-xs font-medium text-muted-foreground">
              نتيجة الإرسال — {po.internalPoNo}
            </div>
            <div className="divide-y divide-border">
              {dispatchResult.results.map((r) => (
                <div key={r.supplierId} className="px-4 py-3 flex items-center gap-4 text-sm">
                  <span className="font-medium flex-1">{r.supplierName}</span>
                  <span className="flex items-center gap-1 text-xs">
                    <Mail size={12} />
                    {r.emailSent ? (
                      <CheckCircle2 size={14} className="text-green-600" />
                    ) : (
                      <XCircle size={14} className="text-red-500" />
                    )}
                    <span className={r.emailSent ? "text-green-700" : "text-red-600"}>
                      {r.emailSent ? "تم الإيميل" : (r.emailError ?? "لا يوجد إيميل")}
                    </span>
                  </span>
                  <span className="flex items-center gap-1 text-xs">
                    <MessageCircle size={12} />
                    {r.whatsappSent ? (
                      <CheckCircle2 size={14} className="text-green-600" />
                    ) : (
                      <XCircle size={14} className="text-red-500" />
                    )}
                    <span className={r.whatsappSent ? "text-green-700" : "text-red-600"}>
                      {r.whatsappSent ? "تم واتساب" : (r.whatsappError ?? "لا يوجد هاتف")}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Items — read view (grouped by supplier) */}
        {!editMode &&
          [...grouped.entries()].map(([key, group]) => (
            <div key={key} className="bg-card border border-border rounded-lg overflow-hidden">
              <div className="px-4 py-2.5 border-b border-border bg-muted/20 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">
                    {group.supplierName ?? (
                      <span className="text-muted-foreground italic">لم يتم تحديد المورد</span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    ({group.items.length} صنف{group.items.length !== 1 ? "" : ""})
                  </span>
                </div>
                {group.supplierId != null && (
                  <button
                    type="button"
                    disabled={downloadingPdf === group.supplierId}
                    onClick={() => downloadPdf(group.supplierId!, group.supplierName ?? "Supplier")}
                    className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="تحميل PDF لهذا المورد"
                  >
                    {downloadingPdf === group.supplierId ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Download size={13} />
                    )}
                    {downloadingPdf === group.supplierId ? "جاري التحميل..." : "PDF"}
                  </button>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left bg-muted/10">
                      <th className="px-3 py-2 text-muted-foreground font-medium">#</th>
                      <th className="px-3 py-2 text-muted-foreground font-medium">رقم القطعة</th>
                      <th className="px-3 py-2 text-muted-foreground font-medium">الوصف</th>
                      <th className="px-3 py-2 text-muted-foreground font-medium text-center">
                        الكمية
                      </th>
                      <th className="px-3 py-2 text-muted-foreground font-medium text-center">
                        الوحدة
                      </th>
                      <th className="px-3 py-2 text-muted-foreground font-medium text-right">
                        سعر الوحدة
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map((item, idx) => (
                      <tr
                        key={item.id}
                        className="border-b border-border last:border-0 hover:bg-muted/10"
                      >
                        <td className="px-3 py-2 text-muted-foreground">
                          {item.lineItem ?? idx + 1}
                        </td>
                        <td className="px-3 py-2">{item.partNo ?? "—"}</td>
                        <td className="px-3 py-2 max-w-[260px]">{item.description}</td>
                        <td className="px-3 py-2 text-center font-medium">{fmt(item.qty)}</td>
                        <td className="px-3 py-2 text-center">{item.uom ?? "—"}</td>
                        <td className="px-3 py-2 text-right font-medium">
                          {fmt(item.referencePrice)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

        {!editMode && (!items || items.length === 0) && (
          <div className="bg-card border border-border rounded-lg p-8 text-center text-muted-foreground text-sm">
            لا توجد أصناف في أمر الشراء هذا.
          </div>
        )}

        {/* Items — editable table (draft / edit mode) */}
        {editMode && (
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border bg-muted/20 flex items-center justify-between">
              <span className="text-sm font-semibold text-foreground">بنود أمر الشراء</span>
              <Button variant="outline" size="sm" onClick={addEditItem} className="gap-1 h-8">
                <Plus size={14} /> إضافة صنف
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left bg-muted/10">
                    <th className="px-2 py-2 text-muted-foreground font-medium w-8">#</th>
                    <th className="px-2 py-2 text-muted-foreground font-medium min-w-[140px]">
                      المورد
                    </th>
                    <th className="px-2 py-2 text-muted-foreground font-medium min-w-[120px]">
                      رقم القطعة
                    </th>
                    <th className="px-2 py-2 text-muted-foreground font-medium min-w-[220px]">
                      الوصف
                    </th>
                    <th className="px-2 py-2 text-muted-foreground font-medium text-center w-20">
                      الكمية
                    </th>
                    <th className="px-2 py-2 text-muted-foreground font-medium text-center w-16">
                      الوحدة
                    </th>
                    <th className="px-2 py-2 text-muted-foreground font-medium text-right w-24">
                      سعر الوحدة
                    </th>
                    <th className="px-2 py-2 text-muted-foreground font-medium text-center w-16">
                      ضريبة
                    </th>
                    <th className="px-2 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {editItems.map((item, idx) => (
                    <tr key={item.id} className="border-b border-border last:border-0 align-top">
                      <td className="px-2 py-2 text-muted-foreground">{idx + 1}</td>
                      <td className="px-2 py-2">
                        <SupplierCombobox
                          value={item.supplierId}
                          onChange={(sid) => updateEditSupplier(item.id, sid)}
                          suppliers={activeSuppliers}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="text"
                          value={item.partNo ?? ""}
                          onChange={(e) => updateEditField(item.id, "partNo", e.target.value)}
                          className="h-7 w-full text-xs rounded border border-border bg-background px-1.5 outline-none focus:ring-1 focus:ring-ring"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="text"
                          value={item.description}
                          onChange={(e) => updateEditField(item.id, "description", e.target.value)}
                          className="h-7 w-full text-xs rounded border border-border bg-background px-1.5 outline-none focus:ring-1 focus:ring-ring"
                        />
                      </td>
                      <td className="px-2 py-2 text-center">
                        <input
                          type="number"
                          step="any"
                          value={item.qty}
                          onChange={(e) => updateEditField(item.id, "qty", e.target.value)}
                          className="h-7 w-16 text-xs rounded border border-border bg-background px-1.5 text-center outline-none focus:ring-1 focus:ring-ring"
                        />
                      </td>
                      <td className="px-2 py-2 text-center">
                        <input
                          type="text"
                          value={item.uom ?? ""}
                          onChange={(e) => updateEditField(item.id, "uom", e.target.value)}
                          className="h-7 w-14 text-xs rounded border border-border bg-background px-1.5 text-center outline-none focus:ring-1 focus:ring-ring"
                        />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {priceLoadingIds.has(item.id) ? (
                            <Loader2 size={12} className="animate-spin text-muted-foreground" />
                          ) : null}
                          <input
                            type="number"
                            step="any"
                            value={item.unitPrice}
                            onChange={(e) =>
                              updateEditField(item.id, "unitPrice", e.target.value)
                            }
                            className="h-7 w-20 text-xs rounded border border-border bg-background px-1.5 text-right outline-none focus:ring-1 focus:ring-ring"
                          />
                        </div>
                      </td>
                      <td className="px-2 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={item.taxIncluded}
                          onChange={(e) =>
                            updateEditField(item.id, "taxIncluded", e.target.checked)
                          }
                          className="h-4 w-4"
                        />
                      </td>
                      <td className="px-2 py-2 text-center">
                        <button
                          type="button"
                          onClick={() => removeEditItem(item.id)}
                          className="text-destructive hover:text-destructive/80 p-1"
                          title="حذف الصنف"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {editItems.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                        لا توجد أصناف — اضغط «إضافة صنف».
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {editHasAnyPrice && (
              <div className="px-4 py-2.5 border-t border-border bg-muted/10 flex flex-wrap justify-end gap-x-6 gap-y-1 text-xs">
                <span className="text-muted-foreground">
                  الإجمالي قبل الضريبة:{" "}
                  <span className="font-medium text-foreground">
                    {editPreTaxTotal.toFixed(2)}
                  </span>
                </span>
                {editHasTaxItems && (
                  <span className="text-muted-foreground">
                    ض.ق.م:{" "}
                    <span className="font-medium text-foreground">
                      {editVatTotal.toFixed(2)}
                    </span>
                  </span>
                )}
                <span className="text-muted-foreground">
                  الإجمالي:{" "}
                  <span className="font-medium text-foreground">
                    {editGrandTotal.toFixed(2)}
                  </span>
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
}
