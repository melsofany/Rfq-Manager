import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ReceiptText, Settings2 } from "lucide-react";
import VatTab from "./VatTab";
import TaxSettingsTab from "./TaxSettingsTab";

/** الضرائب — ضريبة القيمة المضافة 14% + إعدادات الضرائب (تبويبات داخلية). */
export default function TaxesTab() {
  return (
    <Tabs defaultValue="vat">
      <TabsList className="flex-wrap h-auto">
        <TabsTrigger value="vat" className="text-xs gap-1.5">
          <ReceiptText size={14} /> ضريبة القيمة المضافة
        </TabsTrigger>
        <TabsTrigger value="settings" className="text-xs gap-1.5">
          <Settings2 size={14} /> إعدادات الضرائب
        </TabsTrigger>
      </TabsList>
      <TabsContent value="vat" className="mt-5">
        <VatTab />
      </TabsContent>
      <TabsContent value="settings" className="mt-5">
        <TaxSettingsTab />
      </TabsContent>
    </Tabs>
  );
}
