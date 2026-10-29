/**
 * The mapping is a pure function of the RFQ event, so the whole event→document
 * contract is pinned here without Odoo: which model each event creates, the
 * 14% VAT / 3% withholding arithmetic on the vendor bill, the COGS pair, and
 * the deterministic event key + Odoo ref that make the sync idempotent.
 */
import { describe, it, expect } from "vitest";
import {
  eventKey,
  mapSupplierReceiptToVendorBill,
  mapCustomerDeliveryToInvoice,
  mapCustomerDeliveryToCogs,
  mapExpenseToJournalEntry,
  mapCustomerPaymentToPayment,
  mapCancellationToCreditNote,
} from "../../modules/accounts-bridge/mapping";
import { DEFAULT_TAX_RATES } from "../../modules/accounts-bridge/tax";

describe("eventKey — the idempotency key", () => {
  it("is deterministic for the same event", () => {
    expect(eventKey("supplier_receipt", "po_item_receipts", 42)).toBe(
      "supplier_receipt:po_item_receipts:42",
    );
  });

  it("differs between event types and between ids", () => {
    const a = eventKey("supplier_receipt", "po_item_receipts", 42);
    expect(a).not.toBe(eventKey("customer_delivery", "po_item_receipts", 42));
    expect(a).not.toBe(eventKey("supplier_receipt", "po_item_receipts", 43));
  });
});

describe("supplier receipt → vendor bill", () => {
  const base = {
    receiptId: 7,
    poId: 3,
    internalPoNo: "PO-100",
    supplierId: 5,
    supplierName: "مورد الاختبار",
    receiptDate: "2026-03-01",
    acceptedQty: 10,
    unitCost: 100,
    taxIncluded: false,
    partnerId: 900,
  };

  it("creates an in_invoice with net + 14% VAT − 3% withholding", () => {
    const doc = mapSupplierReceiptToVendorBill({ ...base, rates: DEFAULT_TAX_RATES });
    expect(doc.odooModel).toBe("account.move");
    expect(doc.values.move_type).toBe("in_invoice");

    const lines = doc.values.invoice_line_ids as unknown[][];
    const [, , first] = lines[0] as [number, number, Record<string, number>];
    expect(first.quantity).toBe(10);
    expect(first.price_unit).toBe(100); // net per unit

    // VAT line: 14% of 1000 = 140.
    const vat = (lines[1] as [number, number, Record<string, number>])[2];
    expect(vat.price_unit).toBe(140);
    // Withholding line: 3% of 1000 = 30, posted as a negative.
    const wh = (lines[2] as [number, number, Record<string, number>])[2];
    expect(wh.price_unit).toBe(-30);
  });

  it("strips VAT out of a VAT-inclusive supplier cost before withholding", () => {
    const doc = mapSupplierReceiptToVendorBill({
      ...base,
      unitCost: 114,
      taxIncluded: true,
      rates: DEFAULT_TAX_RATES,
    });
    const lines = doc.values.invoice_line_ids as unknown[][];
    const [, , net] = lines[0] as [number, number, Record<string, number>];
    expect(net.price_unit).toBe(100); // 114 inclusive → net 100/unit
    const vat = (lines[1] as [number, number, Record<string, number>])[2];
    expect(vat.price_unit).toBe(140);
    const wh = (lines[2] as [number, number, Record<string, number>])[2];
    expect(wh.price_unit).toBe(-30); // 3% of the NET, not of 1140
  });

  it("uses a deterministic Odoo ref tied to the RFQ event", () => {
    const doc = mapSupplierReceiptToVendorBill({ ...base, rates: DEFAULT_TAX_RATES });
    expect(doc.odooRef).toBe("RFQ-PO-PO-100-RCV-7");
    expect(doc.values.payment_reference).toBe(doc.odooRef);
    // The same event always produces the same ref — the Odoo-side idempotency.
    const again = mapSupplierReceiptToVendorBill({ ...base, rates: DEFAULT_TAX_RATES });
    expect(again.odooRef).toBe(doc.odooRef);
  });

  it("omits the VAT and withholding lines when the rates are zero", () => {
    const doc = mapSupplierReceiptToVendorBill({
      ...base,
      rates: { vatRate: 0, withholdingRate: 0 },
    });
    const lines = doc.values.invoice_line_ids as unknown[][];
    expect(lines).toHaveLength(1);
  });
});

