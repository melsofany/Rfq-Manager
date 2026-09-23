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
import { and, or, ilike, desc, asc, count, sql, gte, eq, inArray } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { logger } from "../../shared/logger";

/** A readable label copied onto each row from a related table. */
interface RefSpec {
  /** Foreign-key column name on this table, e.g. "supplierId". */
  column: string;
  /** Related table holder (lazy, so partial `@workspace/db` mocks still work). */
  target: () => PgTable;
  /** Target column holding the label, e.g. "name". */
  labelColumn: string;
  /** Target column holding the related row's id (defaults to "id"). */
  idColumn?: string;
  /** Field name receiving the label on the result row, e.g. "supplierName". */
  as: string;
}

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
  /**
   * Allow a purely numeric `search` to match the primary key exactly. Users ask
   * for "supplier 95" / "PO 47" using the internal id shown in the URL.
   */
  matchId?: boolean;
  /** Related-table labels appended to every row (never the raw FK alone). */
  refs?: RefSpec[];
  /**
   * Extra matcher for fields that live on OTHER rows. Returns the ids of THIS
   * table that should be included (e.g. POs whose supplier matches the term).
   */
  extraSearch?: (term: string) => Promise<number[]>;
  /** Which column receives the ids from `extraSearch` (e.g. "supplierId"). */
  extraSearchColumn?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function cols(table: PgTable): Record<string, AnyColumn> {
  return (table as any)[Symbol.for("drizzle:Columns")] ?? {};
}

/**
 * Ids of rows in `table` whose `search` columns match `term`. Used to resolve a
 * name to its foreign key before filtering the table that only stores the id.
 */
