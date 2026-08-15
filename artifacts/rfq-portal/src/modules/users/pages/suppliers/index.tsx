import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListSuppliers,
  getListSuppliersQueryKey,
  useListCategories,
  getListCategoriesQueryKey,
  useCreateCategory,
  useUpdateCategory,
  useDeleteCategory,
} from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Plus,
  Search,
  Users,
  Settings,
  Pencil,
  Trash2,
  X,
  Check,
  AlertCircle,
  Upload,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { filterTabs } from "@/lib/permissions";
import ImportSuppliersTab from "./import-tab";

function parseCategories(cat: string | null | undefined): string[] {
  if (!cat) return [];
  return cat
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function ManageCategoriesDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data: categories = [], isLoading } = useListCategories({
    query: { queryKey: getListCategoriesQueryKey() },
  });

  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleteErrors, setDeleteErrors] = useState<Record<number, string>>({});

  const createMutation = useCreateCategory({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
        setNewName("");
        setAddError(null);
      },
      onError: (err: unknown) => {
        const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
        setAddError(msg ?? "Failed to add category");
      },
    },
  });

  const updateMutation = useUpdateCategory({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
        setEditingId(null);
        setEditError(null);
      },
      onError: (err: unknown) => {
        const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
        setEditError(msg ?? "Failed to update category");
      },
    },
  });

  const deleteMutation = useDeleteCategory({
    mutation: {
      onSuccess: (_data: unknown, variables: { id: number }) => {
        queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
        setDeleteErrors((prev) => {
          const next = { ...prev };
          delete next[variables.id];
          return next;
        });
      },
      onError: (err: unknown, variables: { id: number }) => {
        const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
        setDeleteErrors((prev) => ({ ...prev, [variables.id]: msg ?? "Cannot delete category" }));
      },
    },
  });

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setAddError(null);
    createMutation.mutate({ data: { name: newName.trim() } });
  };

  const startEdit = (id: number, name: string) => {
    setEditingId(id);
    setEditName(name);
    setEditError(null);
    setDeleteErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const saveEdit = (id: number) => {
    if (!editName.trim()) return;
    setEditError(null);
    updateMutation.mutate({ id, data: { name: editName.trim() } });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground">Manage Categories</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <form onSubmit={handleAdd} className="space-y-1.5">
            <div className="flex gap-2">
              <Input
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value);
                  setAddError(null);
                }}
                placeholder="New category name..."
                className="h-8 text-sm"
              />
              <Button
                type="submit"
                size="sm"
                disabled={createMutation.isPending || !newName.trim()}
                className="gap-1.5"
              >
                <Plus size={14} /> Add
              </Button>
            </div>
            {addError && (
              <div className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertCircle size={12} />
                <span>{addError}</span>
              </div>
            )}
          </form>

          <div className="space-y-1 max-h-72 overflow-y-auto">
            {isLoading ? (
              <p className="text-muted-foreground text-sm text-center py-4">Loading...</p>
            ) : categories.length === 0 ? (
              <p className="text-muted-foreground text-sm text-center py-4">No categories yet</p>
            ) : (
              categories.map((cat) => (
                <div key={cat.id} className="space-y-0.5">
                  <div className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/30">
                    {editingId === cat.id ? (
                      <>
                        <Input
                          value={editName}
                          onChange={(e) => {
                            setEditName(e.target.value);
                            setEditError(null);
                          }}
                          className="h-7 text-sm flex-1"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEdit(cat.id);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                        />
                        <button
                          onClick={() => saveEdit(cat.id)}
                          className="text-green-600 hover:text-green-700 p-0.5"
                          disabled={updateMutation.isPending}
                        >
                          <Check size={15} />
                        </button>
                        <button
                          onClick={() => {
                            setEditingId(null);
                            setEditError(null);
                          }}
                          className="text-muted-foreground hover:text-foreground p-0.5"
                        >
                          <X size={15} />
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="flex-1 text-sm text-foreground capitalize">
                          {cat.name}
                        </span>
                        <button
                          onClick={() => startEdit(cat.id, cat.name)}
                          className="text-muted-foreground hover:text-foreground p-0.5"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => {
                            setDeleteErrors((prev) => {
                              const next = { ...prev };
                              delete next[cat.id];
                              return next;
                            });
                            deleteMutation.mutate({ id: cat.id });
                          }}
                          className="text-muted-foreground hover:text-destructive p-0.5"
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>
                  {editingId === cat.id && editError && (
                    <div className="flex items-center gap-1.5 text-xs text-destructive px-2">
                      <AlertCircle size={12} />
                      <span>{editError}</span>
                    </div>
                  )}
                  {deleteErrors[cat.id] && (
                    <div className="flex items-center gap-1.5 text-xs text-destructive px-2">
                      <AlertCircle size={12} />
                      <span>{deleteErrors[cat.id]}</span>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-border flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
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

  const { data: suppliers, isLoading } = useListSuppliers(
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

  return (
    <>
      {showManage && <ManageCategoriesDialog onClose={() => setShowManage(false)} />}

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
            {categories.map((c) => (
              <button
                key={c.id}
                onClick={() => setCategory(c.name)}
                className={`px-2.5 py-1 rounded text-xs font-medium capitalize transition-colors ${
                  category === c.name
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
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
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                              s.isActive
                                ? "bg-green-50 text-green-700"
                                : "bg-muted text-muted-foreground"
                            }`}
                          >
                            {s.isActive ? "Active" : "Inactive"}
                          </span>
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
  const allowedTabs = filterTabs(employee?.role, employee?.permissions, "suppliers", ["list", "import"] as const);
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
