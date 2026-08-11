import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCustomers,
  useDeleteCustomer,
  getListCustomersQueryKey,
} from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, Users, Pencil, Trash2, AlertCircle } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { getApiErrorMessage } from "@/lib/api-error";

export default function CustomersPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { employee } = useAuth();
  const isAdmin = employee?.role === "admin" || employee?.role === "manager";

  const [search, setSearch] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);

  const { data: customers, isLoading } = useListCustomers(
    { search: search || undefined },
    {
      query: {
        queryKey: getListCustomersQueryKey({ search: search || undefined }),
      },
    },
  );

  const deleteMutation = useDeleteCustomer({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
        setConfirmId(null);
        setDeleteError(null);
      },
      onError: (err: unknown) => {
        setDeleteError(getApiErrorMessage(err, "تعذر حذف العميل"));
        setConfirmId(null);
      },
    },
  });

  const handleDelete = (id: number) => {
    setDeleteError(null);
    deleteMutation.mutate({ id });
  };

  return (
    <Layout>
      <div className="space-y-4">
        {/* Actions row */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-6 pt-4 sm:pt-6">
          <div>
            <h1 className="text-xl font-bold text-foreground">العملاء</h1>
            <p className="text-muted-foreground text-sm">إدارة دليل العملاء</p>
          </div>
          <Button onClick={() => navigate("/customers/new")} size="sm" className="gap-1.5">
            <Plus size={15} /> إضافة عميل
          </Button>
        </div>

        {/* Search */}
        <div className="px-4 sm:px-6">
          <div className="relative max-w-xs">
            <Search
              size={15}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="بحث بالاسم أو الهاتف..."
              className="pl-8 h-8 text-sm"
            />
          </div>
        </div>

        {/* Delete error */}
        {deleteError && (
          <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2 mx-4 sm:mx-6">
            <AlertCircle size={14} />
            <span>{deleteError}</span>
          </div>
        )}

        {/* Table */}
        <div className="bg-card border border-border rounded-lg overflow-hidden mx-4 sm:mx-6 mb-4 sm:mb-6">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
          ) : !customers?.length ? (
            <div className="p-12 text-center">
              <Users size={40} className="mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground text-sm">لا يوجد عملاء</p>
              <Button
                onClick={() => navigate("/customers/new")}
                size="sm"
                className="mt-3 gap-1.5"
              >
                <Plus size={14} /> إضافة عميل
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/30 border-b border-border text-right">
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">العميل</th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                      اسم الشهرة
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                      الهاتف
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                      العنوان
                    </th>
                    <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                      الحالة
                    </th>
                    {isAdmin && (
                      <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">
                        إجراءات
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {customers.map((c) => (
                    <tr
                      key={c.id}
                      className="border-b border-border last:border-0 hover:bg-muted/20 cursor-pointer"
                      onClick={() => navigate(`/customers/${c.id}`)}
                    >
                      <td className="px-4 py-3">
                        <p className="font-medium text-foreground">{c.name}</p>
                        {c.customerId && (
                          <p className="text-muted-foreground text-xs font-mono">{c.customerId}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {c.nickname ?? "-"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs" dir="ltr">
                        {c.phone ?? "-"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {c.address ?? "-"}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                            c.isActive
                              ? "bg-green-50 text-green-700"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {c.isActive ? "نشط" : "غير نشط"}
                        </span>
                      </td>
                      {isAdmin && (
                        <td className="px-4 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                          {confirmId === c.id ? (
                            <div className="flex items-center justify-center gap-1">
                              <Button
                                size="sm"
                                variant="destructive"
                                className="h-7 px-2 text-xs"
                                disabled={deleteMutation.isPending}
                                onClick={() => handleDelete(c.id)}
                              >
                                تأكيد
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                onClick={() => setConfirmId(null)}
                              >
                                إلغاء
                              </Button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-center gap-1">
                              <button
                                className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
                                title="تعديل"
                                onClick={() => navigate(`/customers/${c.id}`)}
                              >
                                <Pencil size={14} />
                              </button>
                              <button
                                className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                title="حذف"
                                onClick={() => {
                                  setDeleteError(null);
                                  setConfirmId(c.id);
                                }}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          )}
                        </td>
                      )}
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
