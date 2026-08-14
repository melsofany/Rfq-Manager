import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { FileText, Banknote } from "lucide-react";
import SalesInvoicesTab from "./SalesInvoicesTab";
import CollectionsPage from "@/modules/collections/pages";

/** المبيعات والتحصيل — فواتير البيع + تحصيل العملاء (تبويبات داخلية). */
export default function SalesAndCollectionsTab() {
  return (
    <Tabs defaultValue="sales">
      <TabsList className="flex-wrap h-auto">
        <TabsTrigger value="sales" className="text-xs gap-1.5">
          <FileText size={14} /> فواتير البيع
        </TabsTrigger>
        <TabsTrigger value="collections" className="text-xs gap-1.5">
          <Banknote size={14} /> تحصيل العملاء
        </TabsTrigger>
      </TabsList>
      <TabsContent value="sales" className="mt-5">
        <SalesInvoicesTab />
      </TabsContent>
      <TabsContent value="collections" className="mt-5">
        <CollectionsPage />
      </TabsContent>
    </Tabs>
  );
}
