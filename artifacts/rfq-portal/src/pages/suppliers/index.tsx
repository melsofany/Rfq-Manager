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
import { Label } from "@/components/ui/label";
import { Plus, Search, Users, Settings, Pencil, Trash2, X, Check } from "lucide-react";

function ManageCategoriesDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data: categories = [], isLoading } = useListCategories({
    query: { queryKey: getListCategoriesQueryKey() },
  });

  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");

  const createMutation = useCreateCategory({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
        setNewName("");
      },
    },
  });

  const updateMutation = useUpdateCategory({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
        setEditingId(null);
      },
    },
  });

  const deleteMutation = useDeleteCategory({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
      },
    },
  });

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    createMutation.mutate({ data: { name: newName.trim() } });
  };

  const startEdit = (id: number, name: string) => {
    setEditingId(id);
    setEditName(name);
  };

  const saveEdit = (id: number) => {
    if (!editName.trim()) return;
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
          {/* Add new */}
          <form onSubmit={handleAdd} className="flex gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New category name..."
              className="h-8 text-sm"
            />
            <Button type="submit" size="sm" disabled={createMutation.isPending || !newName.trim()} className="gap-1.5">
              <Plus size={14} /> Add
            </Button>
          </form>

          {/* List */}
          <div className="space-y-1 max-h-72 overflow-y-auto">
            {isLoading ? (
              <p className="text-muted-foreground text-sm text-center py-4">Loading...</p>
            ) : categories.length === 0 ? (
              <p className="text-muted-foreground text-sm text-center py-4">No categories yet</p>
            ) : (
              categories.map((cat) => (
                <div key={cat.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/30">
                  {editingId === cat.id ? (
                    <>
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
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
                      <button onClick={() => setEditingId(null)} className="text-muted-foreground hover:text-foreground p-0.5">
                        <X size={15} />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 text-sm text-foreground capitalize">{cat.name}</span>
                      <button
                        onClick={() => startEdit(cat.id, cat.name)}
                        className="text-muted-foreground hover:text-foreground p-0.5"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={() => deleteMutation.mutate({ id: cat.id })}
                        className="text-muted-foreground hover:text-destructive p-0.5"
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 size={13} />
                      </button>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-border flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>Done</Button>
        </div>
      </div>
    </div>
  );
}

export default function SuppliersPage() {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [showManage, setShowManage] = useState(false);

  const { data: categories = [] } = useListCategories({
    query: { queryKey: getListCategoriesQueryKey() },
  });

  const { data: suppliers, isLoading } = useListSuppliers(
    { category: category !== "all" ? category : undefined, search: search || undefined },
    { query: { queryKey: getListSuppliersQueryKey({ category: category !== "all" ? category : undefined, search: search || undefined }) } }
  );

  return (
    <Layout>
      {showManage && <ManageCategoriesDialog onClose={() => setShowManage(false)} />}

      <div className="p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-foreground">Suppliers</h1>
            <p className="text-muted-foreground text-sm">Manage supplier directory</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setShowManage(true)}>
              <Settings size={14} /> Manage Categories
            </Button>
            <Button onClick={() => navigate("/suppliers/new")} size="sm" className="gap-1.5">
              <Plus size={15} /> Add Supplier
            </Button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
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

        <div className="bg-card border border-border rounded-lg overflow-hidden">
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
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/30 border-b border-border text-left">
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Supplier</th>
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Contact</th>
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Email</th>
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Phone</th>
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Category</th>
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">Status</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s) => (
                  <tr
                    key={s.id}
                    className="border-b border-border last:border-0 hover:bg-muted/20 cursor-pointer"
                    onClick={() => navigate(`/suppliers/${s.id}`)}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-foreground">{s.name}</p>
                      {s.supplierId && <p className="text-muted-foreground text-xs font-mono">{s.supplierId}</p>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{s.contactPerson ?? "-"}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{s.email ?? "-"}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{s.phone ?? "-"}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground capitalize">
                        {s.category}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        s.isActive ? "bg-green-50 text-green-700" : "bg-muted text-muted-foreground"
                      }`}>
                        {s.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>
  );
}
