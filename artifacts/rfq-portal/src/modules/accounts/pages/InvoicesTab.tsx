import {
  PageHeader,
  Loading,
  ErrorState,
  NotConfigured,
  DataTable,
  StatCard,
} from "../components/ui";
import { useBridgeQuery, egp, type OdooInvoice, type OdooPayment } from "../lib/bridge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";

function partnerName(p: [number, string] | false): string {
  return Array.isArray(p) ? String(p[1]) : "—";
}

const STATE_LABEL: Record<string, string> = {
  draft: "مسودة",
  posted: "مرحَّلة",
  cancel: "ملغاة",
};

const PAYMENT_LABEL: Record<string, string> = {
  not_paid: "غير مسددة",
  partial: "مسددة جزئياً",
  paid: "مسددة",
  in_payment: "قيد التحصيل",
};

/** فواتير البيع والشراء والمدفوعات — from Odoo. */
export default function InvoicesTab() {
  const sales = useBridgeQuery<{ invoices: OdooInvoice[] }>("/accounts/odoo/invoices/sales");
  const supplier = useBridgeQuery<{ invoices: OdooInvoice[] }>("/accounts/odoo/invoices/supplier");
  const supplierPayments = useBridgeQuery<{ payments: OdooPayment[] }>(
    "/accounts/odoo/payments/supplier",
  );

  if (sales.notConfigured || supplier.notConfigured || supplierPayments.notConfigured) {
    return <NotConfigured onRetry={sales.reload} />;
  }

  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="الفواتير والمدفوعات"
        subtitle="من Odoo — فواتير البيع والشراء ومدفوعات الموردين"
      />

      <Tabs defaultValue="sales">
        <TabsList>
          <TabsTrigger value="sales">فواتير البيع</TabsTrigger>
          <TabsTrigger value="supplier">فواتير الشراء</TabsTrigger>
          <TabsTrigger value="payments">مدفوعات الموردين</TabsTrigger>
        </TabsList>

        <TabsContent value="sales">
          {sales.isLoading ? (
            <Loading />
          ) : sales.error ? (
            <ErrorState message={sales.error} onRetry={sales.reload} />
          ) : (
            <InvoiceView invoices={sales.data?.invoices ?? []} />
          )}
        </TabsContent>

        <TabsContent value="supplier">
          {supplier.isLoading ? (
            <Loading />
          ) : supplier.error ? (
            <ErrorState message={supplier.error} onRetry={supplier.reload} />
          ) : (
            <InvoiceView invoices={supplier.data?.invoices ?? []} />
          )}
        </TabsContent>

        <TabsContent value="payments">
          {supplierPayments.isLoading ? (
            <Loading />
          ) : supplierPayments.error ? (
            <ErrorState message={supplierPayments.error} onRetry={supplierPayments.reload} />
          ) : (
            <Card className="p-4 space-y-3">
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                <StatCard
                  label="عدد المدفوعات"
                  value={supplierPayments.data?.payments.length ?? 0}
                />
                <StatCard
                  label="إجمالي المدفوع"
                  value={egp(sum((supplierPayments.data?.payments ?? []).map((p) => p.amount)))}
                />
              </div>
              <DataTable
                columns={[
                  { key: "date", label: "التاريخ", width: "110px" },
                  { key: "name", label: "المرجع", width: "150px" },
                  { key: "partner", label: "المورد" },
                  { key: "memo", label: "البيان" },
                  { key: "amount", label: "المبلغ", align: "end" },
                  { key: "state", label: "الحالة", width: "110px" },
                ]}
                rows={(supplierPayments.data?.payments ?? []).map((p) => [
                  p.date,
                  p.name || p.payment_reference,
                  partnerName(p.partner_id),
                  p.memo,
                  egp(p.amount),
                  <Badge key={p.id} variant="outline">
                    {p.state === "posted" ? "مرحَّلة" : p.state}
                  </Badge>,
                ])}
                empty="لا توجد مدفوعات"
              />
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function InvoiceView({ invoices }: { invoices: OdooInvoice[] }) {
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="عدد الفواتير" value={invoices.length} />
        <StatCard
          label="الإجمالي بدون ضريبة"
          value={egp(sum(invoices.map((i) => i.amount_untaxed)))}
        />
        <StatCard
          label="إجمالي ض.ق.م."
          value={egp(sum(invoices.map((i) => i.amount_tax)))}
          tone="warning"
        />
        <StatCard
          label="المتبقي"
          value={egp(sum(invoices.map((i) => i.amount_residual)))}
          tone="negative"
        />
      </div>
      <Card className="p-4">
        <DataTable
          columns={[
            { key: "date", label: "التاريخ", width: "110px" },
            { key: "name", label: "رقم الفاتورة", width: "150px" },
            { key: "ref", label: "المرجع" },
            { key: "partner", label: "الطرف" },
            { key: "untaxed", label: "بدون ضريبة", align: "end" },
            { key: "tax", label: "ض.ق.م.", align: "end" },
            { key: "total", label: "الإجمالي", align: "end" },
            { key: "state", label: "الحالة", width: "100px" },
          ]}
          rows={invoices.map((i) => [
            i.invoice_date,
            i.name || "—",
            i.ref || "—",
            partnerName(i.partner_id),
            egp(i.amount_untaxed),
            egp(i.amount_tax),
            egp(i.amount_total),
            <Badge key={i.id} variant={i.state === "posted" ? "default" : "outline"}>
              {STATE_LABEL[i.state] ?? i.state}
              {i.state === "posted"
                ? ` · ${PAYMENT_LABEL[i.payment_state] ?? i.payment_state}`
                : ""}
            </Badge>,
          ])}
          empty="لا توجد فواتير"
        />
      </Card>
    </div>
  );
}
