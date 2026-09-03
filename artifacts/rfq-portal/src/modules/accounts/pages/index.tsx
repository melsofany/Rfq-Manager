import { useState, useEffect } from "react";
import { Layout } from "@/components/Layout";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Calculator, PackageCheck, Wallet, BookCopy } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { filterTabs } from "@/lib/permissions";
import PurchaseOrderAccountsTab from "./PurchaseOrderAccountsTab";
import ExpensesAccountsTab from "./ExpensesAccountsTab";
import GeneralAccountingTab from "./GeneralAccountingTab";

const ACCOUNTS_TABS = ["purchase-orders", "expenses", "general-accounting"] as const;

const TAB_META: Record<string, { icon: React.ElementType; label: string }> = {
  "purchase-orders": { icon: PackageCheck, label: "أوامر الشراء" },
  expenses: { icon: Wallet, label: "المصاريف والتكاليف" },
  "general-accounting": { icon: BookCopy, label: "الحسابات العامة" },
};

function readTabParam(allowed: readonly string[]): string {
  const param = new URLSearchParams(window.location.search).get("tab") || "purchase-orders";
  return allowed.includes(param) ? param : (allowed[0] ?? "purchase-orders");
}

export default function AccountsPage() {
  const { employee } = useAuth();
  const allowedTabs = filterTabs(employee?.role, employee?.permissions, "accounts", ACCOUNTS_TABS);
  const [tab, setTab] = useState<string>(readTabParam(allowedTabs));

  useEffect(() => {
    const onPop = () => setTab(readTabParam(allowedTabs));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [allowedTabs]);

  function onTabChange(value: string) {
    setTab(value);
    const url = new URL(window.location.href);
    if (value === "dashboard") url.searchParams.delete("tab");
    else url.searchParams.set("tab", value);
    window.history.replaceState(null, "", url);
  }

  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-5">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Calculator size={20} className="text-primary" />
            الحسابات والامتثال الضريبي المصري
          </h1>
          <p className="text-muted-foreground text-sm">
            نظام محاسبة متكامل بالقيد المزدوج — مصدر واحد للحقيقة: كل المدخلات (القيود، الفواتير، التحصيلات)
            تُرحَّل إلى دفتر اليومية، وكل التقارير والقوائم المالية والإقرارات الضريبية تُقرأ منه.
            وفقًا للقانون المصري (ض.ق.م. 14%؜، خصم تحت حساب المورد 3%؜).
          </p>
        </div>

        <Tabs value={tab} onValueChange={onTabChange}>
          <TabsList className="flex-wrap h-auto">
            {allowedTabs.map((tabId) => {
              const meta = TAB_META[tabId];
              if (!meta) return null;
              const Icon = meta.icon;
              return (
                <TabsTrigger key={tabId} value={tabId} className="text-xs gap-1.5">
                  <Icon size={14} />
                  {meta.label}
                </TabsTrigger>
              );
            })}
          </TabsList>

          {allowedTabs.includes("purchase-orders") && (
            <TabsContent value="purchase-orders" className="mt-5">
              <PurchaseOrderAccountsTab />
            </TabsContent>
          )}
          {allowedTabs.includes("expenses") && (
            <TabsContent value="expenses" className="mt-5">
              <ExpensesAccountsTab />
            </TabsContent>
          )}
          {allowedTabs.includes("general-accounting") && (
            <TabsContent value="general-accounting" className="mt-5">
              <GeneralAccountingTab />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </Layout>
  );
}
