/**
 * AI Assistant — tool registry.
 *
 * Every capability the WhatsApp agent may invoke, with its JSON-schema
 * definition and an executor. Read-only over the database; the only writes are
 * an outbound email and generated PDFs/files, both gated by settings.
 */
import {
  db,
  purchaseOrdersTable,
  purchaseOrderItemsTable,
  poItemReceiptsTable,
  customerPosTable,
  customerPoItemsTable,
  customerPoItemDeliveriesTable,
  customerPoCollectionsTable,
  customerPoPaymentsTable,
  rfqTable,
  rfqItemsTable,
  offersTable,
  offerItemsTable,
  customerRfqsTable,
  customerRfqItemsTable,
  salesInvoicesTable,
  supplierInvoicesTable,
  suppliersTable,
} from "@workspace/db";
import { and, or, ilike, eq as _eq, desc } from "drizzle-orm";
import type { SQL, AnyColumn } from "drizzle-orm";
import {
  TABLES,
  queryRecords,
  countRecords,
  systemSnapshot,
  findWhere,
  tableListForPrompt,
} from "./db-tools";
import { searchEmails, readEmail, sendAssistantEmail, isEmailReadConfigured } from "./email";
import { generateAssistantPdf, type PdfSection } from "./pdf";
import type { ToolDefinition } from "./llm";
import type { AiSettings } from "./config";

