import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateSupplier,
  getListSuppliersQueryKey,
  useListCategories,
  getListCategoriesQueryKey,
} from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, AlertCircle } from "lucide-react";

export default function NewSupplierPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const { data: categories = [] } = useListCategories({
    query: { queryKey: getListCategoriesQueryKey() },
  });

  const [form, setForm] = useState({
    supplierId: "",
    name: "",
    contactPerson: "",
    email: "",
    phone: "",
    address: "",
  });
  const [selectedCats, setSelectedCats] = useState<Set<string>>(new Set());
  const [serverError, setServerError] = useState<string | null>(null);

  const createMutation = useCreateSupplier({
    mutation: {
      onSuccess: (supplier) => {
        queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
        navigate(`/suppliers/${supplier.id}`);
      },
      onError: (err: unknown) => {
        const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
        setServerError(msg ?? "حدث خطأ أثناء الحفظ");
      },
    },
  });

  const update = (field: string, value: string) => setForm((prev) => ({ ...prev, [field]: value }));

  const toggleCat = (name: string) => {
    setSelectedCats((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);
    if (selectedCats.size === 0) {
      setServerError("يجب اختيار تصنيف واحد على الأقل");
      return;
    }
    const category = Array.from(selectedCats).join(",");
    createMutation.mutate({
      data: { ...form, category } as Parameters<typeof createMutation.mutate>[0]["data"],
    });
  };

  return (
    <Layout>
      <div className="p-4 sm:p-6 max-w-2xl space-y-5">
        <div className="flex items-center gap-3">
          <Link href="/suppliers">
            <a className="text-muted-foreground hover:text-foreground"><ArrowLeft size={18} /></a>
          </Link>
          <div>
            <h1 className="text-xl font-bold text-foreground">Add Supplier</h1>
            <p className="text-muted-foreground text-sm">Register a new supplier in the system</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="bg-card border border-border rounded-lg p-6 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Supplier ID</Label>
              <Input value={form.supplierId} onChange={(e) => update("supplierId", e.target.value)} placeholder="SUP-001" />
            </div>
            <div className="space-y-1.5">
              <Label>Company Name *</Label>
              <Input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="Al-Noor Electric Co." required />
            </div>
            <div className="space-y-1.5">
              <Label>Contact Person</Label>
              <Input value={form.contactPerson} onChange={(e) => update("contactPerson", e.target.value)} placeholder="John Smith" />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input value={form.email} onChange={(e) => update("email", e.target.value)} type="email" placeholder="contact@supplier.com" />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={form.phone} onChange={(e) => update("phone", e.target.value)} placeholder="+966-12-345-6789" />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label>Address</Label>
              <Input value={form.address} onChange={(e) => update("address", e.target.value)} placeholder="Riyadh, KSA" />
            </div>
          </div>

          {/* Multi-category checkboxes */}
          <div className="space-y-2">
            <Label>
              Categories *{" "}
              <span className="text-muted-foreground font-normal text-xs">(يمكن اختيار أكثر من تصنيف)</span>
            </Label>
            {categories.length === 0 ? (
              <p className="text-xs text-muted-foreground">No categories available. Add categories first.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {categories.map((c) => {
                  const active = selectedCats.has(c.name);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleCat(c.name)}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors capitalize ${
                        active
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-muted text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
                      }`}
                    >
                      {c.name}
                    </button>
                  );
                })}
              </div>
            )}
            {selectedCats.size > 0 && (
              <p className="text-xs text-muted-foreground">
                Selected: {Array.from(selectedCats).join(", ")}
              </p>
            )}
          </div>

          {serverError && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
              <AlertCircle size={14} />
              <span>{serverError}</span>
            </div>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <Link href="/suppliers">
              <a className="inline-flex items-center px-4 py-2 text-sm rounded border border-border text-muted-foreground hover:text-foreground">
                Cancel
              </a>
            </Link>
            <Button type="submit" disabled={createMutation.isPending || !form.name}>
              {createMutation.isPending ? "Saving..." : "Add Supplier"}
            </Button>
          </div>
        </form>
      </div>
    </Layout>
  );
}
