import { useState } from "react";
import { useDebounced } from "@/hooks/use-debounced";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListSuppliers,
  getListSuppliersQueryKey,
  useListCategories,
  getListCategoriesQueryKey,
} from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, Users, Settings, Upload } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { filterTabs } from "@/lib/permissions";
import ImportSuppliersTab from "./import-tab";
import { orderCategoryTree } from "@/lib/category-tree";
import { CategoryManagerDialog } from "./CategoryManagerDialog";

function parseCategories(cat: string | null | undefined): string[] {
  if (!cat) return [];
  return cat
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─── Suppliers List Tab ────────────────────────────────────────────────────────

function SuppliersListTab() {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [showManage, setShowManage] = useState(false);
  const { employee } = useAuth();
  const isAdmin = employee?.role === "admin";

  const { data: categories = [] } = useListCategories({
    query: { queryKey: getListCategoriesQueryKey() },
  });

  const debouncedSearch = useDebounced(search);
  const { data: suppliers, isLoading } = useListSuppliers(
    { category: category !== "all" ? category : undefined, search: debouncedSearch || undefined },
    {
      query: {
        queryKey: getListSuppliersQueryKey({
          category: category !== "all" ? category : undefined,
          search: debouncedSearch || undefined,
        }),
      },
    },
  );

  return (
    <>
      {showManage && <CategoryManagerDialog onClose={() => setShowManage(false)} />}

      <div className="space-y-4">
        {/* Actions row */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-6 pt-4 sm:pt-6">
          <div>
            <h1 className="text-xl font-bold text-foreground">Suppliers</h1>
            <p className="text-muted-foreground text-sm">Manage supplier directory</p>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setShowManage(true)}
              >
                <Settings size={14} /> Manage Categories
              </Button>
            )}
            <Button onClick={() => navigate("/suppliers/new")} size="sm" className="gap-1.5">
              <Plus size={15} /> Add Supplier
            </Button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex gap-3 flex-wrap px-4 sm:px-6">
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <Search
              size={15}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search suppliers..."
              className="pl-8 h-8 text-sm"
            />
          </div>
          <div className="flex gap-1 flex-wrap">
            <button
              onClick={() => setCategory("all")}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                category === "all"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              all
            </button>
            {orderCategoryTree(categories).map((c) => (
              <button
                key={c.id}
                onClick={() => setCategory(c.name)}
                className={`px-2.5 py-1 rounded text-xs font-medium capitalize transition-colors ${
                  category === c.name
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                {c.depth > 0 ? "↳ " : ""}
                {c.name}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="bg-card border border-border rounded-lg overflow-hidden mx-4 sm:mx-6 mb-4 sm:mb-6">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">Loading...</div>
          ) : !suppliers?.length ? (
            <div className="p-12 text-center">
              <Users size={40} className="mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground text-sm">No suppliers found</p>
              <Button onClick={() => navigate("/suppliers/new")} size="sm" className="mt-3 gap-1.5">
                <Plus size={14} /> Add Supplier
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/30 border-b border-border text-left">
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                      Supplier
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                      Contact
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Email</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Phone</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                      Categories
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {suppliers.map((s) => {
                    const cats = parseCategories(s.category);
                    return (
                      <tr
                        key={s.id}
                        className="border-b border-border last:border-0 hover:bg-muted/20 cursor-pointer"
                        onClick={() => navigate(`/suppliers/${s.id}`)}
                      >
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
                          {s.email ?? "-"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">
                          {s.phone ?? "-"}
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
                        <td className="px-4 py-3 text-center">
                          <div className="flex flex-col items-center gap-1">
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                s.isActive
                                  ? "bg-green-50 text-green-700"
                                  : "bg-muted text-muted-foreground"
                              }`}
                            >
                              {s.isActive ? "Active" : "Inactive"}
                            </span>
                            {s.invoiceHasVat === false && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-50 text-amber-700">
                                بدون ضريبة
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
    </>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

type Tab = "list" | "import";

export default function SuppliersPage() {
  const { employee } = useAuth();
  const allowedTabs = filterTabs(employee?.role, employee?.permissions, "suppliers", [
    "list",
    "import",
  ] as const);
  const [activeTab, setActiveTab] = useState<Tab>(allowedTabs[0] ?? "list");

  return (
    <Layout>
      {/* Tab bar */}
      <div className="border-b border-border px-4 sm:px-6 pt-4 sm:pt-6">
        <div className="flex gap-0">
          {allowedTabs.includes("list") && (
            <button
              onClick={() => setActiveTab("list")}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
                activeTab === "list"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
              }`}
            >
              <Users size={14} />
              الموردون
            </button>
          )}
          {allowedTabs.includes("import") && (
            <button
              onClick={() => setActiveTab("import")}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
                activeTab === "import"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
              }`}
            >
              <Upload size={14} />
              استيراد موردين
            </button>
          )}
        </div>
      </div>

      {/* Tab content */}
      {activeTab === "list" ? <SuppliersListTab /> : <ImportSuppliersTab />}
    </Layout>
  );
}
