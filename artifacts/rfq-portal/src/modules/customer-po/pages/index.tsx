import { useState } from "react";
import { useLocation } from "wouter";
import { useListCustomerPos, getListCustomerPosQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Search, ShoppingCart } from "lucide-react";
import CustomerDeliveriesPage from "./deliveries";

export default function CustomerPoPage() {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("orders");

  const { data: pos, isLoading } = useListCustomerPos(
    { search: search || undefined },
    { query: { queryKey: getListCustomerPosQueryKey({ search: search || undefined }) } },
  );

  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
              <ShoppingCart size={20} className="text-primary" />
              أوامر شراء العملاء
            </h1>
            <p className="text-muted-foreground text-sm">
              إدارة أوامر الشراء الواردة من العملاء
            </p>
          </div>
          <Button onClick={() => navigate("/customer-po/new")} size="sm" className="gap-1.5">
            <Plus size={15} /> أمر شراء جديد
          </Button>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="orders" className="text-xs">أوامر شراء العملاء</TabsTrigger>
            <TabsTrigger value="deliveries" className="text-xs">تسليمات العملاء</TabsTrigger>
          </TabsList>
        </Tabs>

        {tab === "deliveries" ? (
          <CustomerDeliveriesPage />
        ) : (
          <>
        <div className="relative max-w-xs">
          <Search
            size={15}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="بحث بالرقم أو المشتري..."
            className="pl-8 h-8 text-sm"
          />
        </div>

        <div className="bg-card border border-border rounded-lg overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">جارٍ التحميل...</div>
          ) : !pos?.length ? (
            <div className="p-12 text-center">
              <ShoppingCart size={40} className="mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground text-sm">لا توجد أوامر شراء</p>
              <Button
                onClick={() => navigate("/customer-po/new")}
                size="sm"
                className="mt-3 gap-1.5"
              >
                <Plus size={14} /> إنشاء أول أمر
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/30 border-b border-border text-right">
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium">
                      الرقم الداخلي
                    </th>
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium">
                      رقم أمر العميل
                    </th>
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium">العميل</th>
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium">
                      التاريخ
                    </th>
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium">
                      المشتري
                    </th>
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium">
                      المدخل
                    </th>
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium text-center">
                      البنود
                    </th>
                    <th className="px-4 py-3 text-muted-foreground text-xs font-medium text-center">
                      الحالة
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pos.map((po) => (
                    <tr
                      key={po.id}
                      className="border-b border-border last:border-0 hover:bg-muted/20 cursor-pointer"
                      onClick={() => navigate(`/customer-po/${po.id}`)}
                    >
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs text-primary font-medium">
                          {po.internalPoNo}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs text-foreground">
                          {po.customerPoNo}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-foreground text-xs">
                        {po.customerName ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs" dir="ltr">
                        {po.poDate ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {po.buyerName ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {po.employeeName ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="inline-flex items-center justify-center w-6 h-6 bg-muted rounded text-xs font-medium text-foreground">
                          {po.itemCount ?? 0}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${
                            po.status === "sent"
                              ? "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400"
                              : "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400"
                          }`}
                        >
                          {po.status === "sent" ? "تم الإرسال" : "مسودة"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
          </>
        )}
      </div>
    </Layout>
  );
}
