/**
 * جسر الحسابات — تحويل أحداث RFQ إلى مستندات Odoo
 *
 * Maps each RFQ business event to the Odoo document that records it, as a PURE
 * function of the event data. Nothing here touches the network or the database:
 * the caller (service.ts) resolves the Odoo ids and performs the create. Keeping
 * the mapping pure is what lets the VAT/withholding/idempotency rules be tested
 * without an Odoo instance.
 *
 * Mapping (per the agreed decisions):
 *
 *   supplier goods receipt → account.move (in_invoice)  vendor bill
 *                            net + 14% VAT − 3% withholding
 *   customer delivery      → account.move (out_invoice) customer invoice
 *                          + account.move.line COGS/Inventory (cost of goods)
 *   expense entry          → account.move (entry)       journal entry
 *   customer payment       → account.payment            payment entry
 *   cancellation/rejection → account.move (out_refund / in_refund) credit note
 */

import {
  DEFAULT_TAX_RATES,
  ratesFrom,
  vatComponents,
  vendorBillTotals,
  withholdingOn,
  round2,
  type TaxRates,
} from "./tax";

/** The Odoo document a mapping produces. */
export interface OdooDocument {
  /** The Odoo model to `create`. */
  odooModel: string;
  /** The create values. */
  values: Record<string, unknown>;
  /**
   * A stable business reference stored on the Odoo record (`ref` / `payment_ref`
   * / `name`). A human can search Odoo for it to find the originating RFQ event,
   * and it is the second, Odoo-side half of the idempotency guarantee.
   */
  odooRef: string;
  /** Human summary for the sync log. */
  summary: string;
}

// ─── Event keys (the idempotency key) ───────────────────────────────────────

/**
 * The deterministic key that identifies ONE RFQ event. The sync table has a
 * UNIQUE index on this, so a retry can never reserve a second row — and a row
 * that already carries an `odooId` is never sent to Odoo again.
 */
export function eventKey(eventType: string, sourceTable: string, sourceId: number): string {
  return `${eventType}:${sourceTable}:${sourceId}`;
}

// ─── Supplier goods receipt → vendor bill ───────────────────────────────────

export interface SupplierReceiptInput {
  receiptId: number;
  poId: number;
  internalPoNo: string;
  supplierId: number | null;
  supplierName: string;
  /** The supplier's own invoice number, when known. */
  supplierInvoiceNo?: string | null;
  receiptDate: string;
  /** Quantity accepted from the supplier. */
  acceptedQty: number;
  /** Unit cost as reported by the supplier (VAT-inclusive when taxIncluded). */
  unitCost: number;
  taxIncluded: boolean;
  /** Odoo ids resolved by the caller. */
  partnerId?: number | null;
  /** Odoo account ids resolved by the caller. */
  expenseAccountId?: number | null;
  vatAccountId?: number | null;
  withholdingAccountId?: number | null;
  payableAccountId?: number | null;
  rates?: TaxRates;
}

/**
 * A supplier goods receipt becomes a VENDOR BILL: the accepted quantity at the
 * actual unit cost, plus 14% input VAT, minus 3% withholding.
 *
 *   net   = acceptedQty × unitCost (normalised to the VAT-exclusive base)
 *   vat   = net × 14%
 *   wh    = net × 3%
 *   total = net + vat − wh
 */
export function mapSupplierReceiptToVendorBill(input: SupplierReceiptInput): OdooDocument {
  const rates = input.rates ?? DEFAULT_TAX_RATES;
  const grossLine = round2(input.acceptedQty * input.unitCost);
  const { net, vat } = vatComponents(grossLine, rates.vatRate, input.taxIncluded);
  const withholding = withholdingOn(net, rates.withholdingRate);
  const total = round2(net + vat - withholding);
  const ref = `RFQ-PO-${input.internalPoNo}-RCV-${input.receiptId}`;

  const values: Record<string, unknown> = {
    move_type: "in_invoice",
    ref: input.supplierInvoiceNo || ref,
    invoice_date: input.receiptDate,
    partner_id: input.partnerId ?? false,
    // The RFQ event key, so Odoo itself carries the link back to the event.
    payment_reference: ref,
    invoice_line_ids: [
      [
        0,
        0,
        {
          name: `استلام من المورد — ${input.supplierName} (${input.internalPoNo})`,
          quantity: input.acceptedQty,
          price_unit: round2(net / (input.acceptedQty || 1)),
          account_id: input.expenseAccountId ?? false,
          tax_ids: [],
        },
      ],
    ],
  };

  // The VAT and withholding are posted as their own lines so the balance is
  // explicit and reconciles to `total` without relying on Odoo tax defaults.
  const extraLines: unknown[] = [];
  if (vat > 0) {
    extraLines.push([
      0,
      0,
      {
        name: `ض.ق.م. مدخلات ${rates.vatRate}%`,
        quantity: 1,
        price_unit: vat,
        account_id: input.vatAccountId ?? false,
        tax_ids: [],
      },
    ]);
  }
  if (withholding > 0) {
    extraLines.push([
      0,
      0,
      {
        name: `خصم تحت حساب المورد ${rates.withholdingRate}%`,
        quantity: 1,
        price_unit: -withholding,
        account_id: input.withholdingAccountId ?? false,
        tax_ids: [],
      },
    ]);
  }
  if (extraLines.length) {
    (values.invoice_line_ids as unknown[]).push(...extraLines);
  }

  return {
    odooModel: "account.move",
    values,
    odooRef: ref,
    summary: `فاتورة مورد ${input.internalPoNo}: صافي ${net} + ض.ق.م ${vat} − خصم ${withholding} = ${total}`,
  };
}

