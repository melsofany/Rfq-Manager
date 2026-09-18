import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  BookOpen,
  BookOpenCheck,
  Scale,
  ShieldCheck,
  FileText,
  Banknote,
  Lock,
} from "lucide-react";
import JournalTab from "./JournalTab";
import ChartOfAccountsTab from "./ChartOfAccountsTab";
import SalesAndCollectionsTab from "./SalesAndCollectionsTab";
import SuppliersTab from "./SuppliersTab";
import ReportsTab from "./ReportsTab";
import TaxesTab from "./TaxesTab";
import MonthlyClosingTab from "./MonthlyClosingTab";

/**
 * الترحيل المحاسبي — the posting / ledger side of the accounts page.
 *
 * Journal entries, chart of accounts, financial reports, taxes, monthly
 * closing, and the invoice sub-ledgers (sales & collection, suppliers) — the
 * accounting workflow that turns the operational documents into balanced
 * double-entry records.
 */
export default function AccountingTab() {
  return (
    <Tabs defaultValue="journal">
      <TabsList className="flex-wrap h-auto">
        <TabsTrigger value="journal" className="text-xs gap-1.5">
          <BookOpen size={14} /> قيود اليومية
        </TabsTrigger>
        <TabsTrigger value="sales" className="text-xs gap-1.5">
          <FileText size={14} /> المبيعات والتحصيل
        </TabsTrigger>
        <TabsTrigger value="suppliers" className="text-xs gap-1.5">
          <ShieldCheck size={14} /> الموردون
        </TabsTrigger>
        <TabsTrigger value="coa" className="text-xs gap-1.5">
          <BookOpenCheck size={14} /> دليل الحسابات
        </TabsTrigger>
        <TabsTrigger value="reports" className="text-xs gap-1.5">
          <Scale size={14} /> التقارير المالية
        </TabsTrigger>
        <TabsTrigger value="taxes" className="text-xs gap-1.5">
          <Banknote size={14} /> الضرائب
        </TabsTrigger>
        <TabsTrigger value="closing" className="text-xs gap-1.5">
          <Lock size={14} /> الإقفال الشهري
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
      <TabsContent value="closing" className="mt-5">
        <MonthlyClosingTab />
      </TabsContent>
    </Tabs>
  );
}