async function matchingIds(table: PgTable, searchCols: string[], term: string): Promise<number[]> {
  const columns = cols(table);
  const parts = searchCols
    .map((c) => columns[c])
    .filter(Boolean)
    .map((c) => ilike(c, `%${term}%`));
  if (!parts.length) return [];
  const rows = (await (db.select().from(table as any) as any)
    .where(or(...parts))
    .limit(200)) as Array<Record<string, unknown>>;
  return rows.map((r) => Number(r.id)).filter((n) => Number.isInteger(n));
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
        search: ["supplierId", "name", "contactPerson", "email", "phone", "address", "category"],
        matchId: true,
        description: "الموردون",
      },
      customers: {
        table: customersTable,
        search: [
          "customerId",
          "name",
          "nickname",
          "contactPerson",
          "email",
          "phone",
          "address",
          "taxId",
        ],
        matchId: true,
        description: "العملاء",
      },
      employees: {
        table: employeesTable,
        search: ["name", "email", "role", "phone"],
        sensitive: ["passwordHash"],
        matchId: true,
        description: "الموظفون",
      },
      representatives: {
        table: representativesTable,
        search: ["name", "phone"],
        matchId: true,
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
        matchId: true,
        description: "طلبات عروض الأسعار للموردين",
      },
      rfq_items: {
        table: rfqItemsTable,
        search: ["itemId", "lineItem", "partNo", "description", "uom"],
        matchId: true,
        description: "بنود طلبات عروض الأسعار",
      },
      offers: {
        table: offersTable,
        // `offers` has NO supplier name and no status column — the supplier is a
        // foreign key, resolved via `extraSearch` (searching a name against the
        // integer `supplierId` would be meaningless and would make every term
        // look "matched").
        search: ["generalNotes"],
        orderBy: "id",
        orderDir: "desc",
        matchId: true,
        refs: [
          {
            column: "supplierId",
            target: () => suppliersTable,
            labelColumn: "name",
            as: "supplierName",
          },
          { column: "rfqId", target: () => rfqTable, labelColumn: "internalRfqNo", as: "rfqNo" },
        ],
        extraSearch: (term) => matchingIds(suppliersTable, ["name", "contactPerson"], term),
        extraSearchColumn: "supplierId",
        description: "عروض الموردين",
      },
      offer_items: {
        table: offerItemsTable,
        // partNo/lineItem/description belong to rfq_items, not here.
        search: ["notes"],
        matchId: true,
        refs: [
          {
            column: "rfqItemId",
            target: () => rfqItemsTable,
            labelColumn: "description",
            as: "rfqItemDescription",
          },
          { column: "offerId", target: () => offersTable, labelColumn: "id", as: "offerRef" },
        ],
        extraSearch: (term) =>
          matchingIds(rfqItemsTable, ["partNo", "lineItem", "description"], term),
        extraSearchColumn: "rfqItemId",
        description: "بنود عروض الموردين (كل بند مرتبط ببند طلب عرض السعر)",
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
        // No supplier column on the header — the supplier lives on each line.
        search: ["internalPoNo", "sheetPoNo", "status", "receiverName", "receiverPhone", "notes"],
        orderBy: "id",
        orderDir: "desc",
        matchId: true,
        // Resolves to PO ids (this table's own key), because the match is found
        // on the line items rather than on a column here.
        extraSearchColumn: "id",
        extraSearch: async (term) => {
          // POs whose line items belong to a matching supplier.
          const supplierIds = await matchingIds(
            suppliersTable,
            ["name", "contactPerson", "email", "phone"],
            term,
          );
          if (!supplierIds.length) return [];
          const rows = (await db
            .select()
            .from(purchaseOrderItemsTable as any)
            .where(inArray(purchaseOrderItemsTable.supplierId, supplierIds))
            .limit(500)) as any as Array<Record<string, unknown>>;
          return [...new Set(rows.map((r) => Number(r.poId)).filter(Number.isInteger))];
        },
        description: "أوامر الشراء من الموردين",
      },
      purchase_order_items: {
        table: purchaseOrderItemsTable,
        search: ["partNo", "lineItem", "description", "uom", "lineStatus"],
        orderBy: "id",
        orderDir: "desc",
        refs: [
          {
            column: "supplierId",
            target: () => suppliersTable,
            labelColumn: "name",
            as: "supplierName",
          },
          {
            column: "poId",
            target: () => purchaseOrdersTable,
            labelColumn: "internalPoNo",
            as: "poNo",
          },
        ],
        extraSearch: (term) => matchingIds(suppliersTable, ["name", "contactPerson"], term),
        extraSearchColumn: "supplierId",
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

export interface QueryResult {
  rows: Record<string, unknown>[];
  /**
   * How the search was actually applied. The model MUST be told when a term
   * could not be matched, otherwise it treats arbitrary rows as its results —
   * the exact behaviour that produced "PO 37 belongs to شركة النور".
   */
  filter: {
    searched: string | null;
    /** Columns the term was matched against (across tables, hence descriptive). */
    matchedOn: string[];
    /** False when a search term was given but nothing could match on it. */
    applied: boolean;
    note: string;
  };
}

export async function queryRecords(opts: {
  table: string;
  search?: string;
  limit?: number;
  sinceDays?: number;
  orderDir?: "asc" | "desc";
}): Promise<QueryResult> {
  const spec = TABLES[opts.table];
  if (!spec) throw new Error(`Unknown table "${opts.table}"`);
  const columns = cols(spec.table);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = db.select().from(spec.table as any);
  const filters: SQL[] = [];
  const matchedOn: string[] = [];
  let applied = false;

  const term = opts.search?.trim();
  if (term) {
    // Every way the term can match is an ALTERNATIVE (OR), not a conjunction:
    // a PO matches if its own number matches OR its supplier matches. Combining
    // them with AND would reject the very rows the term was meant to find.
    const orParts: SQL[] = [];
    /** True once we have at least one way to match the term. */
    let canMatch = false;

    const direct = spec.search.filter((c) => columns[c]);
    const directParts = direct.map((c) => ilike(columns[c], `%${term}%`));
    if (directParts.length) {
      orParts.push(or(...directParts) as SQL);
      matchedOn.push(...direct.map((c) => `${opts.table}.${c}`));
      canMatch = true;
    }

    // Numeric id match — "supplier 95" / "PO 37" refer to the internal id.
    if (spec.matchId && /^\d+$/.test(term) && columns["id"]) {
      orParts.push(eq(columns["id"], Number(term)) as SQL);
      matchedOn.push(`${opts.table}.id`);
      canMatch = true;
    }

    // Fields that live on related rows (supplier name for POs, partNo for
    // offer_items). Without this the table is unsearchable by what users
    // actually type, and the term silently returns unrelated rows.
    if (spec.extraSearch && spec.extraSearchColumn && columns[spec.extraSearchColumn]) {
      canMatch = true;
      matchedOn.push(`${opts.table}.${spec.extraSearchColumn} (مرتبط)`);
      try {
        const ids = await spec.extraSearch(term);
        if (ids.length) orParts.push(inArray(columns[spec.extraSearchColumn], ids) as SQL);
      } catch (err) {
        logger.warn({ err, table: opts.table }, "AI assistant: related-table search failed");
      }
    }

    if (canMatch) {
      applied = true;
      // No branch matched: the search IS applied, it simply found nothing.
      filters.push(orParts.length ? (or(...orParts) as SQL) : (sql`1 = 0` as SQL));
    } else {
      // No column on this table can match the term. Returning the newest rows
      // here is the bug that made the model present unrelated records as
      // search results; force an empty set and let the note say why.
      filters.push(sql`1 = 0` as SQL);
    }
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

  const rawRows = (await q.limit(limit)) as Record<string, unknown>[];
  const sensitive = new Set((spec.sensitive ?? []).map(camel));

  const rows: Record<string, unknown>[] = [];
  for (const row of rawRows) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (sensitive.has(k)) continue;
      out[k] = v instanceof Date ? v.toISOString() : v;
    }
    await applyRefs(spec, out);
    rows.push(out);
  }

  const searched = term ?? null;
  let note: string;
  if (!searched) {
    note = `لا يوجد بحث — تُعرض أحدث السجلات في «${spec.description}».`;
  } else if (applied) {
    note = `تمت المطابقة على: ${matchedOn.join(", ")}.`;
  } else {
    note =
      `تعذّرت مطابقة «${searched}» في «${spec.description}» (لا توجد أعمدة قابلة للبحث لهذا الحقل). ` +
      `النتائج المعروضة غير مفلترة — لا تعتبرها إجابة على البحث.`;
  }

  return {
    rows,
    filter: { searched, matchedOn, applied: !searched || applied, note },
  };
}

