import { Layout } from "@/components/Layout";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Calculator, ClipboardList, Wallet, BookOpenCheck } from "lucide-react";
import OrdersRegistryTab from "./OrdersRegistryTab";
import ExpensesAndCostsTab from "./ExpensesAndCostsTab";
import AccountingTab from "./AccountingTab";

/**
 * الحسابات — the accounting workspace, organised into three main sections:
 *
 *  1. سجل الحركات (records) — أوامر شراء العملاء + أوامر شراء الموردين, showing
 *     only orders that have been delivered / settled.
 *  2. المصاريف والتكاليف (expenses & costs) — operating expenses (electricity,
 *     internet, water, domains, subscriptions, transport, misc.) + the charges
 *     tied to supplier PO lines.
 *  3. الترحيل المحاسبي (posting) — journal entries, invoices, chart of
 *     accounts, financial statements, taxes and the monthly closing lock.
 */
export default function AccountsPage() {
  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-5">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Calculator size={20} className="text-primary" />
            الحسابات
          </h1>
          <p className="text-muted-foreground text-sm">
            السجل المحاسبي للحركات المكتملة، والمصاريف والتكاليف، والترحيل المحاسبي بالقيد المزدوج.
          </p>
        </div>

        <Tabs defaultValue="records">
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="records" className="gap-1.5">
              <ClipboardList size={15} /> سجل الحركات
            </TabsTrigger>
            <TabsTrigger value="expenses" className="gap-1.5">
              <Wallet size={15} /> المصاريف والتكاليف
            </TabsTrigger>
            <TabsTrigger value="posting" className="gap-1.5">
              <BookOpenCheck size={15} /> الترحيل المحاسبي
            </TabsTrigger>
          </TabsList>

          <TabsContent value="records" className="mt-5">
            <OrdersRegistryTab />
          </TabsContent>
          <TabsContent value="expenses" className="mt-5">
            <ExpensesAndCostsTab />
          </TabsContent>
          <TabsContent value="posting" className="mt-5">
            <AccountingTab />
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
}