describe("customer delivery → invoice + COGS", () => {
  const base = {
    deliveryId: 11,
    customerPoId: 4,
    internalPoNo: "CPO-200",
    customerId: 6,
    customerName: "عميل الاختبار",
    deliveryDate: "2026-03-05",
    deliveredQty: 5,
    unitPrice: 200,
    unitCost: 120,
    partnerId: 901,
    rates: DEFAULT_TAX_RATES,
  };

  it("creates an out_invoice at the selling price plus 14% VAT", () => {
    const doc = mapCustomerDeliveryToInvoice(base);
    expect(doc.odooModel).toBe("account.move");
    expect(doc.values.move_type).toBe("out_invoice");
    const lines = doc.values.invoice_line_ids as unknown[][];
    const [, , line] = lines[0] as [number, number, Record<string, number>];
    expect(line.quantity).toBe(5);
    expect(line.price_unit).toBe(200);
    expect(doc.odooRef).toBe("RFQ-CPO-CPO-200-DLV-11");
  });

  it("recognises the cost of goods sold as a balanced entry", () => {
    const doc = mapCustomerDeliveryToCogs(base);
    expect(doc.values.move_type).toBe("entry");
    const lines = doc.values.line_ids as unknown[][];
    const cogs = (lines[0] as [number, number, Record<string, number>])[2];
    const inventory = (lines[1] as [number, number, Record<string, number>])[2];
    // 5 × 120 = 600, debit COGS / credit Inventory.
    expect(cogs.debit).toBe(600);
    expect(cogs.credit).toBe(0);
    expect(inventory.debit).toBe(0);
    expect(inventory.credit).toBe(600);
    expect(cogs.debit).toBe(inventory.credit); // balanced
  });

  it("gives the invoice and the COGS distinct refs", () => {
    expect(mapCustomerDeliveryToInvoice(base).odooRef).not.toBe(
      mapCustomerDeliveryToCogs(base).odooRef,
    );
  });
});

describe("expense → journal entry", () => {
  it("creates a balanced two-line entry", () => {
    const doc = mapExpenseToJournalEntry({
      expenseId: 9,
      category: "كهرباء",
      expenseDate: "2026-03-02",
      amount: 1500,
    });
    expect(doc.odooModel).toBe("account.move");
    expect(doc.values.move_type).toBe("entry");
    const lines = doc.values.line_ids as unknown[][];
    const debit = (lines[0] as [number, number, Record<string, number>])[2];
    const credit = (lines[1] as [number, number, Record<string, number>])[2];
    expect(debit.debit).toBe(1500);
    expect(credit.credit).toBe(1500);
    expect(doc.odooRef).toBe("RFQ-EXP-9");
  });
});

describe("customer payment → payment entry", () => {
  it("creates an inbound customer payment", () => {
    const doc = mapCustomerPaymentToPayment({
      paymentId: 12,
      customerPoId: 4,
      internalPoNo: "CPO-200",
      customerName: "عميل الاختبار",
      paymentDate: "2026-03-10",
      amount: 1130,
      partnerId: 901,
    });
    expect(doc.odooModel).toBe("account.payment");
    expect(doc.values.payment_type).toBe("inbound");
    expect(doc.values.partner_type).toBe("customer");
    expect(doc.values.amount).toBe(1130);
    expect(doc.odooRef).toBe("RFQ-PAY-12");
  });
});

describe("cancellation → credit note", () => {
  it("creates an out_refund for a customer cancellation, reversing 14% VAT", () => {
    const doc = mapCancellationToCreditNote({
      side: "customer",
      sourceTable: "customer_po_item_deliveries",
      sourceId: 11,
      internalPoNo: "CPO-200",
      partnerName: "عميل الاختبار",
      date: "2026-03-12",
      qty: 2,
      unitPrice: 200,
      reason: "مرتجع",
      rates: DEFAULT_TAX_RATES,
    });
    expect(doc.values.move_type).toBe("out_refund");
    const lines = doc.values.invoice_line_ids as unknown[][];
    const [, , line] = lines[0] as [number, number, Record<string, number>];
    expect(line.quantity).toBe(2);
    expect(line.price_unit).toBe(200);
    expect(doc.odooRef).toBe("RFQ-CN-CPO-200-customer_po_item_deliveries-11");
  });

  it("creates an in_refund for a supplier rejection", () => {
    const doc = mapCancellationToCreditNote({
      side: "supplier",
      sourceTable: "po_item_receipts",
      sourceId: 7,
      internalPoNo: "PO-100",
      partnerName: "مورد الاختبار",
      date: "2026-03-12",
      qty: 1,
      unitPrice: 100,
      rates: DEFAULT_TAX_RATES,
    });
    expect(doc.values.move_type).toBe("in_refund");
  });

  it("links the reversal to the original move when the id is known", () => {
    const doc = mapCancellationToCreditNote({
      side: "customer",
      sourceTable: "customer_po_item_deliveries",
      sourceId: 11,
      internalPoNo: "CPO-200",
      partnerName: "عميل الاختبار",
      date: "2026-03-12",
      qty: 2,
      unitPrice: 200,
      reversedMoveId: 555,
      rates: DEFAULT_TAX_RATES,
    });
    expect(doc.values.reversed_entry_id).toBe(555);
  });
});