/**
 * Copy human-readable labels onto a row for its foreign keys. A row that shows
 * only `supplierId: 146` invites the model to invent a name; attaching
 * `supplierName` removes the guesswork entirely.
 */
async function applyRefs(spec: TableSpec, row: Record<string, unknown>): Promise<void> {
  for (const ref of spec.refs ?? []) {
    const fk = row[ref.column];
    if (fk == null) continue;
    try {
      const target = ref.target();
      const tcols = cols(target);
      const idCol = tcols[ref.idColumn ?? "id"];
      const labelCol = tcols[ref.labelColumn];
      if (!idCol || !labelCol) continue;
      const found = (await db
        .select()
        .from(target as any)
        .where(eq(idCol, fk as never))
        .limit(1)) as any as Array<Record<string, unknown>>;
      if (found[0]) row[ref.as] = found[0][ref.labelColumn];
    } catch (err) {
      logger.warn({ err, ref: ref.as }, "AI assistant: resolving related label failed");
    }
  }
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

/** One entity's name, as known by the database. */
export interface EntityName {
  name: string;
  /** Internal id, so the model can follow up with the number it saw. */
  id: number | null;
}

/**
 * The real list of supplier and customer names, read straight from the database.
 *
 * This is the difference between a plausible text and a verified one. Given only
 * a question, the model writes whatever name it imagines and the answer LOOKS
 * right (the recorded «هاي فولت» incident: real rows were read as the match and
 * invented names filled the gaps). With the actual vocabulary in context it can
 * tell that «شركة النور» is not a supplier at all, without spending one of the
 * 20 daily requests/model to discover that.
 *
 * Deliberately bounded: two indexed-ish `ilike`-free selects limited to the
 * table's own name column, cached for a short TTL because the list changes
 * slowly while every message would otherwise re-read it. Returns empty arrays on
 * failure so a database hiccup degrades to "no vocabulary" rather than blocking
 * the answer.
 */
const ENTITY_TTL_MS = 10 * 60 * 1000;
let entityCache: { at: number; suppliers: EntityName[]; customers: EntityName[] } | null = null;

export async function entityVocabulary(
  limit = 400,
): Promise<{ suppliers: EntityName[]; customers: EntityName[] }> {
  if (entityCache && Date.now() - entityCache.at < ENTITY_TTL_MS) {
    return { suppliers: entityCache.suppliers, customers: entityCache.customers };
  }
  const read = async (table: PgTable): Promise<EntityName[]> => {
    try {
      const nameCol = cols(table)["name"];
      if (!nameCol) return [];
      // Selected in the same loose style the rest of this registry uses; the
      // drizzle generics on a variable `PgTable` are not worth fighting here.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (await db
        .select()
        .from(table as any)
        .limit(limit)) as Array<Record<string, unknown>>;
      return rows
        .map((r) => {
          const id = Number(r.id);
          return {
            id: Number.isInteger(id) ? id : null,
            name: String(r.name ?? "").trim(),
          };
        })
        .filter((r) => r.name);
    } catch (err) {
      logger.warn({ err }, "AI assistant: entity vocabulary read failed");
      return [];
    }
  };
  const [suppliers, customers] = await Promise.all([read(suppliersTable), read(customersTable)]);
  entityCache = { at: Date.now(), suppliers, customers };
  return { suppliers, customers };
}

/** Test seam: drop the cached vocabulary so a case starts from a known list. */
export function resetEntityVocabulary(): void {
  entityCache = null;
}

