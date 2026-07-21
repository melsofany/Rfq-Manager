import { useState, useMemo } from "react";
import { useParams, Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
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
  AlertCircle,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

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

export default function SupplierDetailPage() {
  const { id } = useParams<{ id: string }>();
  const supplierId = parseInt(id, 10);
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { employee } = useAuth();

  // Only admin and manager can delete
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

  // Merge API categories with any categories stored on the supplier that are not in supplier_categories
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
      <div className="p-4 sm:p-6 max-w-3xl space-y-5">
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

        {/* Delete error — always visible when not editing */}
        {!editing && serverError && (
          <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3">
            <AlertCircle size={14} />
            <span>{serverError}</span>
          </div>
        )}

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
              {score && (
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
                <ScoreBar label="Response Rate" value={score.responseRateScore ?? 0} />
                <ScoreBar label="Price Competitiveness" value={score.priceScore ?? 0} />
                <ScoreBar label="On-Time Delivery" value={score.onTimeScore ?? 0} />
                <ScoreBar label="Quality" value={score.qualityScore ?? 0} />
                <div className="pt-2 border-t border-border grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <p className="text-muted-foreground">RFQs Received</p>
                    <p className="font-medium text-foreground">{score.totalRfqsReceived}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Offers Submitted</p>
                    <p className="font-medium text-foreground">{score.totalOffersSubmitted}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Response Rate</p>
                    <p className="font-medium text-foreground">{score.responseRate}%</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-muted-foreground text-xs">No score data yet</div>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}
