/**
 * AI Assistant — read-only database access.
 *
 * Instead of hand-writing one query per table, the assistant gets a single
 * whitelisted `queryRecords` tool: a table is looked up in TABLES (so the model
 * can never name an arbitrary relation) and the search is a parameterised
 * `ilike` across the table's text columns. Everything is read-only.
 *
 * `sensitiveColumns` are stripped from results before they reach the model.
 */
import {
  db,
  suppliersTable,
  customersTable,
  employeesTable,
  representativesTable,
  rfqTable,
  rfqItemsTable,
  offersTable,
  offerItemsTable,
  customerRfqsTable,
  customerRfqItemsTable,
  customerPosTable,
  customerPoItemsTable,
  purchaseOrdersTable,
  purchaseOrderItemsTable,
  poItemReceiptsTable,
  customerPoItemDeliveriesTable,
  poItemChargesTable,
  operatingExpensesTable,
  customerPoCollectionsTable,
  customerPoPaymentsTable,
  workOrderAssignmentsTable,
  whatsappChatsTable,
  auditLogTable,
  salesInvoicesTable,
  supplierInvoicesTable,
  journalEntriesTable,
  journalLinesTable,
  chartOfAccountsTable,
  dataEntrySessionsTable,
} from "@workspace/db";
import { and, or, ilike, desc, asc, count, sql, gte, eq } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { logger } from "../../shared/logger";

interface TableSpec {
  table: PgTable;
  /** Text columns searched by the `search` argument. */
  search: string[];
  /** Columns removed from the result rows. */
  sensitive?: string[];
  /** Default ordering column. */
  orderBy?: string;
  orderDir?: "asc" | "desc";
  description: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function cols(table: PgTable): Record<string, AnyColumn> {
  return (table as any)[Symbol.for("drizzle:Columns")] ?? {};
}

/**
 * The table registry is built lazily: constructing it at module load would
 * dereference every `@workspace/db` table binding immediately, which breaks the
 * route-level test suites that partially mock `@workspace/db`.
 */
let _tables: Record<string, TableSpec> | undefined;

export function getTables(): Record<string, TableSpec> {
  if (!_tables) {
    _tables = {
      suppliers: {
        table: suppliersTable,
        search: ["name", "contactPerson", "email", "phone", "address", "category"],
        description: "الموردون",
      },
      customers: {
        table: customersTable,
        search: ["name", "nickname", "contactPerson", "email", "phone", "address", "taxId"],
        description: "العملاء",
      },
      employees: {
        table: employeesTable,
        search: ["name", "email", "role", "phone"],
        sensitive: ["passwordHash"],
        description: "الموظفون",
      },
      representatives: {
        table: representativesTable,
        search: ["name", "phone"],
        description: "المندوبون",
      },
      customer_rfqs: {
        table: customerRfqsTable,
        search: ["internalNo", "customerName", "customerRfqNo", "buyerName", "status", "notes"],
        orderBy: "id",
        orderDir: "desc",
        description: "طلبات تسعير العملاء",
      },
      customer_rfq_items: {
        table: customerRfqItemsTable,
        search: ["partNo", "lineItem", "description", "uom"],
        description: "بنود طلبات تسعير العملاء",
      },
      rfqs: {
        table: rfqTable,
        search: ["internalRfqNo", "customerRfqNo", "status"],
        orderBy: "id",
        orderDir: "desc",
        description: "طلبات عروض الأسعار للموردين",
      },
      rfq_items: {
        table: rfqItemsTable,
        search: ["itemId", "lineItem", "partNo", "description", "uom"],
        description: "بنود طلبات عروض الأسعار",
      },
      offers: {
        table: offersTable,
        search: ["supplierName", "status"],
        description: "عروض الموردين",
      },
      offer_items: {
        table: offerItemsTable,
        search: ["partNo", "lineItem", "description"],
        description: "بنود عروض الموردين",
      },
      customer_pos: {
        table: customerPosTable,
        search: ["internalPoNo", "customerPoNo", "customerName", "buyerName", "status", "notes"],
        orderBy: "id",
        orderDir: "desc",
        description: "أوامر شراء العملاء",
      },
      customer_po_items: {
        table: customerPoItemsTable,
        search: ["partNo", "lineItem", "description", "uom", "deliveryStatus"],
        description: "بنود أوامر شراء العملاء",
      },
      purchase_orders: {
        table: purchaseOrdersTable,
        search: ["internalPoNo", "sheetPoNo", "supplierName", "status"],
        orderBy: "id",
        orderDir: "desc",
        description: "أوامر الشراء من الموردين",
      },
      purchase_order_items: {
        table: purchaseOrderItemsTable,
        search: ["partNo", "lineItem", "description", "uom", "lineStatus"],
        description: "بنود أوامر الشراء من الموردين",
      },
      po_item_receipts: {
        table: poItemReceiptsTable,
        search: ["receiptStatus", "rejectionReason", "receivedBy"],
        description: "استلام التوريدات",
      },
      customer_po_item_deliveries: {
        table: customerPoItemDeliveriesTable,
        search: ["deliveryStatus", "deliveredBy"],
        description: "تسليم العملاء",
      },
      po_item_charges: {
        table: poItemChargesTable,
        search: ["chargeType", "description"],
        description: "تكاليف بنود أوامر الشراء",
      },
      operating_expenses: {
        table: operatingExpensesTable,
        search: ["category", "description", "notes", "employeeName"],
        description: "المصروفات التشغيلية",
      },
      collections: {
        table: customerPoCollectionsTable,
        search: ["notes"],
        description: "شروط التحصيل لكل أمر شراء عميل",
      },
      customer_po_payments: {
        table: customerPoPaymentsTable,
        search: ["method", "reference", "notes"],
        description: "مدفوعات العملاء",
      },
      work_order_assignments: {
        table: workOrderAssignmentsTable,
        search: ["representativeName", "representativePhone", "status", "kind"],
        description: "تكليفات المندوبين",
      },
      whatsapp_chats: {
        table: whatsappChatsTable,
        search: ["phone", "body", "contactName", "direction"],
        orderBy: "id",
        orderDir: "desc",
        description: "محادثات واتساب",
      },
      audit_log: {
        table: auditLogTable,
        search: ["action", "entityType", "description"],
        orderBy: "id",
        orderDir: "desc",
        description: "سجل المراجعة",
      },
      sales_invoices: {
        table: salesInvoicesTable,
        search: ["invoiceNo", "customerName", "status", "customerPoNo"],
        orderBy: "id",
        orderDir: "desc",
        description: "فواتير البيع",
      },
      supplier_invoices: {
        table: supplierInvoicesTable,
        search: ["invoiceNo", "supplierName", "status"],
        orderBy: "id",
        orderDir: "desc",
        description: "فواتير الموردين",
      },
      journal_entries: {
        table: journalEntriesTable,
        search: ["entryNo", "description", "source", "status"],
        orderBy: "id",
        orderDir: "desc",
        description: "قيود اليومية",
      },
      journal_lines: {
        table: journalLinesTable,
        search: ["accountCode", "description"],
        description: "سطور قيود اليومية",
      },
      chart_of_accounts: {
        table: chartOfAccountsTable,
        search: ["code", "nameAr", "nameEn", "type"],
        description: "دليل الحسابات",
      },
      data_entry_sessions: {
        table: dataEntrySessionsTable,
        search: ["type"],
        orderBy: "id",
        orderDir: "desc",
        description: "جلسات إدخال البيانات",
      },
    };
  }
  return _tables;
}

/** Table registry as a lazy proxy so `TABLES.suppliers` still reads naturally. */
export const TABLES: Record<string, TableSpec> = new Proxy({} as Record<string, TableSpec>, {
  get(_t, prop) {
    return getTables()[prop as string];
  },
  has(_t, prop) {
    return prop in getTables();
  },
  ownKeys() {
    return Reflect.ownKeys(getTables());
  },
  getOwnPropertyDescriptor(_t, prop) {
    return Object.getOwnPropertyDescriptor(getTables(), prop);
  },
});

export function tableListForPrompt(): string {
  return Object.entries(getTables())
    .map(([name, spec]) => `- ${name} (${spec.description})`)
    .join("\n");
}

function camel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export async function queryRecords(opts: {
  table: string;
  search?: string;
  limit?: number;
  sinceDays?: number;
  orderDir?: "asc" | "desc";
}): Promise<Record<string, unknown>[]> {
  const spec = TABLES[opts.table];
  if (!spec) throw new Error(`Unknown table "${opts.table}"`);
  const columns = cols(spec.table);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = db.select().from(spec.table as any);
  const filters: SQL[] = [];

  if (opts.search && opts.search.trim()) {
    const term = `%${opts.search.trim()}%`;
    const parts = spec.search
      .map((c) => columns[c])
      .filter(Boolean)
      .map((c) => ilike(c, term));
    if (parts.length) filters.push(or(...parts) as SQL);
  }

  if (opts.sinceDays && columns["createdAt"]) {
    const since = new Date(Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000);
    filters.push(gte(columns["createdAt"], since) as SQL);
  }

  if (filters.length) q = q.where(and(...filters));

  const orderCol = columns[spec.orderBy ?? "id"] ?? columns["id"];
  if (orderCol) {
    const dir = opts.orderDir ?? spec.orderDir ?? "desc";
    q = q.orderBy(dir === "asc" ? asc(orderCol) : desc(orderCol));
  }

  const rows = (await q.limit(limit)) as Record<string, unknown>[];
  const sensitive = new Set((spec.sensitive ?? []).map(camel));
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (sensitive.has(k)) continue;
      if (v instanceof Date) out[k] = v.toISOString();
      else out[k] = v;
    }
    return out;
  });
}

