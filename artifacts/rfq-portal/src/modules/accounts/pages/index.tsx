import { useState, useEffect } from "react";
import { Layout } from "@/components/Layout";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Calculator, ReceiptText, ShieldCheck, Settings2, Banknote, LayoutDashboard, BookOpen, BookCopy, Receipt, FileText, Scale, TrendingUp } from "lucide-react";
import MarginsTab from "./MarginsTab";
import VatTab from "./VatTab";
import WithholdingTab from "./WithholdingTab";
import TaxSettingsTab from "./TaxSettingsTab";
import CollectionsPage from "@/modules/collections/pages";
import DashboardTab from "./DashboardTab";
import ChartOfAccountsTab from "./ChartOfAccountsTab";
import JournalTab from "./JournalTab";
import SupplierInvoicesTab from "./SupplierInvoicesTab";
import SalesInvoicesTab from "./SalesInvoicesTab";
import FinancialStatementsTab from "./FinancialStatementsTab";

function readTabParam(): string {
  return new URLSearchParams(window.location.search).get("tab") || "dashboard";
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
            {/* الإدخال — المستندات والقيود */}
            <TabsTrigger value="journal" className="text-xs gap-1.5">
              <BookCopy size={14} />
              قيود اليومية
            </TabsTrigger>
            <TabsTrigger value="sales-invoices" className="text-xs gap-1.5">
              <FileText size={14} />
              فواتير البيع
            </TabsTrigger>
            <TabsTrigger value="supplier-invoices" className="text-xs gap-1.5">
              <Receipt size={14} />
              فواتير الموردين
            </TabsTrigger>
            <TabsTrigger value="collections" className="text-xs gap-1.5">
              <Banknote size={14} />
              تحصيل العملاء
            </TabsTrigger>
            {/* التقارير المالية */}
            <TabsTrigger value="dashboard" className="text-xs gap-1.5">
              <LayoutDashboard size={14} />
              لوحة المحاسب
            </TabsTrigger>
            <TabsTrigger value="coa" className="text-xs gap-1.5">
              <BookOpen size={14} />
              دليل الحسابات
            </TabsTrigger>
            <TabsTrigger value="statements" className="text-xs gap-1.5">
              <Scale size={14} />
              القوائم المالية
            </TabsTrigger>
            <TabsTrigger value="margins" className="text-xs gap-1.5">
              <TrendingUp size={14} />
              الهامش المحقق
            </TabsTrigger>
            {/* الامتثال الضريبي */}
            <TabsTrigger value="vat" className="text-xs gap-1.5">
              <ReceiptText size={14} />
              ضريبة القيمة المضافة
            </TabsTrigger>
            <TabsTrigger value="withholding" className="text-xs gap-1.5">
              <ShieldCheck size={14} />
              الخصم تحت حساب المورد
            </TabsTrigger>
            <TabsTrigger value="settings" className="text-xs gap-1.5">
              <Settings2 size={14} />
              إعدادات الضرائب
            </TabsTrigger>
          </TabsList>

          <TabsContent value="journal" className="mt-5">
            <JournalTab />
          </TabsContent>
          <TabsContent value="sales-invoices" className="mt-5">
            <SalesInvoicesTab />
          </TabsContent>
          <TabsContent value="supplier-invoices" className="mt-5">
            <SupplierInvoicesTab />
          </TabsContent>
          <TabsContent value="collections" className="mt-5">
            <CollectionsPage />
          </TabsContent>
          <TabsContent value="dashboard" className="mt-5">
            <DashboardTab />
          </TabsContent>
          <TabsContent value="coa" className="mt-5">
            <ChartOfAccountsTab />
          </TabsContent>
          <TabsContent value="statements" className="mt-5">
            <FinancialStatementsTab />
          </TabsContent>
          <TabsContent value="margins" className="mt-5">
            <MarginsTab />
          </TabsContent>
          <TabsContent value="vat" className="mt-5">
            <VatTab />
          </TabsContent>
          <TabsContent value="withholding" className="mt-5">
            <WithholdingTab />
          </TabsContent>
          <TabsContent value="settings" className="mt-5">
            <TaxSettingsTab />
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
}