export interface OutboxAttachment {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export interface ToolContext {
  settings: AiSettings;
  phone: string;
  outbox: OutboxAttachment[];
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

const asText = (data: unknown): string => {
  try {
    return JSON.stringify(data, null, 1).slice(0, 12_000);
  } catch {
    return String(data);
  }
};

export function toolDefinitions(ctx: ToolContext): ToolDefinition[] {
  const defs: ToolDefinition[] = [
    {
      type: "function",
      function: {
        name: "search_database",
        description:
          "بحث في أي جدول داخل النظام باستخدام كلمة مفتاحية. يرجع أحدث السجلات المطابقة. " +
          "استخدم الأرقام أو الأسماء (مثل رقم أمر شراء، اسم عميل، اسم مورد) للبحث. " +
          "الجداول المتاحة:\n" +
          tableListForPrompt(),
        parameters: {
          type: "object",
          properties: {
            table: { type: "string", description: "اسم الجدول من القائمة" },
            search: { type: "string", description: "كلمة البحث (رقم/اسم/وصف)" },
            limit: { type: "integer", description: "عدد النتائج (افتراضي 20، أقصى 100)" },
            sinceDays: { type: "integer", description: "أحدث السجلات خلال عدد أيام" },
            orderDir: { type: "string", enum: ["asc", "desc"] },
          },
          required: ["table"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "count_database",
        description: "عدّ السجلات في جدول (اختياريًا خلال آخر عدد أيام).",
        parameters: {
          type: "object",
          properties: {
            table: { type: "string" },
            sinceDays: { type: "integer" },
          },
          required: ["table"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "system_overview",
        description: "نظرة شاملة: عدد السجلات في كل جداول النظام (طلبات، أوامر، فواتير، إلخ).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "lookup_document",
        description:
          "جلب مستند كامل بكل تفاصيله عبر رقمه: أمر شراء مورد، أمر شراء عميل، طلب عرض سعر، " +
          "طلب تسعير عميل، فاتورة بيع، أو فاتورة مورد.",
        parameters: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [
                "supplier_po",
                "customer_po",
                "rfq",
                "customer_rfq",
                "sales_invoice",
                "supplier_invoice",
              ],
            },
            number: { type: "string", description: "الرقم الداخلي أو رقم العميل/المورد" },
          },
          required: ["type", "number"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_emails",
        description:
          "البحث في بريد الشركة الوارد (آخر رسائل، حسب المُرسل/الموضوع/النص). " +
          "يرجع قائمة بالرسائل مع معرّف UID لقراءتها بالتفصيل.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "كلمة في الموضوع أو النص" },
            from: { type: "string", description: "بريد المُرسل" },
            sinceDays: { type: "integer", description: "خلال آخر عدد أيام (افتراضي 14)" },
            limit: { type: "integer" },
            unseenOnly: { type: "boolean", description: "غير المقروءة فقط" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_email",
        description: "قراءة نص رسالة بريد كاملة عبر UID (من نتيجة search_emails).",
        parameters: {
          type: "object",
          properties: { uid: { type: "integer" } },
          required: ["uid"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "send_email",
        description: "إرسال بريد إلكتروني من حساب الشركة.",
        parameters: {
          type: "object",
          properties: {
            to: { type: "string" },
            subject: { type: "string" },
            body: { type: "string" },
            cc: { type: "string" },
          },
          required: ["to", "subject", "body"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "generate_pdf",
        description:
          "إنشاء ملف PDF بالعربية وإرساله للمستخدم على واتساب. استخدمه عندما يطلب المستخدم تقريرًا " +
          "أو مستندًا أو ملخصًا في ملف PDF.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            subtitle: { type: "string" },
            sections: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  heading: { type: "string" },
                  paragraphs: { type: "array", items: { type: "string" } },
                  table: {
                    type: "object",
                    properties: {
                      columns: { type: "array", items: { type: "string" } },
                      rows: { type: "array", items: { type: "array", items: { type: "string" } } },
                    },
                    required: ["columns", "rows"],
                  },
                },
              },
            },
            filename: { type: "string", description: "اسم الملف بدون امتداد" },
          },
          required: ["title", "sections"],
        },
      },
    },
  ];

  if (!isEmailReadConfigured) {
    return defs.filter((d) => d.function.name !== "read_email");
  }
  return defs;
}

async function lookupDocument(type: string, number: string): Promise<unknown> {
  const term = `%${number.trim()}%`;
  const byNumber = (cols: AnyColumn[]) => or(...cols.map((c) => ilike(c, term))) as SQL;

  switch (type) {
    case "supplier_po": {
      const [po] = await findWhere(
        purchaseOrdersTable,
        [byNumber([purchaseOrdersTable.internalPoNo, purchaseOrdersTable.sheetPoNo])],
        1,
        purchaseOrdersTable.id,
      );
      if (!po) return { found: false };
      const items = await findWhere(purchaseOrderItemsTable, [
        _eq(purchaseOrderItemsTable.poId, po.id as number),
      ]);
      const receipts = await findWhere(poItemReceiptsTable, [
        _eq(poItemReceiptsTable.poId, po.id as number),
      ]);
      return { found: true, po, items, receipts };
    }
    case "customer_po": {
      const [po] = await findWhere(
        customerPosTable,
        [byNumber([customerPosTable.internalPoNo, customerPosTable.customerPoNo])],
        1,
        customerPosTable.id,
      );
      if (!po) return { found: false };
      const items = await findWhere(customerPoItemsTable, [
        _eq(customerPoItemsTable.customerPoId, po.id as number),
      ]);
      const deliveries = await findWhere(customerPoItemDeliveriesTable, [
        _eq(customerPoItemDeliveriesTable.customerPoId, po.id as number),
      ]);
      const [collection] = await findWhere(customerPoCollectionsTable, [
        _eq(customerPoCollectionsTable.customerPoId, po.id as number),
      ]);
      const payments = await findWhere(customerPoPaymentsTable, [
        _eq(customerPoPaymentsTable.customerPoId, po.id as number),
      ]);
      return { found: true, po, items, deliveries, collection, payments };
    }
    case "rfq": {
      const [rfq] = await findWhere(rfqTable, [byNumber([rfqTable.internalRfqNo])], 1, rfqTable.id);
      if (!rfq) return { found: false };
      const items = await findWhere(rfqItemsTable, [_eq(rfqItemsTable.rfqId, rfq.id as number)]);
      const offers = await findWhere(offersTable, [_eq(offersTable.rfqId, rfq.id as number)]);
      const offerIds = offers.map((o) => o.id as number);
      const offerItems = offerIds.length
        ? await db
            .select()
            .from(offerItemsTable)
            .where(or(...offerIds.map((id) => _eq(offerItemsTable.offerId, id))))
            .limit(200)
        : [];
      return { found: true, rfq, items, offers, offerItems };
    }
    case "customer_rfq": {
      const [rfq] = await findWhere(
        customerRfqsTable,
        [byNumber([customerRfqsTable.internalNo, customerRfqsTable.customerRfqNo])],
        1,
        customerRfqsTable.id,
      );
      if (!rfq) return { found: false };
      const items = await findWhere(customerRfqItemsTable, [
        _eq(customerRfqItemsTable.customerRfqId, rfq.id as number),
      ]);
      return { found: true, rfq, items };
    }
    case "sales_invoice": {
      const [inv] = await findWhere(
        salesInvoicesTable,
        [byNumber([salesInvoicesTable.invoiceNo, salesInvoicesTable.customerPoNo])],
        1,
        salesInvoicesTable.id,
      );
      return inv ? { found: true, invoice: inv } : { found: false };
    }
    case "supplier_invoice": {
      const [inv] = await findWhere(
        supplierInvoicesTable,
        [byNumber([supplierInvoicesTable.invoiceNo])],
        1,
        supplierInvoicesTable.id,
      );
      return inv ? { found: true, invoice: inv } : { found: false };
    }
    default:
      throw new Error(`Unknown document type "${type}"`);
  }
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "search_database": {
        if (!ctx.settings.allowDatabase)
          return { ok: false, error: "الوصول لقاعدة البيانات معطّل" };
        const rows = await queryRecords({
          table: String(args.table ?? ""),
          search: args.search ? String(args.search) : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          sinceDays: typeof args.sinceDays === "number" ? args.sinceDays : undefined,
          orderDir: args.orderDir === "asc" ? "asc" : args.orderDir === "desc" ? "desc" : undefined,
        });
        return { ok: true, data: { count: rows.length, rows } };
      }
      case "count_database": {
        if (!ctx.settings.allowDatabase)
          return { ok: false, error: "الوصول لقاعدة البيانات معطّل" };
        const n = await countRecords({
          table: String(args.table ?? ""),
          sinceDays: typeof args.sinceDays === "number" ? args.sinceDays : undefined,
        });
        return { ok: true, data: { table: args.table, count: n } };
      }
      case "system_overview": {
        if (!ctx.settings.allowDatabase)
          return { ok: false, error: "الوصول لقاعدة البيانات معطّل" };
        return { ok: true, data: await systemSnapshot() };
      }
      case "lookup_document": {
        if (!ctx.settings.allowDatabase)
          return { ok: false, error: "الوصول لقاعدة البيانات معطّل" };
        return {
          ok: true,
          data: await lookupDocument(String(args.type ?? ""), String(args.number ?? "")),
        };
      }
      case "search_emails": {
        if (!ctx.settings.allowEmail) return { ok: false, error: "الوصول للبريد معطّل" };
        const emails = await searchEmails({
          query: args.query ? String(args.query) : undefined,
          from: args.from ? String(args.from) : undefined,
          sinceDays: typeof args.sinceDays === "number" ? args.sinceDays : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          unseenOnly: Boolean(args.unseenOnly),
        });
        return { ok: true, data: { count: emails.length, emails } };
      }
      case "read_email": {
        if (!ctx.settings.allowEmail) return { ok: false, error: "الوصول للبريد معطّل" };
        return { ok: true, data: await readEmail(Number(args.uid)) };
      }
      case "send_email": {
        if (!ctx.settings.allowEmail) return { ok: false, error: "إرسال البريد معطّل" };
        await sendAssistantEmail({
          to: String(args.to ?? ""),
          subject: String(args.subject ?? ""),
          body: String(args.body ?? ""),
          cc: args.cc ? String(args.cc) : undefined,
        });
        return { ok: true, data: { sent: true, to: args.to } };
      }
      case "generate_pdf": {
        if (!ctx.settings.allowPdf) return { ok: false, error: "إنشاء PDF معطّل" };
        const sections = (Array.isArray(args.sections) ? args.sections : []) as PdfSection[];
        const buffer = await generateAssistantPdf({
          title: String(args.title ?? "تقرير"),
          subtitle: args.subtitle ? String(args.subtitle) : null,
          sections,
        });
        const filename = `${String(args.filename || "report").replace(/[^\w\u0600-\u06FF.-]/g, "_")}.pdf`;
        ctx.outbox.push({ buffer, filename, mimeType: "application/pdf" });
        return { ok: true, data: { generated: true, filename, bytes: buffer.length } };
      }
      default:
        return { ok: false, error: `Unknown tool "${name}"` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export { asText };
