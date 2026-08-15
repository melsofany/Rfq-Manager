import { useState, useEffect } from "react";
import { Layout } from "@/components/Layout";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Calculator, BookCopy, BookOpen, FileText, Truck, BarChart3, Percent } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { filterTabs } from "@/lib/permissions";
import JournalTab from "./JournalTab";
import SalesAndCollectionsTab from "./SalesAndCollectionsTab";
import SuppliersTab from "./SuppliersTab";
import ChartOfAccountsTab from "./ChartOfAccountsTab";
import ReportsTab from "./ReportsTab";
import TaxesTab from "./TaxesTab";

const ACCOUNTS_TABS = ["journal", "sales", "suppliers", "coa", "reports", "taxes"] as const;

const TAB_META: Record<string, { icon: React.ElementType; label: string }> = {
  journal: { icon: BookCopy, label: "قيود اليومية" },
  sales: { icon: FileText, label: "المبيعات والتحصيل" },
  suppliers: { icon: Truck, label: "الموردون" },
  coa: { icon: BookOpen, label: "دليل الحسابات" },
  reports: { icon: BarChart3, label: "التقارير المالية" },
  taxes: { icon: Percent, label: "الضرائب" },
};

function readTabParam(allowed: readonly string[]): string {
  const param = new URLSearchParams(window.location.search).get("tab") || "journal";
  return allowed.includes(param) ? param : (allowed[0] ?? "journal");
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

          {allowedTabs.includes("journal") && (
            <TabsContent value="journal" className="mt-5">
              <JournalTab />
            </TabsContent>
          )}
          {allowedTabs.includes("sales") && (
            <TabsContent value="sales" className="mt-5">
              <SalesAndCollectionsTab />
            </TabsContent>
          )}
          {allowedTabs.includes("suppliers") && (
            <TabsContent value="suppliers" className="mt-5">
              <SuppliersTab />
            </TabsContent>
          )}
          {allowedTabs.includes("coa") && (
            <TabsContent value="coa" className="mt-5">
              <ChartOfAccountsTab />
            </TabsContent>
          )}
          {allowedTabs.includes("reports") && (
            <TabsContent value="reports" className="mt-5">
              <ReportsTab />
            </TabsContent>
          )}
          {allowedTabs.includes("taxes") && (
            <TabsContent value="taxes" className="mt-5">
              <TaxesTab />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </Layout>
  );
}