/** Row count, optionally for recent rows only. */
export async function countRecords(opts: { table: string; sinceDays?: number }): Promise<number> {
  const spec = TABLES[opts.table];
  if (!spec) throw new Error(`Unknown table "${opts.table}"`);
  const columns = cols(spec.table);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = db.select({ cnt: count() }).from(spec.table as any);
  if (opts.sinceDays && columns["createdAt"]) {
    const since = new Date(Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000);
    q = q.where(gte(columns["createdAt"], since));
  }
  const [row] = (await q) as Array<{ cnt: number }>;
  return Number(row?.cnt ?? 0);
}

/** A broad one-shot snapshot: row counts across every module. */
export async function systemSnapshot(): Promise<Record<string, number>> {
  const names = Object.keys(TABLES);
  const results = await Promise.all(
    names.map(async (name) => {
      try {
        return [name, await countRecords({ table: name })] as const;
      } catch (err) {
        logger.warn({ err, table: name }, "AI assistant: snapshot count failed");
        return [name, -1] as const;
      }
    }),
  );
  return Object.fromEntries(results);
}

/**
 * Exact-match lookup helper used by the high-level tools (PO numbers etc.).
 */
export async function findWhere(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  filters: SQL[],
  limit = 20,
  orderCol?: AnyColumn,
): Promise<Record<string, unknown>[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = db.select().from(table);
  if (filters.length) q = q.where(and(...filters));
  if (orderCol) q = q.orderBy(desc(orderCol));
  const rows = (await q.limit(limit)) as Record<string, unknown>[];
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === "passwordHash") continue;
      out[k] = v instanceof Date ? v.toISOString() : v;
    }
    return out;
  });
}

export { eq, ilike, sql };
