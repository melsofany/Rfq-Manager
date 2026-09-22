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
  whatsappChatsTable,
} from "@workspace/db";
import { and, or, ilike, eq, desc, inArray } from "drizzle-orm";
import type { SQL, AnyColumn } from "drizzle-orm";
import {
  TABLES,
  queryRecords,
  countRecords,
  systemSnapshot,
  findWhere,
  tableListForPrompt,
  cols,
} from "./db-tools";
import {
  searchEmails,
  readEmail,
  readEmailAttachment,
  sendAssistantEmail,
  isEmailReadConfigured,
  isTextLikeMime,
} from "./email";
import { defaultMailbox, mailboxes } from "./mailboxes";
import { generateAssistantPdf, type PdfSection } from "./pdf";
import type { ToolDefinition } from "./llm";
import type { AiSettings } from "./config";
import { logger } from "../../shared/logger";

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
        name: "supplier_overview",
        description:
          "ملف كامل لمورد في استدعاء واحد: بياناته + كل أوامر الشراء الخاصة به + بنودها + " +
          "عروضه + محادثات الواتساب معه. استخدمها فورًا عند السؤال عن مورد بالاسم أو بالرقم " +
          "بدلاً من استدعاء عدة أدوات متتالية.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "اسم المورد أو رقمه الداخلي (id)" },
          },
          required: ["name"],
        },
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
          "البحث في البريد الوارد للشركة (آخر رسائل، حسب المُرسل/الموضوع/النص). " +
          "المطابقة تتجاهل فروق الهمزات والتاء المربوطة، وتشمل اسم المُرسل وليس بريده فقط. " +
          "يبحث تلقائيًا في كل بريد الشركة إن لم تحدد mailbox، ويرجع مع كل رسالة اسم البريد والمجلد. " +
          "يرجع قائمة بالرسائل مع معرّف UID لقراءتها بالتفصيل، ويذكر نطاق البحث (المجلد والمدة وعدد الرسائل المفحوصة).",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "كلمة في الموضوع/النص/اسم المُرسل" },
            from: { type: "string", description: "بريد المُرسل أو اسمه" },
            sinceDays: {
              type: "integer",
              description: "خلال آخر عدد أيام (افتراضي 60). وسّعها عند البحث عن أمر توريد قديم.",
            },
            limit: { type: "integer" },
            unseenOnly: { type: "boolean", description: "غير المقروءة فقط" },
            mailbox: {
              type: "string",
              description:
                "بريد محدّد للبحث فيه (اتركه فارغًا للبحث في كل بريد الشركة). " +
                "استخدم list_mailboxes لمعرفة المتاح.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_sent_emails",
        description:
          "البحث في مجلد «المرسل» (الرسائل التي أرسلتها الشركة) — استخدمها لسؤال مثل " +
          "«ماذا أرسلنا لهذا المورد؟» أو «هل أرسلنا أمر الشراء؟». نفس معاملات search_emails.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "كلمة في الموضوع/النص/اسم المُرسَل إليه" },
            from: { type: "string", description: "المُرسَل إليه (اسم أو بريد)" },
            sinceDays: { type: "integer", description: "خلال آخر عدد أيام (افتراضي 60)" },
            limit: { type: "integer" },
            mailbox: { type: "string", description: "بريد محدّد (اتركه فارغًا للبحث في كل بريد)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_mailboxes",
        description: "عرض كل بريدات الشركة المتاحة للقراءة، ولمعرفة البريد الافتراضي.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "read_email",
        description:
          "قراءة نص رسالة بريد كاملة عبر UID (من نتيجة search_emails). " +
          "مرّر نفس mailbox و folder اللذين ظهرا مع الرسالة في نتيجة البحث.",
        parameters: {
          type: "object",
          properties: {
            uid: { type: "integer" },
            mailbox: { type: "string", description: "البريد الذي ظهر مع الرسالة" },
            folder: { type: "string", enum: ["inbox", "sent"], description: "المجلد" },
          },
          required: ["uid"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_email_attachment",
        description:
          "جلب مرفق محدد من رسالة بريد وإرساله للمستخدم على واتساب كملف. " +
          "استخدمها بعد read_email لمعرفة أرقام المرفقات؛ مرّر uid والبريد والمجلد من نتيجة search_emails. " +
          "هذه هي الطريقة الصحيحة لتلبية طلبات مثل «هات ملف الـ PDF من الإيميل».",
        parameters: {
          type: "object",
          properties: {
            uid: { type: "integer", description: "معرّف الرسالة (UID)" },
            index: { type: "integer", description: "رقم المرفق داخل الرسالة (يبدأ من 0)" },
            filename: {
              type: "string",
              description: "جزء من اسم المرفق للبحث عنه (بديل عن index)",
            },
            mailbox: { type: "string", description: "البريد الذي ظهر مع الرسالة" },
            folder: { type: "string", enum: ["inbox", "sent"], description: "المجلد" },
          },
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

  if (!isEmailReadConfigured()) {
    // These are useless without a readable mailbox; hide them so the model does
    // not plan around a capability the server cannot deliver.
    const readOnlyNames = new Set([
      "read_email",
      "get_email_attachment",
      "list_mailboxes",
      "search_emails",
      "search_sent_emails",
    ]);
    return defs.filter((d) => !readOnlyNames.has(d.function.name));
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
        eq(purchaseOrderItemsTable.poId, po.id as number),
      ]);
      const receipts = await findWhere(poItemReceiptsTable, [
        eq(poItemReceiptsTable.poId, po.id as number),
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
        eq(customerPoItemsTable.customerPoId, po.id as number),
      ]);
      const deliveries = await findWhere(customerPoItemDeliveriesTable, [
        eq(customerPoItemDeliveriesTable.customerPoId, po.id as number),
      ]);
      const [collection] = await findWhere(customerPoCollectionsTable, [
        eq(customerPoCollectionsTable.customerPoId, po.id as number),
      ]);
      const payments = await findWhere(customerPoPaymentsTable, [
        eq(customerPoPaymentsTable.customerPoId, po.id as number),
      ]);
      return { found: true, po, items, deliveries, collection, payments };
    }
    case "rfq": {
      const [rfq] = await findWhere(rfqTable, [byNumber([rfqTable.internalRfqNo])], 1, rfqTable.id);
      if (!rfq) return { found: false };
      const items = await findWhere(rfqItemsTable, [eq(rfqItemsTable.rfqId, rfq.id as number)]);
      const offers = await findWhere(offersTable, [eq(offersTable.rfqId, rfq.id as number)]);
      const offerIds = offers.map((o) => o.id as number);
      const offerItems = offerIds.length
        ? await db
            .select()
            .from(offerItemsTable)
            .where(or(...offerIds.map((id) => eq(offerItemsTable.offerId, id))))
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
        eq(customerRfqItemsTable.customerRfqId, rfq.id as number),
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

/**
 * Everything known about one supplier, in a single round-trip. The agent
 * previously needed 4–5 sequential calls (find supplier → find its offers → find
 * its POs → find their items) and often ran out of rounds mid-chase, answering
 * from whatever it had partially collected.
 */
async function supplierOverview(term: string): Promise<unknown> {
  const needle = term.trim();
  const scols = cols(suppliersTable);
  const orParts = ["name", "contactPerson", "email", "phone", "supplierId"]
    .map((c) => scols[c])
    .filter(Boolean)
    .map((c) => ilike(c, `%${needle}%`));
  const idFilter = /^\d+$/.test(needle) && scols["id"] ? eq(scols["id"], Number(needle)) : null;
  const where = idFilter ? or(or(...orParts), idFilter) : or(...orParts);
  const matches = (await db
    .select()
    .from(suppliersTable as never)
    .where(where as SQL)
    .limit(10)) as never as Array<Record<string, unknown>>;

  if (matches.length === 0) {
    return { found: false, note: `لا يوجد مورد مطابق لـ «${needle}».` };
  }

  const results = [];
  for (const supplier of matches.slice(0, 5)) {
    const id = supplier.id as number;
    const lineRows = (await db
      .select()
      .from(purchaseOrderItemsTable as never)
      .where(eq(purchaseOrderItemsTable.supplierId, id))
      .limit(300)) as never as Array<Record<string, unknown>>;
    const poIds = [...new Set(lineRows.map((r) => Number(r.poId)))].filter(Number.isInteger);
    const pos = poIds.length
      ? ((await db
          .select()
          .from(purchaseOrdersTable as never)
          .where(inArray(purchaseOrdersTable.id, poIds))
          .limit(100)) as never as Array<Record<string, unknown>>)
      : [];
    const offerRows = (await db
      .select()
      .from(offersTable as never)
      .where(eq(offersTable.supplierId, id))
      .limit(100)) as never as Array<Record<string, unknown>>;
    const chats = (await db
      .select()
      .from(whatsappChatsTable as never)
      .where(eq(whatsappChatsTable.supplierId, id))
      .orderBy(desc(whatsappChatsTable.id))
      .limit(30)) as never as Array<Record<string, unknown>>;

    const poById = new Map(pos.map((p) => [p.id as number, p]));
    results.push({
      supplier,
      purchaseOrders: pos.map((p) => ({
        ...p,
        items: lineRows.filter((l) => Number(l.poId) === Number(p.id)),
      })),
      // A line whose header is missing still carries useful data.
      orphanLines: lineRows.filter((l) => !poById.has(Number(l.poId))),
      offers: offerRows,
      whatsappChats: chats,
    });
  }

  return {
    found: true,
    matchCount: matches.length,
    suppliers: results,
  };
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
        const res = await queryRecords({
          table: String(args.table ?? ""),
          search: args.search ? String(args.search) : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          sinceDays: typeof args.sinceDays === "number" ? args.sinceDays : undefined,
          orderDir: args.orderDir === "asc" ? "asc" : args.orderDir === "desc" ? "desc" : undefined,
        });
        return {
          ok: true,
          data: {
            count: res.rows.length,
            // Stated FIRST so the model reads the grounding caveat before the
            // rows: an unfiltered result must never be presented as a match.
            searchNote: res.filter.note,
            searchApplied: res.filter.applied,
            rows: res.rows,
          },
        };
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
      case "supplier_overview": {
        if (!ctx.settings.allowDatabase)
          return { ok: false, error: "الوصول لقاعدة البيانات معطّل" };
        return { ok: true, data: await supplierOverview(String(args.name ?? "")) };
      }
      case "lookup_document": {
        if (!ctx.settings.allowDatabase)
          return { ok: false, error: "الوصول لقاعدة البيانات معطّل" };
        return {
          ok: true,
          data: await lookupDocument(String(args.type ?? ""), String(args.number ?? "")),
        };
      }
      case "search_emails":
      case "search_sent_emails": {
        if (!ctx.settings.allowEmail) return { ok: false, error: "الوصول للبريد معطّل" };
        const folder = name === "search_sent_emails" ? "sent" : "inbox";
        // No mailbox named → read EVERY configured mailbox, so an answer is
        // never "not found" merely because the message is in a different inbox.
        const requested = args.mailbox ? String(args.mailbox) : "*";
        const results = await searchEmails({
          query: args.query ? String(args.query) : undefined,
          from: args.from ? String(args.from) : undefined,
          sinceDays: typeof args.sinceDays === "number" ? args.sinceDays : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          unseenOnly: Boolean(args.unseenOnly),
          mailbox: requested,
          folder,
        });

        // Merge the per-mailbox results, newest first, and keep the mailbox tag
        // on every row so the model can ask for the right one when opening it.
        const limit = Math.min(Math.max(Number(args.limit ?? 10), 1), 30);
        const emails = results
          .flatMap((r) => r.emails)
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, limit);

        const seen = results
          .map(
            (r) =>
              `${r.scope.mailbox}: ${r.scope.scanned} رسالة${r.scope.note ? ` (${r.scope.note})` : ""}`,
          )
          .join("؛ ");
        const folderLabel = folder === "sent" ? "مجلد المرسل" : "صندوق الوارد";
        return {
          ok: true,
          data: {
            count: emails.length,
            // Tell the model exactly what was searched, so "not found" can be
            // reported with its scope instead of as an unsupported claim.
            scopeNote:
              `تم فحص ${folderLabel} في ${results.length} بريد — ${seen}.` +
              (emails.length === 0
                ? " لم تُطابق أي رسالة. جرّب توسيع sinceDays أو اسمًا بديلًا أو بريدًا آخر."
                : ""),
            mailboxesSearched: results.map((r) => r.scope.mailbox),
            emails,
          },
        };
      }
      case "list_mailboxes": {
        if (!ctx.settings.allowEmail) return { ok: false, error: "الوصول للبريد معطّل" };
        return {
          ok: true,
          data: {
            mailboxes: mailboxes().map((m) => ({
              email: m.email,
              label: m.label,
              isDefault: m.isDefault,
            })),
            // The list is what the model should offer when the operator has not
            // named a mailbox.
            default: defaultMailbox()?.email ?? null,
          },
        };
      }
      case "read_email": {
        if (!ctx.settings.allowEmail) return { ok: false, error: "الوصول للبريد معطّل" };
        const uid = Number(args.uid);
        if (!Number.isInteger(uid)) return { ok: false, error: "uid غير صحيح" };
        // Pass through the mailbox/folder the search returned — a UID is only
        // unique inside one folder of one mailbox.
        const folder = args.folder === "sent" ? "sent" : "inbox";
        return {
          ok: true,
          data: await readEmail(uid, args.mailbox ? String(args.mailbox) : undefined, folder),
        };
      }
      case "get_email_attachment": {
        if (!ctx.settings.allowEmail) return { ok: false, error: "الوصول للبريد معطّل" };
        const uid = Number(args.uid);
        if (!Number.isInteger(uid)) return { ok: false, error: "uid غير صحيح" };
        const att = await readEmailAttachment(
          uid,
          {
            index: typeof args.index === "number" ? args.index : undefined,
            filename: args.filename ? String(args.filename) : undefined,
          },
          args.mailbox ? String(args.mailbox) : undefined,
          args.folder === "sent" ? "sent" : "inbox",
        );
        if (att.oversized || !att.content) {
          return {
            ok: false,
            error: `المرفق «${att.filename}» حجمه كبير جدًا (${att.size} بايت) ولا يمكن إرساله.`,
          };
        }
        // Text-like attachments go back to the model as text so it can quote
        // from them; everything else (PDF, images, spreadsheets) is queued for
        // WhatsApp and reported as metadata only.
        const textLike = isTextLikeMime(att.mimeType);
        ctx.outbox.push({
          buffer: att.content,
          filename: att.filename,
          mimeType: att.mimeType || "application/octet-stream",
        });
        return {
          ok: true,
          data: textLike
            ? {
                sent: true,
                filename: att.filename,
                mimeType: att.mimeType,
                size: att.size,
                content: att.content.toString("utf8").slice(0, 12_000),
              }
            : {
                sent: true,
                filename: att.filename,
                mimeType: att.mimeType,
                size: att.size,
                note: "تم إرسال الملف للمستخدم على واتساب.",
              },
        };
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
        // A hallucinated tool name is invisible without this log — the model
        // just sees "Unknown tool" and retries something else, forever.
        logger.warn({ tool: name }, "AI assistant: model called an unknown tool");
        return { ok: false, error: `Unknown tool "${name}"` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, tool: name }, "AI assistant: tool execution failed");
    return { ok: false, error: msg };
  }
}

export { asText };