// ─── Customer delivery → customer invoice + COGS ────────────────────────────

export interface CustomerDeliveryInput {
  deliveryId: number;
  customerPoId: number;
  internalPoNo: string;
  customerId: number | null;
  customerName: string;
  deliveryDate: string;
  deliveredQty: number;
  /** Selling unit price (VAT-exclusive). */
  unitPrice: number;
  /** Unit cost from the linked supplier receipt, for the COGS line. */
  unitCost: number;
  /** Odoo ids resolved by the caller. */
  partnerId?: number | null;
  incomeAccountId?: number | null;
  outputVatAccountId?: number | null;
  receivableAccountId?: number | null;
  cogsAccountId?: number | null;
  inventoryAccountId?: number | null;
  rates?: TaxRates;
}

/**
 * A customer delivery becomes a CUSTOMER INVOICE at the selling price plus 14%
 * output VAT, and the same event recognises the COST OF GOODS SOLD:
 *
 *   Dr AR (net + vat)   Cr Sales (net)   Cr Output VAT (vat)
 *   Dr COGS (cost)      Cr Inventory (cost)
 *
 * The invoice (`account.move`, out_invoice) carries the sale; the COGS is
 * returned as a second document so the caller can post it as a journal entry
 * against Inventory.
 */
export function mapCustomerDeliveryToInvoice(input: CustomerDeliveryInput): OdooDocument {
  const rates = input.rates ?? DEFAULT_TAX_RATES;
  const net = round2(input.deliveredQty * input.unitPrice);
  const vat = round2((net * rates.vatRate) / 100);
  const ref = `RFQ-CPO-${input.internalPoNo}-DLV-${input.deliveryId}`;

  return {
    odooModel: "account.move",
    values: {
      move_type: "out_invoice",
      ref,
      invoice_date: input.deliveryDate,
      partner_id: input.partnerId ?? false,
      payment_reference: ref,
      invoice_line_ids: [
        [
          0,
          0,
          {
            name: `تسليم للعميل — ${input.customerName} (${input.internalPoNo})`,
            quantity: input.deliveredQty,
            price_unit: input.unitPrice,
            account_id: input.incomeAccountId ?? false,
            tax_ids: [],
          },
        ],
      ],
    },
    odooRef: ref,
    summary: `فاتورة عميل ${input.internalPoNo}: صافي ${net} + ض.ق.م ${vat}`,
  };
}

/** The COGS document that accompanies a customer delivery. */
export function mapCustomerDeliveryToCogs(input: CustomerDeliveryInput): OdooDocument {
  const cost = round2(input.deliveredQty * input.unitCost);
  const ref = `RFQ-CPO-${input.internalPoNo}-COGS-${input.deliveryId}`;
  return {
    odooModel: "account.move",
    values: {
      move_type: "entry",
      ref,
      date: input.deliveryDate,
      line_ids: [
        [
          0,
          0,
          {
            name: `تكلفة البضاعة المباعة — ${input.internalPoNo}`,
            debit: cost,
            credit: 0,
            account_id: input.cogsAccountId ?? false,
          },
        ],
        [
          0,
          0,
          {
            name: `المخزون — ${input.internalPoNo}`,
            debit: 0,
            credit: cost,
            account_id: input.inventoryAccountId ?? false,
          },
        ],
      ],
    },
    odooRef: ref,
    summary: `تكلفة مبيعات ${input.internalPoNo}: ${cost}`,
  };
}

// ─── Expense → journal entry ────────────────────────────────────────────────

export interface ExpenseInput {
  expenseId: number;
  category: string;
  description?: string | null;
  expenseDate: string;
  amount: number;
  /** Odoo ids resolved by the caller. */
  expenseAccountId?: number | null;
  paymentAccountId?: number | null;
}

