import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Receipt, ShieldCheck } from "lucide-react";
import SupplierInvoicesTab from "./SupplierInvoicesTab";
import WithholdingTab from "./WithholdingTab";

/** الموردون — فواتير الموردين + الخصم تحت حساب المورد 3% (تبويبات داخلية). */
export default function SuppliersTab() {
  return (
    <Tabs defaultValue="invoices">
      <TabsList className="flex-wrap h-auto">
        <TabsTrigger value="invoices" className="text-xs gap-1.5">
          <Receipt size={14} /> فواتير الموردين
        </TabsTrigger>
        <TabsTrigger value="withholding" className="text-xs gap-1.5">
          <ShieldCheck size={14} /> الخصم تحت حساب المورد
        </TabsTrigger>
      </TabsList>
      <TabsContent value="invoices" className="mt-5">
        <SupplierInvoicesTab />
      </TabsContent>
      <TabsContent value="withholding" className="mt-5">
        <WithholdingTab />
      </TabsContent>
    </Tabs>
  );
}
