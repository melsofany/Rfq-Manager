import { useState } from "react";
import { Layout } from "@/components/Layout";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Calculator, ReceiptText, ShieldCheck, Settings2 } from "lucide-react";
import MarginsTab from "./MarginsTab";
import VatTab from "./VatTab";
import WithholdingTab from "./WithholdingTab";
import TaxSettingsTab from "./TaxSettingsTab";

export default function AccountsPage() {
  const [tab, setTab] = useState("margins");

  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-5">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Calculator size={20} className="text-primary" />
            الحسابات والامتثال الضريبي المصري
          </h1>
          <p className="text-muted-foreground text-sm">
            الهامش المحقق، ضريبة القيمة المضافة 14%؜، والخصم تحت حساب المورد 3%؜ على أوامر الشراء
            وفق القانون المصري
          </p>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="margins" className="text-xs gap-1.5">
              <Calculator size={14} />
              الهامش المحقق
            </TabsTrigger>
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