export function mapExpenseToJournalEntry(input: ExpenseInput): OdooDocument {
  const amount = round2(input.amount);
  const ref = `RFQ-EXP-${input.expenseId}`;
  return {
    odooModel: "account.move",
    values: {
      move_type: "entry",
      ref,
      date: input.expenseDate,
      line_ids: [
        [
          0,
          0,
          {
            name: `${input.category}${input.description ? ` — ${input.description}` : ""}`,
            debit: amount,
            credit: 0,
            account_id: input.expenseAccountId ?? false,
          },
        ],
        [
          0,
          0,
          {
            name: `دفع مصروف — ${input.category}`,
            debit: 0,
            credit: amount,
            account_id: input.paymentAccountId ?? false,
          },
        ],
      ],
    },
    odooRef: ref,
    summary: `قيد مصروف ${input.category}: ${amount}`,
  };
}

// ─── Customer payment → payment entry ───────────────────────────────────────

export interface CustomerPaymentInput {
  paymentId: number;
  customerPoId: number;
  internalPoNo: string;
  customerName: string;
  paymentDate: string;
  amount: number;
  method?: string | null;
  /** The Odoo invoice id the payment should settle, when known. */
  invoiceId?: number | null;
  /** Odoo ids resolved by the caller. */
  partnerId?: number | null;
  journalId?: number | null;
  receivableAccountId?: number | null;
}

/**
 * A customer payment becomes an Odoo PAYMENT (account.payment, inbound). When
 * the linked customer invoice is known, the payment is reconciled against it.
 */
export function mapCustomerPaymentToPayment(input: CustomerPaymentInput): OdooDocument {
  const ref = `RFQ-PAY-${input.paymentId}`;
  return {
    odooModel: "account.payment",
    values: {
      payment_type: "inbound",
      partner_type: "customer",
      partner_id: input.partnerId ?? false,
      amount: round2(input.amount),
      date: input.paymentDate,
      journal_id: input.journalId ?? false,
      ref,
      payment_reference: `${input.internalPoNo} — ${input.customerName}`,
      memo: `تحصيل من ${input.customerName} (${input.internalPoNo})`,
    },
    odooRef: ref,
    summary: `دفعة عميل ${input.internalPoNo}: ${round2(input.amount)}`,
  };
}

// ─── Cancellation / rejection → credit note ─────────────────────────────────

export interface CancellationInput {
  /** "customer" reverses an out_invoice; "supplier" reverses an in_invoice. */
  side: "customer" | "supplier";
  sourceTable: string;
  sourceId: number;
  internalPoNo: string;
  partnerName: string;
  date: string;
  qty: number;
  unitPrice: number;
  reason?: string | null;
  /** Odoo ids resolved by the caller. */
  partnerId?: number | null;
  /** The original invoice id to reverse, when known. */
  reversedMoveId?: number | null;
  incomeAccountId?: number | null;
  expenseAccountId?: number | null;
  rates?: TaxRates;
}

/**
 * A cancellation or rejection becomes a CREDIT NOTE: an out_refund against the
 * customer, or an in_refund against the supplier, for the reversed quantity.
 * VAT is reversed at the same 14% so the tax position unwinds symmetrically.
 */
export function mapCancellationToCreditNote(input: CancellationInput): OdooDocument {
  const rates = input.rates ?? DEFAULT_TAX_RATES;
  const net = round2(input.qty * input.unitPrice);
  const vat = round2((net * rates.vatRate) / 100);
  const moveType = input.side === "customer" ? "out_refund" : "in_refund";
  const ref = `RFQ-CN-${input.internalPoNo}-${input.sourceTable}-${input.sourceId}`;
  const accountId =
    input.side === "customer"
      ? (input.incomeAccountId ?? false)
      : (input.expenseAccountId ?? false);

  return {
    odooModel: "account.move",
    values: {
      move_type: moveType,
      ref,
      invoice_date: input.date,
      partner_id: input.partnerId ?? false,
      payment_reference: ref,
      ...(input.reversedMoveId ? { reversed_entry_id: input.reversedMoveId } : {}),
      invoice_line_ids: [
        [
          0,
          0,
          {
            name: `إشعار دائن${input.reason ? ` — ${input.reason}` : ""} (${input.internalPoNo})`,
            quantity: input.qty,
            price_unit: input.unitPrice,
            account_id: accountId,
            tax_ids: [],
          },
        ],
      ],
    },
    odooRef: ref,
    summary: `إشعار دائن ${input.internalPoNo}: صافي ${net} + ض.ق.م ${vat}`,
  };
}

export { ratesFrom };