/**
 * Names mentioned in text that are NOT in the known list.
 *
 * Deliberately NARROW. The failure being fixed is an invented COMPANY name
 * («شركة النور» / «الشركة المصرية»), so only a word run carrying an explicit
 * company marker (شركة / مؤسسة / للتوريدات / company / ltd …) is considered.
 * Flagging any multi-word Arabic run would fire on ordinary prose («الطلب
 * موجود») and make the assistant "correct" a name it got right — a worse failure
 * than the one being fixed. A run is unknown only when it shares NO token with
 * any known entity, so a correct short form («شركة الأمل» for «شركة الأمل
 * للتوريدات») stays accepted. Arabic is normalised (alef/hamza, taa marbuta,
 * yaa, harakat, tatweel) so spelling variants agree.
 */
export function findUnknownEntityNames(
  answer: string,
  known: { suppliers: EntityName[]; customers: EntityName[] },
): string[] {
  const names = [...known.suppliers, ...known.customers].map((e) => e.name).filter(Boolean);
  if (!names.length || !answer) return [];

  const fold = (s: string) =>
    (s ?? "")
      .replace(/[\u064B-\u0652\u0640]/g, "")
      .replace(/[أإآٱ]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/ة/g, "ه")
      .toLowerCase()
      .trim();

  const tokensOf = (s: string) =>
    fold(s)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);

  // Words that mark the START of a company name. Only company-FORM words belong
  // here — «شركة» / «مؤسسة» / «company». Suffix words like «للتوريدات» are part
  // of a name («شركة الأمل للتوريدات»), so listing them would truncate the name
  // at the suffix and check only «شركة الأمل».
  const MARKERS = new Set([
    "شركه",
    "مؤسسه",
    "company",
    "co",
    "corp",
    "corporation",
    "ltd",
    "llc",
    "inc",
    "group",
    "trading",
  ]);
  /**
   * The bare marker form of a word, or null when it is not a company marker.
   *
   * Arabic glues short prefixes to the following word («بشركة» = «ب» + «شركة»),
   * so each candidate prefix is stripped before folding and checking the
   * markers. Folding happens AFTER stripping because folding rewrites letters
   * the prefix may itself start with. The word returned keeps the ORIGINAL
   * spelling minus the prefix, so the model is handed «شركة» not the folded «شركه».
   */
  function bareMarkerWord(word: string): string | null {
    if (MARKERS.has(fold(word))) return word;
    for (const p of ["ال", "و", "ف", "ب", "ك", "ل"]) {
      if (!word.startsWith(p)) continue;
      const rest = word.slice(p.length);
      if (MARKERS.has(fold(rest))) return rest;
    }
    return null;
  }

  /**
   * True for words that carry no distinguishing information about which company
   * is meant: the company FORM itself («شركة», «co») and the descriptive
   * "for-the-X" suffix Arabic business names share («للتوريدات» = for supply).
   *
   * This matters for the share-a-token test below. «مؤسسة الدلتا للتوريدات» and
   * the real «شركة الأمل للتوريدات» share «للتوريدات», but that says nothing
   * about identity — only «الدلتا» vs «الأمل» does. Counting a shared suffix as
   * a match would accept every invented name whose suffix looks familiar.
   */
  const ignorable = (t: string) => MARKERS.has(fold(t)) || /^لل/.test(fold(t));

  const knownTokens = new Set<string>();
  const foldedKnown: string[] = [];
  for (const n of names) {
    foldedKnown.push(fold(n));
    for (const t of tokensOf(n)) if (!ignorable(t)) knownTokens.add(t);
  }

  // Scan the answer word by word. A candidate name STARTS at a company marker
  // and runs to the next punctuation/marker — anchoring on the marker instead of
  // on sentence boundaries avoids truncating a name that appears mid-sentence
  // («... خاص بشركة النور» must yield «شركة النور», not just «شركة»).
  const words = answer.split(/\s+/);
  const unknown: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const marker = bareMarkerWord(words[i].replace(/^[^\p{L}\p{N}]+/u, ""));
    if (!marker) continue;
    const parts = [marker];
    for (let j = i + 1; j < words.length && parts.length <= 4; j++) {
      const clean = words[j].replace(/[^\p{L}\p{N}]+$/u, "");
      if (!clean || bareMarkerWord(clean)) break;
      parts.push(clean);
    }
    // A bare marker with no name word («الشركة المصرية للحفر» alone is «شركة»)
    // carries no entity to check — skip it rather than flag the generic word.
    if (parts.length < 2) continue;
    const candidate = parts.join(" ");
    const f = fold(candidate);
    // Accept when a known name contains this run or vice versa (short form).
    if (foldedKnown.some((k) => k.includes(f) || f.includes(k))) continue;
    // Accept when any distinguishing token is part of the known vocabulary.
    if (tokensOf(candidate).some((t) => knownTokens.has(t))) continue;
    if (!unknown.includes(candidate)) unknown.push(candidate);
  }
  return unknown;
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
