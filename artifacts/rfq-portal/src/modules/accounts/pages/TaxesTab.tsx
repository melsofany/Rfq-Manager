import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ReceiptText, Settings2, Lock } from "lucide-react";
import VatTab from "./VatTab";
import TaxSettingsTab from "./TaxSettingsTab";
import ClosingTab from "./ClosingTab";

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
        <TabsTrigger value="closings" className="text-xs gap-1.5">
          <Lock size={14} /> الإقفال الشهري
        </TabsTrigger>
      </TabsList>
      <TabsContent value="vat" className="mt-5">
        <VatTab />
      </TabsContent>
      <TabsContent value="settings" className="mt-5">
        <TaxSettingsTab />
      </TabsContent>
      <TabsContent value="closings" className="mt-5">
        <ClosingTab />
      </TabsContent>
    </Tabs>
  );
}
