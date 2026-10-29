import {
  PageHeader,
  Loading,
  ErrorState,
  NotConfigured,
  DataTable,
  StatCard,
} from "../components/ui";
import { useBridgeQuery, egp } from "../lib/bridge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

interface TaxesPayload {
  taxes: { id: number; name: string; amount: number; amount_type: string; type_tax_use: string }[];
  vat: {
    rate: number;
    outputVat: number;
    inputVat: number;
    netPayable: number;
    salesBase: number;
    purchasesBase: number;
  };
  withholding: { rate: number; amount: number };
}

/** الضرائب — VAT 14% and withholding 3%, read from Odoo's tax configuration. */
export default function TaxesTab() {
  const { data, isLoading, error, notConfigured, reload } =
    useBridgeQuery<TaxesPayload>("/accounts/odoo/taxes");

  if (notConfigured) return <NotConfigured onRetry={reload} />;
  if (isLoading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <PageHeader title="الضرائب" subtitle="من Odoo — ض.ق.م. 14% وخصم تحت حساب المورد 3%" />

      <Tabs defaultValue="vat">
        <TabsList>
          <TabsTrigger value="vat">ض.ق.م. ({data.vat.rate}%)</TabsTrigger>
          <TabsTrigger value="wh">خصم تحت حساب المورد ({data.withholding.rate}%)</TabsTrigger>
          <TabsTrigger value="defs">تعريفات الضرائب</TabsTrigger>
        </TabsList>

        <TabsContent value="vat">
          <div className="space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <StatCard label="وعاء المبيعات" value={egp(data.vat.salesBase)} />
              <StatCard
                label={`ض.ق.م. مخرجات ${data.vat.rate}%`}
                value={egp(data.vat.outputVat)}
                tone="warning"
              />
              <StatCard
                label={`ض.ق.م. مدخلات ${data.vat.rate}%`}
                value={egp(data.vat.inputVat)}
                tone="warning"
              />
              <StatCard
                label="صافي المستحق"
                value={egp(data.vat.netPayable)}
                tone={data.vat.netPayable > 0 ? "negative" : "positive"}
              />
            </div>
            <Card className="p-4 text-xs text-muted-foreground leading-relaxed">
              ض.ق.م. مخرجات = {data.vat.rate}% على المبيعات، ومدخلات = {data.vat.rate}% على
              المشتريات. الصافي المستحق = مخرجات − مدخلات. يُرحَّل الرصيد الدائن للفترة التالية عند
              السالب.
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="wh">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label="وعاء المشتريات" value={egp(data.vat.purchasesBase)} />
            <StatCard
              label={`نسبة الخصم ${data.withholding.rate}%`}
              value={`${data.withholding.rate}%`}
            />
            <StatCard
              label="قيمة الخصم المستحقة"
              value={egp(data.withholding.amount)}
              tone="warning"
            />
          </div>
          <Card className="p-4 mt-4 text-xs text-muted-foreground leading-relaxed">
            خصم تحت حساب المورد = {data.withholding.rate}% من صافي قيمة التوريد (بدون ض.ق.م.)، يُخصم
            من فاتورة المورد وتورّده الشركة لمصلحة الضرائب.
          </Card>
        </TabsContent>

        <TabsContent value="defs">
          <Card className="p-4">
            <DataTable
              columns={[
                { key: "name", label: "الضريبة" },
                { key: "amount", label: "النسبة", align: "end" },
                { key: "type", label: "النوع" },
                { key: "use", label: "الاستخدام" },
              ]}
              rows={data.taxes.map((t) => [
                t.name,
                t.amount_type === "percent" ? `${t.amount}%` : String(t.amount),
                t.amount_type,
                t.type_tax_use,
              ])}
              empty="لا توجد ضرائب معرَّفة في Odoo"
            />
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
