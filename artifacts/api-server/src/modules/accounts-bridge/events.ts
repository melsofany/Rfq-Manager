/**
 * جسر الحسابات — أحداث RFQ (event → Odoo sync entry points)
 *
 * One function per RFQ event. Each loads the RFQ row(s) it needs, builds the
 * mapping input, and hands the whole thing to `syncEvent`, which owns the
 * idempotency. These are the functions the RFQ modules call after a write, and
 * the functions the replay endpoint re-runs.
 *
 * They never throw: a failed or unconfigured sync must not roll back the RFQ
 * write that triggered it. The failure is recorded and surfaces on
 * `GET /accounts/sync-status`.
 */

import {
  db,
  poItemReceiptsTable,
  purchaseOrderItemsTable,
  purchaseOrdersTable,
  suppliersTable,
  customerPoItemDeliveriesTable,
  customerPoItemsTable,
  customerPosTable,
  customersTable,
  operatingExpensesTable,
  customerPoPaymentsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { syncEvent, type SyncResult } from "./service";
import {
  mapSupplierReceiptToVendorBill,
  mapCustomerDeliveryToInvoice,
  mapCustomerDeliveryToCogs,
  mapExpenseToJournalEntry,
  mapCustomerPaymentToPayment,
  mapCancellationToCreditNote,
} from "./mapping";
import { logger } from "../../shared/logger";

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return isFinite(n) ? n : 0;
}

// ─── Supplier goods receipt → vendor bill ───────────────────────────────────

export async function syncSupplierReceipt(receiptId: number): Promise<SyncResult> {
  return syncEvent("supplier_receipt", "po_item_receipts", receiptId, async (ctx) => {
    const [receipt] = await db
      .select()
      .from(poItemReceiptsTable)
      .where(eq(poItemReceiptsTable.id, receiptId))
      .limit(1);
    if (!receipt) throw new Error(`po_item_receipts ${receiptId} not found`);

    const [line] = await db
      .select()
      .from(purchaseOrderItemsTable)
      .where(eq(purchaseOrderItemsTable.id, receipt.poItemId))
      .limit(1);
    const [po] = await db
      .select()
      .from(purchaseOrdersTable)
      .where(eq(purchaseOrdersTable.id, receipt.poId))
      .limit(1);
    const supplier = line?.supplierId
      ? (
          await db
            .select()
            .from(suppliersTable)
            .where(eq(suppliersTable.id, line.supplierId))
            .limit(1)
        )[0]
      : undefined;

    const supplierName = supplier?.name ?? "مورد";
    const partnerId = await ctx.partner({
      kind: "supplier",
      rfqId: supplier?.id ?? null,
      name: supplierName,
      email: supplier?.email ?? null,
      phone: supplier?.phone ?? null,
      taxId: supplier?.taxRegistration ?? null,
    });

    return mapSupplierReceiptToVendorBill({
      receiptId,
      poId: receipt.poId,
      internalPoNo: po?.internalPoNo ?? String(receipt.poId),
      supplierId: supplier?.id ?? null,
      supplierName,
      receiptDate: receipt.receivedAt.toISOString().slice(0, 10),
      acceptedQty: num(receipt.acceptedQty),
      unitCost: num(receipt.actualCost) || num(line?.finalActualCost),
      taxIncluded: line?.taxIncluded ?? false,
      partnerId,
      expenseAccountId: await ctx.account({ key: "purchase", accountType: "expense_direct_cost" }),
      vatAccountId: await ctx.account({
        key: "vat_input",
        code: "1401",
        accountType: "asset_current",
      }),
      withholdingAccountId: await ctx.account({
        key: "withholding",
        code: "2402",
        accountType: "liability_current",
      }),
      payableAccountId: await ctx.account({ key: "payable", accountType: "liability_payable" }),
      rates: ctx.rates,
    });
  });
}

// ─── Customer delivery → customer invoice + COGS ────────────────────────────

