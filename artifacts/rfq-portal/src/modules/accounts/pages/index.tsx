import { useState, useEffect } from "react";
import { Layout } from "@/components/Layout";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Calculator, BookCopy, BookOpen, FileText, Truck, BarChart3, Percent } from "lucide-react";
import JournalTab from "./JournalTab";
import SalesAndCollectionsTab from "./SalesAndCollectionsTab";
import SuppliersTab from "./SuppliersTab";
import ChartOfAccountsTab from "./ChartOfAccountsTab";
import ReportsTab from "./ReportsTab";
import TaxesTab from "./TaxesTab";

function readTabParam(): string {
  return new URLSearchParams(window.location.search).get("tab") || "journal";
}

export default function AccountsPage() {
  const [tab, setTab] = useState<string>(readTabParam());

  useEffect(() => {
    const onPop = () => setTab(readTabParam());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

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
            <TabsTrigger value="journal" className="text-xs gap-1.5">
              <BookCopy size={14} />
              قيود اليومية
            </TabsTrigger>
            <TabsTrigger value="sales" className="text-xs gap-1.5">
              <FileText size={14} />
              المبيعات والتحصيل
            </TabsTrigger>
            <TabsTrigger value="suppliers" className="text-xs gap-1.5">
              <Truck size={14} />
              الموردون
            </TabsTrigger>
            <TabsTrigger value="coa" className="text-xs gap-1.5">
              <BookOpen size={14} />
              دليل الحسابات
            </TabsTrigger>
            <TabsTrigger value="reports" className="text-xs gap-1.5">
              <BarChart3 size={14} />
              التقارير المالية
            </TabsTrigger>
            <TabsTrigger value="taxes" className="text-xs gap-1.5">
              <Percent size={14} />
              الضرائب
            </TabsTrigger>
          </TabsList>

          <TabsContent value="journal" className="mt-5">
            <JournalTab />
          </TabsContent>
          <TabsContent value="sales" className="mt-5">
            <SalesAndCollectionsTab />
          </TabsContent>
          <TabsContent value="suppliers" className="mt-5">
            <SuppliersTab />
          </TabsContent>
          <TabsContent value="coa" className="mt-5">
            <ChartOfAccountsTab />
          </TabsContent>
          <TabsContent value="reports" className="mt-5">
            <ReportsTab />
          </TabsContent>
          <TabsContent value="taxes" className="mt-5">
            <TaxesTab />
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
}
