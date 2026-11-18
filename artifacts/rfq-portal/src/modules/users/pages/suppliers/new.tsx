import { leafCategoryIds, orderCategoryTree } from "@/lib/category-tree";
import { useMemo, useState } from "react";
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
import { BankCombobox } from "@/components/BankCombobox";
import { ArrowLeft, AlertCircle, Landmark, FileText } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

export default function NewSupplierPage() {
  const { t } = useLanguage();
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
    commercialRegister: "",
    taxRegistration: "",
    bankName: "",
    bankAccountHolder: "",
    bankAccountNumber: "",
    iban: "",
    swiftCode: "",
    bankBranch: "",
  });
  const [invoiceHasVat, setInvoiceHasVat] = useState(true);
  const [selectedCats, setSelectedCats] = useState<Set<string>>(new Set());
  const [serverError, setServerError] = useState<string | null>(null);
  // Categories that may hold a supplier (a grouping category may not).
  const leaves = useMemo(() => leafCategoryIds(categories), [categories]);

  const createMutation = useCreateSupplier({
    mutation: {
      onSuccess: (supplier) => {
        queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
        navigate(`/suppliers/${supplier.id}`);
      },
      onError: (err: unknown) => {
        const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
        setServerError(msg ?? t("supNew.saveError"));
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
      setServerError(t("supNew.needCategory"));
      return;
    }
    const category = Array.from(selectedCats).join(",");
    createMutation.mutate({
      data: { ...form, category, invoiceHasVat } as Parameters<
        typeof createMutation.mutate
      >[0]["data"],
    });
  };

  return (
    <Layout>
      <div className="p-4 sm:p-6 max-w-2xl space-y-5">
        <div className="flex items-center gap-3">
          <Link href="/suppliers">
            <a className="text-muted-foreground hover:text-foreground">
              <ArrowLeft size={18} />
            </a>
          </Link>
          <div>
            <h1 className="text-xl font-bold text-foreground">{t("supNew.title")}</h1>
            <p className="text-muted-foreground text-sm">{t("supNew.subtitle")}</p>
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-card border border-border rounded-lg p-6 space-y-5"
        >
          <div className="space-y-1.5 col-span-2">
            <Label>{t("supNew.vatQuestion")}</Label>
            <div className="flex gap-4 pt-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="invoiceHasVat"
                  checked={invoiceHasVat === true}
                  onChange={() => setInvoiceHasVat(true)}
                  className="accent-primary"
                />
                {t("supNew.vatYes")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="invoiceHasVat"
                  checked={invoiceHasVat === false}
                  onChange={() => setInvoiceHasVat(false)}
                  className="accent-primary"
                />
                {t("supNew.vatNo")}
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>{t("supF.supplierId")}</Label>
              <Input
                value={form.supplierId}
                onChange={(e) => update("supplierId", e.target.value)}
                placeholder="SUP-001"
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("supF.companyName")} *</Label>
              <Input
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
                placeholder="Al-Noor Electric Co."
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("supF.contactPerson")}</Label>
              <Input
                value={form.contactPerson}
                onChange={(e) => update("contactPerson", e.target.value)}
                placeholder="John Smith"
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("supF.email")}</Label>
              <Input
                value={form.email}
                onChange={(e) => update("email", e.target.value)}
                type="email"
                placeholder="contact@supplier.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("supF.phone")}</Label>
              <Input
                value={form.phone}
                onChange={(e) => update("phone", e.target.value)}
                placeholder="+966-12-345-6789"
              />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label>{t("supF.address")}</Label>
              <Input
                value={form.address}
                onChange={(e) => update("address", e.target.value)}
                placeholder="Riyadh, KSA"
              />
            </div>
          </div>

          {/* بيانات السجل التجاري والتسجيل الضريبي */}
          <div className="space-y-3 border-t border-border pt-4">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <FileText size={15} className="text-muted-foreground" />
              {t("supNew.registryHeading")}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>{t("supNew.commercialRegister")}</Label>
                <Input
                  value={form.commercialRegister}
                  onChange={(e) => update("commercialRegister", e.target.value)}
                  placeholder={t("supNew.regPlaceholder")}
                  dir="rtl"
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("supNew.taxRegistration")}</Label>
                <Input
                  value={form.taxRegistration}
                  onChange={(e) => update("taxRegistration", e.target.value)}
                  placeholder={t("supNew.taxPlaceholder")}
                  dir="rtl"
                />
              </div>
            </div>
          </div>

          {/* بيانات الحساب البنكي / الدفع */}
          <div className="space-y-3 border-t border-border pt-4">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Landmark size={15} className="text-muted-foreground" />
              {t("supNew.bankHeading")}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5 sm:col-span-2">
                <Label>{t("supNew.bankName")}</Label>
                <BankCombobox value={form.bankName} onChange={(v) => update("bankName", v)} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>{t("supNew.bankAccountHolder")}</Label>
                <Input
                  value={form.bankAccountHolder}
                  onChange={(e) => update("bankAccountHolder", e.target.value)}
                  placeholder={t("supNew.holderHint")}
                  dir="rtl"
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("supNew.bankAccountNumber")}</Label>
                <Input
                  value={form.bankAccountNumber}
                  onChange={(e) => update("bankAccountNumber", e.target.value)}
                  placeholder="1234567890"
                  dir="ltr"
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("supNew.iban")}</Label>
                <Input
                  value={form.iban}
                  onChange={(e) => update("iban", e.target.value)}
                  placeholder="EG380019000500000000263180002"
                  dir="ltr"
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("supNew.swift")}</Label>
                <Input
                  value={form.swiftCode}
                  onChange={(e) => update("swiftCode", e.target.value.toUpperCase())}
                  placeholder="NBEGEGCX"
                  dir="ltr"
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("supNew.bankBranch")}</Label>
                <Input
                  value={form.bankBranch}
                  onChange={(e) => update("bankBranch", e.target.value)}
                  placeholder={t("supNew.branchPlaceholder")}
                  dir="rtl"
                />
              </div>
            </div>
          </div>

          {/* Multi-category checkboxes */}
          <div className="space-y-2">
            <Label>
              {t("supF.categories")} *{" "}
              <span className="text-muted-foreground font-normal text-xs">
                {t("supNew.multiHint")}
              </span>
            </Label>
            {categories.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("supF.noCategories")}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {orderCategoryTree(categories).map((c) => {
                  const active = selectedCats.has(c.name);
                  // A grouping category cannot hold a supplier (the server
                  // refuses it), so the checkbox is disabled and labelled.
                  const isLeaf = leaves.has(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      disabled={!isLeaf}
                      title={isLeaf ? undefined : t("sup.pick.parentDisabled")}
                      onClick={() => isLeaf && toggleCat(c.name)}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors capitalize ${
                        active
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-muted text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
                      } ${!isLeaf ? "cursor-not-allowed opacity-50 hover:border-border hover:text-muted-foreground" : ""}`}
                    >
                      {c.depth > 0 ? "↳ " : ""}
                      {c.name}
                      {!isLeaf ? ` · ${t("sup.pick.parentBadge")}` : ""}
                    </button>
                  );
                })}
              </div>
            )}
            {selectedCats.size > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("supF.selected")} {Array.from(selectedCats).join(", ")}
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
                {t("supF.cancel")}
              </a>
            </Link>
            <Button type="submit" disabled={createMutation.isPending || !form.name}>
              {createMutation.isPending ? t("supNew.saving") : t("supNew.title")}
            </Button>
          </div>
        </form>
      </div>
    </Layout>
  );
}