export async function syncCustomerDelivery(deliveryId: number): Promise<SyncResult> {
  return syncEvent("customer_delivery", "customer_po_item_deliveries", deliveryId, async (ctx) => {
    const [delivery] = await db
      .select()
      .from(customerPoItemDeliveriesTable)
      .where(eq(customerPoItemDeliveriesTable.id, deliveryId))
      .limit(1);
    if (!delivery) throw new Error(`customer_po_item_deliveries ${deliveryId} not found`);

    const [item] = delivery.customerPoItemId
      ? await db
          .select()
          .from(customerPoItemsTable)
          .where(eq(customerPoItemsTable.id, delivery.customerPoItemId))
          .limit(1)
      : [];
    const [po] = await db
      .select()
      .from(customerPosTable)
      .where(eq(customerPosTable.id, delivery.customerPoId))
      .limit(1);
    const customer = po?.customerId
      ? (
          await db
            .select()
            .from(customersTable)
            .where(eq(customersTable.id, po.customerId))
            .limit(1)
        )[0]
      : undefined;

    const customerName = po?.customerName ?? customer?.name ?? "عميل";
    const partnerId = await ctx.partner({
      kind: "customer",
      rfqId: customer?.id ?? null,
      name: customerName,
      email: customer?.email ?? null,
      phone: customer?.phone ?? null,
      taxId: customer?.taxId ?? null,
    });

    // The unit cost comes from the supplier line linked to this customer line,
    // so the COGS mirrors what was actually paid for the goods delivered.
    const [supplierLine] = item
      ? await db
          .select()
          .from(purchaseOrderItemsTable)
          .where(eq(purchaseOrderItemsTable.customerPoItemId, item.id))
          .limit(1)
      : [];

    const input = {
      deliveryId,
      customerPoId: delivery.customerPoId,
      internalPoNo: po?.internalPoNo ?? String(delivery.customerPoId),
      customerId: customer?.id ?? null,
      customerName,
      deliveryDate: delivery.deliveredAt.toISOString().slice(0, 10),
      deliveredQty: num(delivery.deliveredQty),
      unitPrice: num(item?.unitPrice),
      unitCost: num(supplierLine?.finalActualCost),
      partnerId,
      incomeAccountId: await ctx.account({ key: "income", accountType: "income" }),
      outputVatAccountId: await ctx.account({
        key: "vat_output",
        code: "2401",
        accountType: "liability_current",
      }),
      receivableAccountId: await ctx.account({
        key: "receivable",
        accountType: "asset_receivable",
      }),
      cogsAccountId: await ctx.account({
        key: "cogs",
        code: "5100",
        accountType: "expense_direct_cost",
      }),
      inventoryAccountId: await ctx.account({
        key: "inventory",
        code: "1300",
        accountType: "asset_current",
      }),
      rates: ctx.rates,
    };

    // The invoice is the primary document; the COGS entry is synced under its
    // own event key so a failure of one does not silently drop the other.
    await syncEvent("customer_delivery", "customer_po_item_deliveries_cogs", deliveryId, async () =>
      mapCustomerDeliveryToCogs(input),
    );

    return mapCustomerDeliveryToInvoice(input);
  });
}

// ─── Expense → journal entry ────────────────────────────────────────────────

export async function syncExpense(expenseId: number): Promise<SyncResult> {
  return syncEvent("expense", "operating_expenses", expenseId, async (ctx) => {
    const [expense] = await db
      .select()
      .from(operatingExpensesTable)
      .where(eq(operatingExpensesTable.id, expenseId))
      .limit(1);
    if (!expense) throw new Error(`operating_expenses ${expenseId} not found`);
    return mapExpenseToJournalEntry({
      expenseId,
      category: expense.category,
      description: expense.description,
      expenseDate: expense.expenseDate,
      amount: num(expense.amount),
      expenseAccountId: await ctx.account({ key: "expense", accountType: "expense" }),
      paymentAccountId: await ctx.account({ key: "cash", code: "1001", accountType: "asset_cash" }),
    });
  });
}

// ─── Customer payment → payment entry ───────────────────────────────────────

export async function syncCustomerPayment(paymentId: number): Promise<SyncResult> {
  return syncEvent("customer_payment", "customer_po_payments", paymentId, async (ctx) => {
    const [payment] = await db
      .select()
      .from(customerPoPaymentsTable)
      .where(eq(customerPoPaymentsTable.id, paymentId))
      .limit(1);
    if (!payment) throw new Error(`customer_po_payments ${paymentId} not found`);
    const [po] = await db
      .select()
      .from(customerPosTable)
      .where(eq(customerPosTable.id, payment.customerPoId))
      .limit(1);
    const customerName = po?.customerName ?? "عميل";
    const partnerId = await ctx.partner({
      kind: "customer",
      rfqId: po?.customerId ?? null,
      name: customerName,
    });
    return mapCustomerPaymentToPayment({
      paymentId,
      customerPoId: payment.customerPoId,
      internalPoNo: po?.internalPoNo ?? String(payment.customerPoId),
      customerName,
      paymentDate: payment.paymentDate,
      amount: num(payment.amount),
      method: payment.method,
      partnerId,
    });
  });
}

// ─── Cancellation / rejection → credit note ─────────────────────────────────

export async function syncCancellation(input: {
  side: "customer" | "supplier";
  sourceTable: string;
  sourceId: number;
  internalPoNo: string;
  partnerName: string;
  date: string;
  qty: number;
  unitPrice: number;
  reason?: string | null;
  rfqPartnerId?: number | null;
}): Promise<SyncResult> {
  return syncEvent("cancellation", input.sourceTable, input.sourceId, async (ctx) => {
    const partnerId = await ctx.partner({
      kind: input.side,
      rfqId: input.rfqPartnerId ?? null,
      name: input.partnerName,
    });
    return mapCancellationToCreditNote({
      side: input.side,
      sourceTable: input.sourceTable,
      sourceId: input.sourceId,
      internalPoNo: input.internalPoNo,
      partnerName: input.partnerName,
      date: input.date,
      qty: input.qty,
      unitPrice: input.unitPrice,
      reason: input.reason,
      partnerId,
      incomeAccountId: await ctx.account({ key: "income", accountType: "income" }),
      expenseAccountId: await ctx.account({ key: "purchase", accountType: "expense_direct_cost" }),
      rates: ctx.rates,
    });
  });
}

/** Fire-and-forget helper for write paths: never blocks, never throws. */
export function syncInBackground(label: string, fn: () => Promise<SyncResult>): void {
  fn().catch((err) => logger.warn({ err, label }, "accounts-bridge: background sync failed"));
}
