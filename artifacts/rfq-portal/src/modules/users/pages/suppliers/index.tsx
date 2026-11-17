import { useMemo, useState } from "react";
import { useDebounced } from "@/hooks/use-debounced";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useListCategories, getListCategoriesQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, Users, Settings, Upload, Boxes, Tag, X, Filter } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { filterTabs } from "@/lib/permissions";
import ImportSuppliersTab from "./import-tab";
import { CategoryFilterSelect } from "./CategoryFilterSelect";
import { CategoriesTab } from "./CategoriesTab";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";

function parseCategories(cat: string | null | undefined): string[] {
  if (!cat) return [];
  return cat
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

interface ItemCategoryRef {
  id: number;
  name: string;
  /** The supplier quoted a price for an item in this category. */
  quoted?: boolean;
  /** A purchase order was issued to the supplier for an item in this category. */
  ordered?: boolean;
  /** A human linked the pair explicitly. */
  manual?: boolean;
}

/** The API enriches each supplier with the ITEM categories it can supply. */
interface SupplierRow {
  id: number;
  name: string;
  supplierId?: string | null;
  contactPerson?: string | null;
  email?: string | null;
  phone?: string | null;
  category?: string | null;
  categories?: string[];
  isActive?: boolean;
  invoiceHasVat?: boolean | null;
  itemCategories?: ItemCategoryRef[];
}

interface CategoryNodeLite {
  id: number;
  name: string;
  parentId?: number | null;
}

function TradeCategoryChips({ names }: { names: string[] }) {
  if (names.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {names.map((cat) => (
        <span
          key={cat}
          className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200"
        >
          <Tag size={10} className="opacity-60" />
          {cat}
        </span>
      ))}
    </div>
  );
}

/**
 * The chip carries WHY the supplier has the category. Without this the column
 * is a mystery — the operator asked how the system knows, and the answer is
 * always one of three facts: he quoted it, he was issued a PO for it, or a
 * human linked it. The badge makes that visible at a glance.
 */
function evidenceBadge(
  c: ItemCategoryRef,
  t: (k: string) => string,
): { label: string; title: string; className: string } | null {
  if (c.ordered)
    return {
      label: t("sup.evidence.ordered"),
      title: t("sup.evidence.orderedTitle"),
      className: "bg-emerald-600 text-white",
    };
  if (c.quoted)
    return {
      label: t("sup.evidence.quoted"),
      title: t("sup.evidence.quotedTitle"),
      className: "bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300",
    };
  if (c.manual)
    return {
      label: t("sup.evidence.manual"),
      title: t("sup.evidence.manualTitle"),
      className: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
    };
  return null;
}

function ItemCategoryChips({ cats, t }: { cats: ItemCategoryRef[]; t: (k: string) => string }) {
  if (cats.length === 0)
    return <span className="text-xs text-muted-foreground">{t("sup.notSet")}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {cats.map((c) => {
        const badge = evidenceBadge(c, t);
        return (
          <span
            key={c.id}
            title={badge?.title}
            className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
          >
            <Boxes size={10} className="opacity-60" />
            {c.name}
            {badge && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-px text-[9px] font-semibold leading-none",
                  badge.className,
                )}
              >
                {badge.label}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

function SuppliersListTab({ onOpenCategories }: { onOpenCategories: () => void }) {
  const { t } = useLanguage();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [tradeCategory, setTradeCategory] = useState("all");
  const [itemCategoryId, setItemCategoryId] = useState<number | "all">("all");

  const { data: tradeCategories = [] } = useListCategories({
    query: { queryKey: getListCategoriesQueryKey() },
  });

  // The ITEM-category catalogue — a different list from the trade one, and the
  // one the «يورّد بنود» filter reads.
  const { data: itemCategories = [] } = useQuery<CategoryNodeLite[]>({
    queryKey: ["item-categories"],
    queryFn: async () => {
      const res = await fetch("/api/item-categories", { credentials: "include" });
      if (!res.ok) throw new Error("failed");
      return (await res.json()) as CategoryNodeLite[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const debouncedSearch = useDebounced(search);

  // Direct fetch: the item-category filter is not in the OpenAPI spec, so the
  // orval hook cannot express it (same pattern as the receipts/accounts tabs).
  const { data: suppliersRaw, isLoading } = useQuery<SupplierRow[]>({
    queryKey: ["suppliers", tradeCategory, itemCategoryId, debouncedSearch],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (tradeCategory !== "all") qs.set("category", tradeCategory);
      if (debouncedSearch) qs.set("search", debouncedSearch);
      if (itemCategoryId !== "all") qs.set("itemCategoryId", String(itemCategoryId));
      const res = await fetch(`/api/suppliers${qs.toString() ? `?${qs}` : ""}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("failed");
      return (await res.json()) as SupplierRow[];
    },
  });

  const suppliers = useMemo(() => suppliersRaw ?? [], [suppliersRaw]);
  const hasFilter = tradeCategory !== "all" || itemCategoryId !== "all" || Boolean(search);

  const clearFilters = () => {
    setSearch("");
    setTradeCategory("all");
    setItemCategoryId("all");
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:pt-6">
        <div>
          <h1 className="text-xl font-bold text-foreground">{t("sup.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("sup.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onOpenCategories}>
            <Settings size={14} /> {t("sup.tab.categories")}
          </Button>
          <Button onClick={() => navigate("/suppliers/new")} size="sm" className="gap-1.5">
            <Plus size={15} /> {t("sup.add")}
          </Button>
        </div>
      </div>

      <div className="space-y-3 px-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] max-w-xs flex-1">
            <Search
              size={15}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("sup.searchPlaceholder")}
              className="h-8 pr-8 text-sm"
            />
          </div>
          {hasFilter && (
            <Button variant="ghost" size="sm" className="h-8 gap-1.5" onClick={clearFilters}>
              <X size={14} /> {t("sup.clearFilters")}
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            {isLoading ? t("sup.loading") : t("sup.count", { n: suppliers.length })}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <CategoryFilterSelect
            label={t("sup.filter.trade")}
            icon={<Tag size={12} className="text-muted-foreground" />}
            options={tradeCategories}
            selectedLabel={tradeCategory === "all" ? null : tradeCategory}
            onPick={(c) => setTradeCategory(c.name)}
            onClear={() => setTradeCategory("all")}
            emptyText={t("sup.filter.noTrade")}
          />
          <CategoryFilterSelect
            label={t("sup.filter.item")}
            icon={<Boxes size={12} className="text-emerald-600" />}
            options={itemCategories}
            selectedLabel={
              itemCategoryId === "all"
                ? null
                : (itemCategories.find((c) => c.id === itemCategoryId)?.name ?? null)
            }
            onPick={(c) => setItemCategoryId(c.id)}
            onClear={() => setItemCategoryId("all")}
            emptyText={t("sup.filter.noItem")}
            tone="emerald"
          />
        </div>
      </div>

      <div className="mx-4 mb-4 overflow-hidden rounded-lg border border-border bg-card sm:mx-6 sm:mb-6">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">{t("sup.loading")}</div>
        ) : suppliers.length === 0 ? (
          <div className="p-12 text-center">
            <Users size={40} className="mx-auto mb-3 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">
              {hasFilter ? t("sup.emptyFiltered") : t("sup.empty")}
            </p>
            {hasFilter ? (
              <Button variant="outline" size="sm" className="mt-3 gap-1.5" onClick={clearFilters}>
                <Filter size={14} /> {t("sup.clearFilters")}
              </Button>
            ) : (
              <Button onClick={() => navigate("/suppliers/new")} size="sm" className="mt-3 gap-1.5">
                <Plus size={14} /> {t("sup.add")}
              </Button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-right">
                  <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    {t("sup.col.supplier")}
                  </th>
                  <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    {t("sup.col.contact")}
                  </th>
                  <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    {t("sup.col.tradeCategory")}
                  </th>
                  <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    {t("sup.col.itemCategories")}
                  </th>
                  <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground">
                    {t("sup.col.status")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s) => {
                  const cats = s.categories ?? parseCategories(s.category);
                  const itemCats = s.itemCategories ?? [];
                  return (
                    <tr
                      key={s.id}
                      className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-muted/20"
                      onClick={() => navigate(`/suppliers/${s.id}`)}
                    >
                      <td className="px-4 py-3">
                        <p className="font-medium text-foreground">{s.name}</p>
                        {s.supplierId && (
                          <p className="font-mono text-xs text-muted-foreground">{s.supplierId}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        <div>{s.contactPerson ?? "—"}</div>
                        {s.phone && (
                          <div className="font-mono" dir="ltr">
                            {s.phone}
                          </div>
                        )}
                        {s.email && (
                          <div className="truncate" dir="ltr">
                            {s.email}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <TradeCategoryChips names={cats} />
                      </td>
                      <td className="px-4 py-3">
                        <ItemCategoryChips cats={itemCats} t={t} />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <div className="flex flex-col items-center gap-1">
                          <span
                            className={cn(
                              "inline-flex items-center rounded px-2 py-0.5 text-xs font-medium",
                              s.isActive
                                ? "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300"
                                : "bg-muted text-muted-foreground",
                            )}
                          >
                            {s.isActive ? t("sup.active") : t("sup.inactive")}
                          </span>
                          {s.invoiceHasVat === false && (
                            <span className="inline-flex items-center rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                              {t("sup.noVat")}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

type Tab = "list" | "import" | "categories";

export default function SuppliersPage() {
  const { t } = useLanguage();
  const { employee } = useAuth();
  const allowedTabs = filterTabs(employee?.role, employee?.permissions, "suppliers", [
    "list",
    "import",
  ] as const);
  const [activeTab, setActiveTab] = useState<Tab>(allowedTabs[0] ?? "list");
  // The category tab hosts the catalogue manager; the API gates the writes on
  // admin/manager, so the tab is visible to all but the manager-only controls
  // inside it are hidden for a plain viewer.
  const canManage = employee?.role === "admin" || employee?.role === "manager";

  return (
    <Layout>
      <div className="border-b border-border px-4 pt-4 sm:px-6 sm:pt-6">
        <div className="flex gap-0">
          {allowedTabs.includes("list") && (
            <button
              onClick={() => setActiveTab("list")}
              className={cn(
                "-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                activeTab === "list"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              <Users size={14} />
              {t("sup.tab.list")}
            </button>
          )}
          {allowedTabs.includes("import") && (
            <button
              onClick={() => setActiveTab("import")}
              className={cn(
                "-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                activeTab === "import"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              <Upload size={14} />
              {t("sup.tab.import")}
            </button>
          )}
          <button
            onClick={() => setActiveTab("categories")}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium transition-colors",
              activeTab === "categories"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
            )}
          >
            <Tag size={14} />
            {t("sup.tab.categories")}
          </button>
        </div>
      </div>

      {activeTab === "list" && (
        <SuppliersListTab onOpenCategories={() => setActiveTab("categories")} />
      )}
      {activeTab === "import" && <ImportSuppliersTab />}
      {activeTab === "categories" && <CategoriesTab canManage={canManage} />}
    </Layout>
  );
}
