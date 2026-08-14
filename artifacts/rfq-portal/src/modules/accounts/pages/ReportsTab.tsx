import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { LayoutDashboard, Scale, TrendingUp } from "lucide-react";
import DashboardTab from "./DashboardTab";
import FinancialStatementsTab from "./FinancialStatementsTab";
import MarginsTab from "./MarginsTab";

/** التقارير المالية — لوحة المحاسب + القوائم المالية + الهامش المحقق (تبويبات داخلية). */
export default function ReportsTab() {
  return (
    <Tabs defaultValue="dashboard">
      <TabsList className="flex-wrap h-auto">
        <TabsTrigger value="dashboard" className="text-xs gap-1.5">
          <LayoutDashboard size={14} /> لوحة المحاسب
        </TabsTrigger>
        <TabsTrigger value="statements" className="text-xs gap-1.5">
          <Scale size={14} /> القوائم المالية
        </TabsTrigger>
        <TabsTrigger value="margins" className="text-xs gap-1.5">
          <TrendingUp size={14} /> الهامش المحقق
        </TabsTrigger>
      </TabsList>
      <TabsContent value="dashboard" className="mt-5">
        <DashboardTab />
      </TabsContent>
      <TabsContent value="statements" className="mt-5">
        <FinancialStatementsTab />
      </TabsContent>
      <TabsContent value="margins" className="mt-5">
        <MarginsTab />
      </TabsContent>
    </Tabs>
  );
}
