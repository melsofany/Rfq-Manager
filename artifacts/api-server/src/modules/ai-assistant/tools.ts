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
  scanEmails,
  readEmail,
  readEmailAttachment,
  sendAssistantEmail,
  isEmailReadConfigured,
  isTextLikeMime,
  isPdfAttachment,
  extractPdfText,
  scanCacheKey,
  type EmailCensusResult,
  type EmailCensusNumber,
} from "./email";
import { matchesPartQuery } from "./part-aliases";
import {
  itemsCsv,
  itemsAggregateCsv,
  aggregateItems,
  aggregateItemsByOccurrence,
  type ParsedLineItem,
} from "./email-items";
import { runItemScan, sessionAttachmentCoverage } from "./item-scan-session";
import {
  getPurchaseOrderStatus,
  getSupplierPerformance,
  aggregatePoItems,
  getUnfulfilledOrders,
  getLatestSupplierPrice,
  getOpenSupplierInvoices,
  detectDuplicates,
  findMissingRecords,
  getOverdueDeliveries,
  compareSupplierQuotes,
} from "./procurement-tools";
import { defaultMailbox, mailboxes } from "./mailboxes";
import { rememberFact, recallMemories, forgetMemory } from "./memory";
import {
  listJobs,
  getJob,
  cancelJob,
  describeJob,
  startCensusJob,
  JobDeliveryError,
  type CensusJobArgs,
} from "./jobs";
import { sendWhatsAppText, sendWhatsAppDocument } from "../communications/service";
import { generateAssistantPdf, generateMissingNumbersPdf, type PdfSection } from "./pdf";
import {
  extractDocumentText,
  isReadableDocumentMime,
  MAX_DOCUMENT_CHARS,
  type ToolDefinition,
} from "./llm";
import type { AiSettings } from "./config";
import { logger } from "../../shared/logger";

/**
 * MIME type used to upload CSV files to WhatsApp.
 *
 * WhatsApp's media upload rejects `text/csv` outright — observed live as
 * `(#100) Param file must be a file with one of the following types: … Received
 * file of type 'text/csv'` — so every CSV the assistant generated was silently
 * lost (the send failed, the operator received no file). `text/plain` is on the
 * accepted list and WhatsApp preserves the `.csv` filename, so the operator
 * still gets a file their spreadsheet app opens. Do NOT set `text/csv` here.
 */
export const CSV_UPLOAD_MIME = "text/plain";

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

/**
 * Bind-parameter chunk for the reconciliation query. Postgres allows 65,535 per
 * statement; a year-long census can carry thousands of numbers, so the `IN` is
 * split rather than risking one oversized statement failing the whole answer.
 */
const COMPARE_CHUNK = 5_000;

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
        name: "get_purchase_order_status",
        description:
          "حالة أمر شراء مورد برقمه: الحالة + البنود + الموردون + الكميات المستلمة/المقبولة، " +
          "محسوبة داخل قاعدة البيانات. استخدمها بدلًا من سلسلة استدعاءات لمعرفة حالة أمر بعينه.",
        parameters: {
          type: "object",
          properties: {
            number: { type: "string", description: "الرقم الداخلي أو رقم الشيت/العميل" },
          },
          required: ["number"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_supplier_performance",
        description:
          "أداء الموردين بالأرقام (تجميع في قاعدة البيانات): عدد أوامر الشراء والبنود، مجموع الكميات، " +
          "المقبول/المرفوض، نسبة القبول، وعدد العروض المقدَّمة. للأسئلة مثل «أداء المورد X» أو «مين أفضل مورد».",
        parameters: {
          type: "object",
          properties: {
            supplier: {
              type: "string",
              description: "اسم المورد أو رقمه (اختياري — فارغ = كل الموردين)",
            },
            sinceDays: { type: "integer", description: "قصر النطاق على آخر عدد أيام" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "aggregate_po_items",
        description:
          "أكثر البنود تكرارًا/كمية عبر بنود أوامر الشراء، بتجميع SQL. " +
          "by=qty (افتراضي) للترتيب بإجمالي الكمية، by=occurrences للترتيب بعدد مرات الورود.",
        parameters: {
          type: "object",
          properties: {
            by: { type: "string", enum: ["qty", "occurrences"] },
            partNo: { type: "string", description: "قصر على بند معيّن (جزء من رقم القطعة)" },
            sinceDays: { type: "integer" },
            limit: { type: "integer", description: "عدد البنود المعروضة (افتراضي 20)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_unfulfilled_orders",
        description:
          "أوامر الشراء غير المكتملة: أوامر بها بنود لم تُستلم بالكامل (pending/partial)، " +
          "مع المورد وإجمالي الكمية المفتوحة. محسوبة في قاعدة البيانات.",
        parameters: {
          type: "object",
          properties: {
            sinceDays: { type: "integer" },
            limit: { type: "integer" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_latest_supplier_price",
        description:
          "آخر سعر مسجَّل لبند (من أسعار بنود أوامر الشراء وأسعار العروض)، مرتبًا بالأحدث. " +
          "لأسئلة «آخر سعر لبند كذا» أو «سعر المورد كذا للقطعة كذا».",
        parameters: {
          type: "object",
          properties: {
            partNo: { type: "string" },
            description: { type: "string" },
            supplier: { type: "string" },
            limit: { type: "integer" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_open_supplier_invoices",
        description:
          "فواتير الموردين المرحَّلة (posted) التي لها رصيد متبقٍّ (لم تُسدَّد)، مع الإجمالي المستحق.",
        parameters: {
          type: "object",
          properties: {
            supplier: { type: "string", description: "اسم المورد (اختياري)" },
            limit: { type: "integer" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_overdue_deliveries",
        description:
          "بنود أوامر شراء العملاء التي فات تاريخ تسليمها ولم تُسلَّم (متأخرة)، مع عدد أيام التأخير " +
          "والكمية المتبقية، محسوبة في قاعدة البيانات. لأسئلة «إيه المتأخر في التسليم؟» أو «تسليمات فات موعدها».",
        parameters: {
          type: "object",
          properties: {
            customer: { type: "string", description: "اسم العميل (اختياري)" },
            limit: { type: "integer" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "compare_supplier_quotes",
        description:
          "قارن عروض الموردين لطلب عرض واحد، بندًا بندًا: سعر كل مورد لكل بند + أرخص مورد لكل بند " +
          "(وأي سعر معتمد isApproved). تجميع في قاعدة البيانات. لأسئلة «قارن عروض الموردين» أو «مين أرخص». " +
          "حدّد الطلب بـ rfqNo (الرقم الداخلي أو رقم العميل) أو rfqId.",
        parameters: {
          type: "object",
          properties: {
            rfqNo: { type: "string", description: "رقم طلب العرض (داخلي أو رقم العميل)" },
            rfqId: { type: "integer", description: "معرّف الطلب (بديل عن rfqNo)" },
            limit: { type: "integer" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "detect_duplicates",
        description:
          "كشف القيم المكرَّرة في عمود داخل جدول (مثال: أرقام فواتير مكرَّرة). تجميع في قاعدة البيانات.",
        parameters: {
          type: "object",
          properties: {
            table: {
              type: "string",
              enum: ["purchase_orders", "suppliers", "customer_pos"],
            },
            column: { type: "string", description: "اسم العمود" },
            limit: { type: "integer" },
          },
          required: ["table", "column"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "find_missing_records",
        description:
          "مقارنة قائمة أرقام (غالبًا مستخرجة من البريد) بعمود في قاعدة البيانات، وإرجاع الأرقام غير المسجَّلة. " +
          "استخدمها لسؤال «الأرقام اللي في الميل مش في النظام» بعد استخراج الأرقام.",
        parameters: {
          type: "object",
          properties: {
            numbers: { type: "array", items: { type: "string" } },
            table: {
              type: "string",
              enum: ["customer_rfqs", "purchase_orders", "customer_pos", "rfq"],
            },
            column: { type: "string", description: "اسم عمود الرقم داخل الجدول" },
          },
          required: ["numbers", "table", "column"],
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
        name: "scan_emails",
        description:
          "حصر/إحصاء شامل لرسائل البريد (وليس عرض أحدث الرسائل فقط). استخدمها لأي سؤال عن " +
          "«كم عدد…» أو «كل…» أو «الحصر» أو «مقارنة البريد بالنظام». " +
          "تفحص الصندوق كله (أو فترة زمنية منه) وتعيد: العدد الإجمالي الدقيق، التوزيع على الشهور، " +
          "أكثر المُرسلين، وأرقام المستندات المستخرجة من الموضوع (مثل 26R011936 و P26E11407) مع تكرار كل رقم. " +
          "تختلف عن search_emails: search_emails تعرض عيّنة (٣٠ رسالة كحد أقصى) ولا تصلح للحصر. " +
          "لجلب قائمة كاملة كبيرة، نفّذ الحصر على أجزاء: مرّة لكل شهر أو ربع سنة عبر sinceDate/beforeDate. " +
          "مرّر compareTable/compareColumn لمقارنة الأرقام المستخرجة بما هو مسجّل في النظام وإرجاع " +
          "الأرقام الموجودة في البريد وغير المسجّلة (الفرق) في استدعاء واحد.",
        parameters: {
          type: "object",
          properties: {
            from: {
              type: "string",
              description: "بريد المُرسل أو اسمه (مثل egyptian-drilling أو EDC)",
            },
            subject: { type: "string", description: "كلمة في الموضوع" },
            query: { type: "string", description: "كلمة في الموضوع/المُرسل/المُرسَل إليه" },
            sinceDate: {
              type: "string",
              description: "بداية الفترة بصيغة YYYY-MM-DD (مثال: 2026-01-01). مهم للحصر السنوي.",
            },
            beforeDate: {
              type: "string",
              description:
                "نهاية الفترة بصيغة YYYY-MM-DD (غير شاملة). تُستخدم لتقسيم الحصر الكبير.",
            },
            mailbox: {
              type: "string",
              description: "بريد محدّد (اتركه فارغًا لحصر كل بريد الشركة).",
            },
            folder: {
              type: "string",
              enum: ["inbox", "sent"],
              description: "المجلد (افتراضي الوارد)",
            },
            limit: {
              type: "integer",
              description:
                "أقصى عدد رسائل تُعاد في القائمة (افتراضي 100، أقصى 500). العدد الإجمالي يُعاد دائمًا كاملًا.",
            },
            unseenOnly: { type: "boolean", description: "غير المقروءة فقط" },
            compareTable: {
              type: "string",
              description:
                "جدول النظام للمقارنة (مثل customer_rfqs أو purchase_orders). " +
                "مع compareColumn يرجّع الأرقام الموجودة في البريد وغير المسجّلة.",
            },
            compareColumn: {
              type: "string",
              description: "عمود الرقم في ذلك الجدول (مثل customerRfqNo أو sheetPoNo).",
            },
            exportCsv: {
              type: "boolean",
              description:
                "أرسل القائمة الكاملة كمستند CSV على واتساب (استخدمها عندما يطلب المستخدم ملفًا بالحصر).",
            },
            exportPdf: {
              type: "boolean",
              description:
                "أرسل تقرير PDF كاملًا بالأرقام غير المسجلة في النظام (يُبنى من نتيجة المقارنة الكاملة، " +
                "فلا تُقتطع القائمة). استخدمها مع compareTable/compareColumn عندما يطلب المستخدم ملفًا بالفرق.",
            },
            includeAttachments: {
              type: "boolean",
              description:
                "افتح مرفقات الرسائل المطابقة (PDF) واستخرج الأرقام من داخل الملفات أيضًا، وليس من الموضوع فقط. " +
                "استخدمها عندما تريد حصرًا أدق (مثل إشعارات «Quotation Import» التي يكون الرقم فيها داخل الملف). " +
                "يبطئ الحصر، ويُذكر نطاق ما فُتح فعليًا في attachmentCoverage.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "scan_email_items",
        description:
          "حصر بنود الطلبات/أوامر التوريد من داخل مرفقات البريد (ملفات PDF) وليس من الموضوع. " +
          "تفتح المرفقات وتقرأ جداول البنود (رقم القطعة، التوصيف، الكمية، الوحدة) وتجمّعها. " +
          "استخدمها لأي سؤال مثل «إيه البنود والكميات اللي في طلبات شركة الحفر المصرية؟» أو " +
          "«إيه أكتر قطعة اتطلبت؟» أو «أكتر بند اتكرر؟». لا تعتمد على search_emails لهذا — فهي لا تقرأ داخل الملفات. " +
          "الترتيب الافتراضي بالتكرار (مرات ورود البند) وهو المقصود بسؤال «أكتر بند اتكرر»؛ " +
          "استخدم ordering=qty للترتيب بإجمالي الكمية. " +
          "أعِد دائمًا coverage في الرد: إن كان unreadable>0 أو truncated=true أو hasAttachments=false فاذكر أن الحصر ناقص ولا تدّعِ الكمال. " +
          "مرّر exportCsv=true لإرسال كل البنود كملف، أو exportPdf=true لملف PDF بالملخص.",
        parameters: {
          type: "object",
          properties: {
            from: {
              type: "string",
              description:
                "المُرسل: بريد، أو نطاقه، أو اختصار اسم الشركة كما يقوله المستخدم (مثل EDC). الاختصار يُطابَق مع المُرسل الفعلي، وتُحصى الشركة كاملةً بكل عناوين نطاقها",
            },
            subject: { type: "string", description: "كلمة في الموضوع (مثل RFQ أو PO)" },
            query: { type: "string", description: "كلمة في الموضوع/المُرسل" },
            sinceDate: { type: "string", description: "بداية الفترة YYYY-MM-DD" },
            beforeDate: { type: "string", description: "نهاية الفترة YYYY-MM-DD (غير شاملة)" },
            mailbox: { type: "string", description: "بريد محدّد (اتركه فارغًا لكل البريد)" },
            limit: {
              type: "integer",
              description:
                "أقصى عدد رسائل في الدُفعة الواحدة (افتراضي 1200). الفحص قابل للاستكمال: " +
                "إن عاد isComplete=false فتبقّى رسائل لم تُفتح — أعد نداء الأداة بنفس الوسائط " +
                "لتكملة الحصر من حيث توقف. لا تعرض النتيجة كحصر كامل قبل isComplete=true.",
            },
            top: {
              type: "integer",
              description: "عدد البنود الأكثر تكرارًا في الملخص (افتراضي 50)",
            },
            minOrders: {
              type: "integer",
              description:
                "أقل عدد أوامر يجب أن يظهر فيها البند ليُدرج في ترتيب التكرار (افتراضي 2). " +
                "القاعدة المطلوبة: البند الذي ورد في أمر واحد يُستبعد حتى لو كانت كميته ضخمة. " +
                "مرّر 1 فقط إذا طلب المستخدم صراحةً ضم البنود أحادية الظهور.",
            },
            ordering: {
              type: "string",
              enum: ["mostRepeated", "qty"],
              description:
                "ترتيب البنود: mostRepeated (افتراضي) = الأكثر تكرارًا/ورودًا في أوامر الشراء، " +
                "qty = الأكبر إجمالي كمية.",
            },
            contains: {
              type: "string",
              description:
                "فلترة النتائج على بند/ماركة/صنف معيّن (مثل «أريستون» أو «WATER HEATER» أو رقم قطعة). " +
                "استخدمها لسؤال «فين بند كذا؟» أو «هل ظهر كذا في الطلبات؟» — تبحث داخل كل الأسطر المقروءة " +
                "وتعيد المطابقات فقط. إن كان الحصر ناقصًا فاذكر أنه لم تُفحص كل الرسائل قبل قول «غير موجود».",
            },
            exportCsv: { type: "boolean", description: "أرسل كل البنود كملف CSV" },
            exportPdf: { type: "boolean", description: "أرسل ملخص البنود كملف PDF" },
            question: {
              type: "string",
              description:
                "سؤال المستخدم كما هو (يُستخدم كعنوان مهمة الحصر الخلفي عند تفعيلها تلقائيًا).",
            },
            noAutoJob: {
              type: "boolean",
              description:
                "مرّر true لتمنع التحويل التلقائي لمهمة خلفية، فتُعاد النتيجة الجزئية مع نطاقها " +
                "ويستمر الحصر بالنداء التالي. استخدمها فقط إذا أردت إجابة فورية على ما فُحص حتى الآن.",
            },
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
          "جلب مرفق محدد من رسالة بريد وإرساله للمستخدم على واتساب كملف، مع قراءة محتواه إن كان PDF أو صورة " +
          "حتى تجيب على أسئلة عن البنود والكميات داخل الملف. " +
          "استخدمها بعد read_email لمعرفة أرقام المرفقات؛ مرّر uid والبريد والمجلد من نتيجة search_emails. " +
          "هذه هي الطريقة الصحيحة لتلبية طلبات مثل «هات ملف الـ PDF من الإيميل» أو «إيه البنود اللي جوه الملف ده؟».",
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
            read: {
              type: "boolean",
              description:
                "اقرأ محتوى الملف وأعده كنص (افتراضي true). اجعلها false فقط إذا أردت إرسال الملف بدون قراءته.",
            },
          },
          required: ["uid"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "send_email",
        description:
          "إرسال بريد إلكتروني من حساب الشركة. هذا فعل خارجي حساس: يجب أولًا الاستدعاء بدون " +
          "confirmed (فيُعاد لك ملخّص المستلم والموضوع والنص للتأكيد)، ثم اعرضه على المستخدم " +
          "واطلب موافقته الصريحة، وبعدها فقط أعد الاستدعاء بـ confirmed=true.",
        parameters: {
          type: "object",
          properties: {
            to: { type: "string" },
            subject: { type: "string" },
            body: { type: "string" },
            cc: { type: "string" },
            confirmed: {
              type: "boolean",
              description: "true فقط بعد موافقة المستخدم الصريحة على الملخّص المعروض.",
            },
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
    {
      type: "function",
      function: {
        name: "remember_fact",
        description:
          "احفظ معلومة دائمة في ذاكرتك طويلة المدى لتعرفها في كل المحادثات القادمة " +
          "(تفضيلات المدير، قاعدة عمل متفق عليها، معلومة عن مورد/عميل، درس مستفاد من خطأ سابق). " +
          "استخدمها عندما يقول المستخدم «افتكر إن…» أو «من الآن اعتبر…» أو عندما تكتشف قاعدة عمل " +
          "يجب ألا تنساها. المفتاح (key) قصير وثابت: تعليم نفس المفتاح مرّة أخرى يُحدِّث القيمة بدل تكرارها. " +
          "لا تحفظ فيها بيانات متغيّرة بكثرة (أسعار لحظية، عدد رسائل) — هذه تُقرأ من الأدوات كل مرّة.",
        parameters: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "مفتاح قصير للبحث والتحديث (مثال: «اسم المورد المفضل للسلك»)",
            },
            value: { type: "string", description: "المعلومة كاملة كما يجب أن تُقال لاحقًا" },
            category: {
              type: "string",
              enum: ["fact", "preference", "entity", "rule", "lesson"],
              description: "نوع المعلومة (افتراضي fact).",
            },
            importance: {
              type: "integer",
              description: "أهمية 0-100 (افتراضي 50). ارفعها للمعلومات الحرجة.",
            },
            shared: {
              type: "boolean",
              description: "اجعلها مشتركة لكل المستخدمين (افتراضي: خاصة بهذا الرقم).",
            },
          },
          required: ["key", "value"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "recall_memory",
        description:
          "ابحث في ذاكرتك طويلة المدى عن معلومة محفوظة (تفضيل/قاعدة/معلومة عن جهة/درس). " +
          "استخدمها قبل أن تقول «لا أعرف» عن شيء قد يكون المستخدم قد علّمك إيّاه، أو عندما يسأل " +
          "«إيه اللي تعرفه عن…» أو «فاكر إن…».",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "كلمات البحث (اتركه فارغًا لعرض الأهم)" },
            category: {
              type: "string",
              enum: ["fact", "preference", "entity", "rule", "lesson"],
            },
            limit: { type: "integer", description: "أقصى عدد نتائج (افتراضي 12)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "forget_memory",
        description:
          "أنهِ صلاحية معلومة في الذاكرة (تحتفظ بالسجل لكنها لا تُستخدم بعد الآن). " +
          "استخدمها عندما يقول المستخدم إن معلومة قديمة/خاطئة أو «انسي كذا». " +
          "مرّر key، أو id إن ظهر في نتائج recall_memory.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "مفتاح المعلومة" },
            id: { type: "integer", description: "معرّف المعلومة (بديل عن key)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "job_status",
        description:
          "حالة المهام الخلفية لهذا المستخدم (الحصر الكبير للبريد يعمل في الخلفية): " +
          "لكل مهمة الحالة والتقدم ووقت البدء/الانتهاء والنتيجة إن وُجدت. " +
          "استخدمها عندما يسأل «خلص الحصر؟» أو «إيه حالة المهمة؟» أو بعد بدء مهمة.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "integer", description: "رقم مهمة بعينها (اتركه فارغًا لعرض الأحدث)" },
            limit: { type: "integer", description: "عدد المهام المعروضة (افتراضي 5)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cancel_job",
        description:
          "أوقف مهمة خلفية قيد التنفيذ (مثل حصر بريد طويل). " +
          "استخدمها عندما يقول المستخدم «الغيها» أو «وقف المهمة» أو «مش عايز الحصر ده». " +
          "تتوقف المهمة فعليًا خلال الجولة الحالية ولا يُرسَل تقريرها.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "integer", description: "رقم المهمة المطلوب إيقافها" },
          },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "resend_job_report",
        description:
          "أعِد إرسال تقرير مهمة حصر مكتملة على واتساب من النتيجة المحفوظة، **بدون** إعادة " +
          "الفحص. استخدمها عندما يقول المستخدم «لم يصل الملف» أو «ابعته تاني» أو «مفيش تقرير " +
          "وصل» بعد مهمة انتهت. لا تعِد تشغيل الحصر — النتيجة محفوظة ويمكن إرسالها كما هي.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "integer", description: "رقم المهمة (اتركه فارغًا لآخر مهمة مكتملة)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "start_census_job",
        description:
          "ابدأ حصر بنود البريد في الخلفية (مهمة غير متزامنة) عندما يكون الحصر كبيرًا " +
          "(سنة كاملة/مئات الرسائل) ولا يمكن إكماله داخل الرد. تعود فورًا برقم المهمة، " +
          "ويكمل العامل الحصر في الخلفية ويرسل النتيجة والتقرير على واتساب عند الانتهاء. " +
          "لا تستخدمها لحصر صغير — تلك يكفيها scan_email_items.",
        parameters: {
          type: "object",
          properties: {
            mailbox: { type: "string", description: "صندوق البريد (افتراضي * = الكل)" },
            from: { type: "string", description: "المُرسل" },
            subject: { type: "string", description: "موضوع الرسالة" },
            query: { type: "string", description: "كلمات في النص" },
            sinceDate: { type: "string", description: "من تاريخ YYYY-MM-DD" },
            beforeDate: { type: "string", description: "إلى تاريخ YYYY-MM-DD" },
          },
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
      "scan_emails",
      "scan_email_items",
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
 * Document types the model may guess WRONG, mapped to the other table that can
 * legitimately hold the same number.
 *
 * A supplier PO number and a customer PO number look alike («P26E14708»), and the
 * live failure was an operator asking about an ORDER FROM THE CUSTOMER while the
 * model searched `purchase_orders` (our supplier orders) — the number lived in
 * `customer_pos` all along, and the model reported «غير موجود في قاعدة البيانات».
 * A prompt rule alone had already failed to prevent this, so a miss now looks in
 * the sibling table instead of returning a bare `found:false` — a negative claim
 * needs evidence, and this is where it is gathered.
 */
const SIBLING_DOC_TYPES: Record<string, string[]> = {
  supplier_po: ["customer_po"],
  customer_po: ["supplier_po"],
};

/**
 * Look a document number up, and on a miss check the sibling table before
 * reporting absence. The original document is returned when either matches, plus
 * a `note` naming which table actually held it — so the model relays the right
 * source instead of an unsupported "not found".
 */
async function lookupDocumentWithFallback(type: string, number: string): Promise<unknown> {
  const primary = (await lookupDocument(type, number)) as { found?: boolean };
  if (primary?.found) return primary;

  const siblings = SIBLING_DOC_TYPES[type] ?? [];
  for (const sibling of siblings) {
    const alt = (await lookupDocument(sibling, number)) as { found?: boolean };
    if (alt?.found) {
      return {
        ...alt,
        // Stated FIRST so the model reads it before the rows.
        lookupNote: `لم يوجد في «${type}» لكنه موجود في «${sibling}» — هذا هو المصدر الصحيح لهذا الرقم.`,
        wrongTableTried: type,
        foundIn: sibling,
      };
    }
  }

  return {
    found: false,
    notFoundNote:
      `بحثت في «${type}»${siblings.length ? ` و«${siblings.join("، ")}»` : ""} ولم يُوجد الرقم. ` +
      `اذكر الجداول التي بحثتها عند إبلاغ المستخدم، ولا تقل «غير موجود» عن جدول لم تبحثه.`,
  };
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

/**
 * Reconcile document numbers extracted from email against a system table.
 *
 * The operator's actual question was «أرقام طلبات التسعير اللي في الميل مش
 * موجودة في النظام» — a set difference between ~1,600 email numbers and the
 * database. The model cannot do that itself (it would need 1,600 lookups), so the
 * comparison runs here as one `IN` query and returns only the difference.
 */
async function compareNumbersWithSystem(
  numbers: string[],
  target: { table: string; column: string },
): Promise<{
  found: number;
  missingNumbers: string[];
  matchedSample: Array<{ number: string; value: string }>;
}> {
  const spec = TABLES[target.table];
  if (!spec) throw new Error(`Unknown table "${target.table}"`);
  const columns = cols(spec.table);
  const column = columns[target.column];
  if (!column) {
    throw new Error(`العمود «${target.column}» غير موجود في جدول «${target.table}».`);
  }

  // Compare on the same canonical form the extraction produced (uppercase, no
  // spaces) so "26R011936" and "26R 011936" cannot look like a mismatch.
  const wanted = [...new Set(numbers.map((n) => n.replace(/\s+/g, "").toUpperCase()))].filter(
    Boolean,
  );
  if (!wanted.length) return { found: 0, missingNumbers: [], matchedSample: [] };

  // Postgres caps a statement at 65,535 bind parameters; a year-long census can
  // produce thousands of numbers, and one oversized `IN` would fail the whole
  // reconciliation. Chunk it so the comparison still returns an answer.
  const present = new Map<string, string>();
  for (let i = 0; i < wanted.length; i += COMPARE_CHUNK) {
    const chunk = wanted.slice(i, i + COMPARE_CHUNK);
    const rows = (await db
      .select({ value: column } as never)
      .from(spec.table as never)
      .where(inArray(column, chunk as never))
      .limit(chunk.length)) as unknown as Array<{ value: unknown }>;
    for (const r of rows) {
      const v = String(r.value ?? "");
      if (v) present.set(v.replace(/\s+/g, "").toUpperCase(), v);
    }
  }

  const missingNumbers = [...new Set(wanted)].filter((n) => !present.has(n));

  return {
    found: present.size,
    missingNumbers,
    matchedSample: [...present.entries()].slice(0, 20).map(([k, v]) => ({ number: k, value: v })),
  };
}

/**
 * The census as a CSV, so a full list can actually be delivered. The chat
 * message can only carry a bounded sample; a spreadsheet carries all of it.
 */
function censusCsv(census: EmailCensusResult): string {
  const esc = (v: string) => `"${(v ?? "").replace(/"/g, '""')}"`;
  const lines = ["mailbox,date,from,subject,numbers"];
  for (const e of census.emails) {
    lines.push(
      [e.mailbox, e.date, e.from, e.subject, (e.numbers ?? []).join(" ")].map(esc).join(","),
    );
  }
  if (census.numbers?.length) {
    lines.push("");
    lines.push("number,count,subject,date,mailbox");
    for (const n of census.numbers as EmailCensusNumber[]) {
      lines.push(
        [n.number, String(n.count), n.sample.subject, n.sample.date, n.sample.mailbox]
          .map(esc)
          .join(","),
      );
    }
  }
  return lines.join("\n");
}

/**
 * Ceiling on ONE tool call, independent of the run budget.
 *
 * The run budget (150s) bounds the whole answer, but nothing bounded a single
 * tool: one slow call could consume the entire run and leave the model no time
 * to speak, which surfaces to the operator as silence. A per-tool ceiling leaves
 * room for the final answer even when a call misbehaves. Most tools are fast;
 * `scan_email_items` does its own time-bounded work well under this, so the
 * wrapper is a backstop, not the primary limiter.
 *
 * On expiry the call returns a tool ERROR naming the timeout — the model then
 * reports that the tool did not finish rather than treating a truncated run as a
 * complete result. Overridable so the timeout path is testable.
 */
export function toolTimeoutMs(): number {
  return Number(process.env.AI_TOOL_TIMEOUT_MS) || 100_000;
}

/**
 * How long ONE `scan_email_items` call may spend opening attachments before it
 * returns and lets the next call continue.
 *
 * The scan is resumable, so this is a pacing value, not a completeness limit: a
 * call stops here, reports `remainingMessages`, and the model calls again. Set
 * below the agent's whole-run budget (150s) so calls, verification and delivery
 * still have room after a batch, and below the per-tool ceiling so the tool
 * returns its own honest "partial, continue" result rather than a generic
 * timeout error. Overridable so the resume path is testable.
 */
export function scanCallBudgetMs(): number {
  return Number(process.env.AI_SCAN_CALL_BUDGET_MS ?? 45_000);
}

/**
 * How many unopened messages make a census "too big to finish interactively".
 *
 * Below this the next tool call completes the scan and the operator gets a real
 * answer in the same reply; above it, resuming interactively would take several
 * more model round-trips, each spending the day's scarce quota, so the tool
 * queues a background job instead. Env-tunable because the right threshold
 * depends on measured per-message cost on the live mailbox.
 *
 * Note this is the threshold for the AUTOMATIC hand-off. When the operator asked
 * for a 100% census (see `wantsCompleteCensus`), the hand-off is unconditional —
 * a partial list is not an acceptable answer to that question, however small the
 * remainder is.
 */
function autoCensusMinRemaining(): number {
  return Number(process.env.AI_AUTO_JOB_MIN_REMAINING ?? 150);
}

/**
 * Whether the operator demanded a COMPLETE census rather than a quick sample.
 *
 * «فحص كامل بنسبة 100%», «كل أوامر الشراء», «ما تتوقفش», «لسه باقي» — the
 * recorded failure is a ranked list presented as the year's answer while only
 * 150 of 480 documents had been opened. When this is true the tool must not
 * return a partial ranking as though it were the result: it either finishes the
 * scan or hands it to a background job that will.
 */
export function wantsCompleteCensus(args: Record<string, unknown>): boolean {
  const text = String(args.question ?? args.contains ?? "");
  return /(100\s*%|فحص\s*كامل|حصر\s*كامل|كل\s*أوامر|كل\s*اوامر|جميع\s*أوامر|جميع\s*اوامر|ما\s*تتوقف|لا\s*تتوقف|لسه\s*باقي|لسة\s*باقي|كامل\s*100|complete|full\s+scan|all\s+orders)/i.test(
    text,
  );
}

/** Raised when a tool exceeds `toolTimeoutMs()`. */
export class ToolTimeoutError extends Error {
  constructor(public readonly toolName: string) {
    super(`انتهت مهلة الأداة ${toolName}`);
    this.name = "ToolTimeoutError";
  }
}

/**
 * Launch (or rejoin) the background item census for this scope and return the
 * payload the model relays. Extracted so `start_census_job` and the automatic
 * oversize-scan hand-off share ONE implementation — the two paths must behave
 * identically or the model would have to know which one it triggered.
 */
async function launchCensusJob(
  ctx: ToolContext,
  scanArgs: CensusJobArgs,
  question: string,
): Promise<ToolResult> {
  const key = scanCacheKey("items", scanArgs as unknown as Record<string, unknown>);
  const { job, reused } = await startCensusJob({
    phone: ctx.phone,
    question,
    args: scanArgs,
    runBatch: async (deadline) => {
      const { runItemScan } = await import("./item-scan-session");
      return runItemScan(key, scanArgs, deadline);
    },
    finish: async ({ phone, session, save }) => {
      const s = session as {
        census?: { matched?: number };
        coverage?: {
          messages?: number;
          lines?: number;
          attachments?: number;
          pages?: number;
          readable?: number;
          unreadable?: number;
          noAttachment?: number;
          poDocuments?: number;
          rfqDocuments?: number;
          unknownDocuments?: number;
        };
        items?: ParsedLineItem[];
        complete?: boolean;
      };
      const cov = s?.coverage ?? {};
      const matched = s?.census?.matched ?? 0;
      const opened = cov.messages ?? 0;
      const lines = cov.lines ?? 0;
      const files = cov.attachments ?? 0;
      const pages = cov.pages ?? 0;
      const unreadable = cov.unreadable ?? 0;
      const complete = Boolean(s?.complete);
      const allItems = Array.isArray(s?.items) ? (s.items as ParsedLineItem[]) : [];

      // "Matched nothing, opened nothing" is the shape of a scan that FAILED, not
      // of an empty mailbox. Reporting it as «النطاق: كل الرسائل المطابقة (0)»
      // reads as a finished, verified zero — the exact false claim that made a
      // year of EDC purchase orders come back as «لا توجد أوامر شراء». Say the
      // scan could not read the mailbox, so the operator knows to retry instead of
      // believing the mailbox is empty.
      const emptyUnstarted = matched === 0 && opened === 0 && !files;
      const scope = emptyUnstarted
        ? "النطاق: لم يُفتح أي رسالة ولم تُقرأ أي مرفقات — الحصر لم يبدأ فعليًا. " +
          "أعد المحاولة بمُرسل/موضوع محدد، وإن تكرر ذلك فالمشكلة في الاتصال بصندوق البريد."
        : complete
          ? `النطاق: كل الرسائل المطابقة (${matched}).`
          : `النطاق: فُتح ${opened} من ${matched} رسالة — الحصر ناقص.`;

      // ── The artifact. Persisted on the job row BEFORE any send, so the result
      // survives the process, the restart and the delivery failure — that is what
      // the operator's "احتفظ بنتيجة الـscan كـartifact قابل للاسترجاع" asks for.
      // Previously the scan result lived only in memory and in the WhatsApp
      // message, so once the send failed the assistant re-ran the search from
      // zero and reported the opposite answer.
      const ranked = aggregateItemsByOccurrence(allItems, 2).slice(0, 100);

      // Every PO appearance of one item, deduped by document, newest first —
      // the audit trail behind the summed figures.
      const linesFor = (desc: string) => {
        const byDoc = new Map<
          string,
          { docId: string; qty: number | null; unitPrice: number | null; lineTotal: number | null }
        >();
        for (const it of allItems) {
          if ((it.description || "").trim() !== desc) continue;
          const doc = (it.docId || "").trim();
          if (!doc || byDoc.has(doc)) continue;
          byDoc.set(doc, {
            docId: doc,
            qty: it.qty ?? null,
            unitPrice: it.unitPrice ?? null,
            lineTotal: it.lineTotal ?? null,
          });
        }
        return [...byDoc.values()];
      };

      await save({
        result: {
          matched,
          opened,
          files,
          pages,
          lines,
          unreadable,
          poDocuments: cov.poDocuments ?? 0,
          rfqDocuments: cov.rfqDocuments ?? 0,
          unknownDocuments: cov.unknownDocuments ?? 0,
          complete,
          emptyUnstarted,
          scope,
          // Each item carries its PER-PO appearances (quantity, unit price,
          // line total) so the report can be regenerated and re-sent from this
          // row alone — the operator asked for the result to be a retrievable
          // artifact instead of a fresh search. Derived rows only (no buffers).
          topItems: ranked.map((p) => ({
            description: p.description,
            partNo: p.partNo,
            lineItemNos: p.lineItemNos,
            orders: p.occurrences,
            qty: p.qty,
            uom: p.uom,
            avgUnitPrice: p.avgUnitPrice,
            totalValue: p.totalValue,
            documents: p.documents,
            lines: linesFor(p.description),
          })),
        },
      });

      // Per-appearance detail lives in the report's second table: every PO that
      // carried the item with its own quantity / unit price / line total, so a
      // figure can be audited against the source document. Built from the SAME
      // `linesFor` rows the artifact stores, so the PDF and the stored result can
      // never disagree. It is a TABLE (not prose) so each trailing page keeps its
      // column headers and the item's name on the first row of each group —
      // otherwise a continuation page held floating lines nobody could attribute
      // («مبقتش عارف دي تبع ايه»).

      const text =
        `انتهى الحصر الخلفي لبنود البريد.\n` +
        `رسائل مطابقة: ${matched} — رسائل فُتحت: ${opened} — ملفات: ${files} — ` +
        `صفحات: ${pages} — بنود: ${lines}.\n` +
        scope;

      // The message is only one half of the outcome; the PDF is the deliverable
      // the operator actually asked for. Track both so a failure to produce or
      // send the file is reported instead of swallowed.
      let textMessageId: string | null = null;
      try {
        textMessageId = await sendWhatsAppText(phone, text);
      } catch (err) {
        logger.warn({ err, phone }, "AI assistant: census job summary text failed");
      }

      let pdfMessageId: string | null = null;
      let pdfError: string | null = null;
      if (ctx.settings.allowPdf && allItems.length) {
        try {
          const { generateAssistantPdf } = await import("./pdf");
          const buffer = await generateAssistantPdf({
            title: "حصر بنود البريد (مهمة خلفية)",
            subtitle: `${Math.min(20, ranked.length)} بندًا الأكثر تكرارًا من ${lines} سطرًا`,
            sections: [
              {
                paragraphs: [
                  `رسائل مطابقة: ${matched}، فُتح مرفق ${opened} رسالة، ` +
                    `وتمت معالجة ${pages} صفحة، وقُرئ ${lines} سطر بند من ${files} ملف.`,
                  `بنود تعذّر استخراجها (ملفات بلا نص): ${unreadable}.`,
                  `مستندات أوامر شراء: ${cov.poDocuments ?? 0} — مستندات RFQ مستبعدة: ${
                    cov.rfqDocuments ?? 0
                  }.`,
                  scope,
                ],
              },
              {
                table: {
                  columns: [
                    "الترتيب",
                    "وصف البند الكامل",
                    "رقم القطعة (Part Number)",
                    "Line Item",
                    "عدد أوامر الشراء",
                    "إجمالي الكمية",
                    "الوحدة",
                    "متوسط سعر الوحدة",
                    "إجمالي المبلغ (مجموع Line Totals)",
                  ],
                  rightAligned: ["وصف البند الكامل", "Line Item", "رقم القطعة (Part Number)"],
                  // The operator asked for the TOP 20; the artifact keeps up to
                  // 100 so more is retrievable, but the report itself is the 20.
                  rows: ranked
                    .slice(0, 20)
                    .map((p, i) => [
                      i + 1,
                      p.description || "غير متوفر",
                      p.partNo ?? "—",
                      p.lineItemNos?.length ? p.lineItemNos.join("، ") : "—",
                      p.occurrences,
                      p.qty,
                      p.uom ?? "—",
                      p.avgUnitPrice != null ? p.avgUnitPrice.toFixed(2) : "—",
                      p.totalValue != null
                        ? p.totalValue.toFixed(2)
                        : "المبلغ غير متوفر في المستند",
                    ]),
                },
              },
              {
                heading: "تفاصيل كل ظهور (PO / كمية / سعر الوحدة)",
                paragraphs: [
                  "كل صف ظهر للبند في أمر شراء مستقل. البند مذكور في أول عمود من كل صف",
                  "حتى تظل التفاصيل محددة المصدر لو انقسمت على أكثر من صفحة.",
                ],
                table: {
                  columns: [
                    "البند (الترتيب)",
                    "أمر الشراء",
                    "الكمية",
                    "سعر الوحدة",
                    "إجمالي البند",
                  ],
                  rightAligned: ["البند (الترتيب)"],
                  rows: ranked.slice(0, 20).flatMap((p, i) => {
                    const lines = linesFor(p.description);
                    if (!lines.length) {
                      return [[`${i + 1}. ${p.description}`, "لا تفاصيل", "—", "—", "—"]];
                    }
                    return lines.map((l, li) => [
                      li === 0 ? `${i + 1}. ${p.description}` : "",
                      l.docId,
                      l.qty ?? "—",
                      l.unitPrice ?? "غير متوفر",
                      l.lineTotal ?? "—",
                    ]);
                  }),
                },
              },
            ],
            footer:
              "المصدر: مرفقات أوامر الشراء في البريد الإلكتروني — وليس قاعدة البيانات. " +
              `تم الإنشاء ${new Date().toLocaleString("en-GB")}`,
          });
          pdfMessageId = await sendWhatsAppDocument(
            phone,
            buffer,
            `email-items-job-${new Date().toISOString().slice(0, 10)}.pdf`,
            "application/pdf",
            `تقرير حصر بنود EDC — ${ranked.length} بندًا`,
          );
          if (!pdfMessageId) throw new Error("no message id returned for the PDF");
        } catch (err) {
          pdfError = err instanceof Error ? err.message : String(err);
          logger.warn({ err, phone }, "AI assistant: census job PDF failed");
        }
      } else if (ctx.settings.allowPdf) {
        pdfError = "لا توجد بنود لإنشاء تقرير منها";
      } else {
        pdfError = "إنشاء PDF معطّل في الإعدادات";
      }

      await save({
        result: {
          matched,
          opened,
          files,
          pages,
          lines,
          complete,
          textMessageId,
          pdfMessageId,
          pdfError,
          items: ranked.length,
        },
      });

      // A FAILED DELIVERY MUST NOT READ AS SUCCESS. The live defect was a job
      // that announced «تم إرسال التقرير» while nothing arrived; the operator
      // then had no way to tell, and a later question got a fresh, contradictory
      // answer. Throwing here makes the job end `delivery_failed` with the
      // artifact still stored.
      if (!textMessageId) {
        throw new JobDeliveryError("تعذّر إرسال ملخص الحصر على واتساب");
      }
      if (ctx.settings.allowPdf && allItems.length && !pdfMessageId) {
        throw new JobDeliveryError(
          `تعذّر إنشاء/إرسال تقرير الـPDF: ${pdfError ?? "سبب غير معروف"}`,
        );
      }
      return { messageId: pdfMessageId ?? textMessageId };
    },
  });
  return {
    ok: true,
    data: {
      jobId: job.id,
      status: job.status,
      reused,
      note: reused
        ? `هناك مهمة حصر قائمة بنفس النطاق (#${job.id}) — سأكملها ولم أبدأ واحدة جديدة.`
        : `بدأت مهمة الحصر #${job.id} في الخلفية. ستصلك النتيجة على واتساب عند الانتهاء. ` +
          `لا تنتظرها في هذه الجولة — أخبر المستخدم برقم المهمة ويمكنه السؤال job_status.`,
      progress: job.progress,
    },
  };
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const timeoutMs = toolTimeoutMs();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ToolTimeoutError(name)), timeoutMs);
    });
    return await Promise.race([executeToolInner(name, args, ctx), timeout]);
  } catch (err) {
    if (err instanceof ToolTimeoutError) {
      logger.warn({ tool: name, timeoutMs }, "AI assistant: tool exceeded its time ceiling");
      return {
        ok: false,
        error: `لم تكمل الأداة «${name}» خلال ${Math.round(timeoutMs / 1000)} ثانية. لم تُقرأ كل البيانات — اذكر ذلك ولا تدّعِ الكمال.`,
      };
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function executeToolInner(
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
          data: await lookupDocumentWithFallback(
            String(args.type ?? ""),
            String(args.number ?? ""),
          ),
        };
      }
      case "get_purchase_order_status": {
        if (!ctx.settings.allowDatabase)
          return { ok: false, error: "الوصول لقاعدة البيانات معطّل" };
        return { ok: true, data: await getPurchaseOrderStatus(String(args.number ?? "")) };
      }
      case "get_supplier_performance": {
        if (!ctx.settings.allowDatabase)
          return { ok: false, error: "الوصول لقاعدة البيانات معطّل" };
        return {
          ok: true,
          data: await getSupplierPerformance({
            supplier: args.supplier ? String(args.supplier) : undefined,
            sinceDays: typeof args.sinceDays === "number" ? args.sinceDays : undefined,
          }),
        };
      }
      case "aggregate_po_items": {
        if (!ctx.settings.allowDatabase)
          return { ok: false, error: "الوصول لقاعدة البيانات معطّل" };
        return {
          ok: true,
          data: await aggregatePoItems({
            by: args.by === "occurrences" ? "occurrences" : args.by === "qty" ? "qty" : undefined,
            partNo: args.partNo ? String(args.partNo) : undefined,
            sinceDays: typeof args.sinceDays === "number" ? args.sinceDays : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined,
          }),
        };
      }
      case "get_unfulfilled_orders": {
        if (!ctx.settings.allowDatabase)
          return { ok: false, error: "الوصول لقاعدة البيانات معطّل" };
        return {
          ok: true,
          data: await getUnfulfilledOrders({
            sinceDays: typeof args.sinceDays === "number" ? args.sinceDays : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined,
          }),
        };
      }
      case "get_latest_supplier_price": {
        if (!ctx.settings.allowDatabase)
          return { ok: false, error: "الوصول لقاعدة البيانات معطّل" };
        return {
          ok: true,
          data: await getLatestSupplierPrice({
            partNo: args.partNo ? String(args.partNo) : undefined,
            description: args.description ? String(args.description) : undefined,
            supplier: args.supplier ? String(args.supplier) : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined,
          }),
        };
      }
      case "get_open_supplier_invoices": {
        if (!ctx.settings.allowDatabase)
          return { ok: false, error: "الوصول لقاعدة البيانات معطّل" };
        return {
          ok: true,
          data: await getOpenSupplierInvoices({
            supplier: args.supplier ? String(args.supplier) : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined,
          }),
        };
      }
      case "get_overdue_deliveries": {
        if (!ctx.settings.allowDatabase)
          return { ok: false, error: "الوصول لقاعدة البيانات معطّل" };
        return {
          ok: true,
          data: await getOverdueDeliveries({
            customer: args.customer ? String(args.customer) : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined,
          }),
        };
      }
      case "compare_supplier_quotes": {
        if (!ctx.settings.allowDatabase)
          return { ok: false, error: "الوصول لقاعدة البيانات معطّل" };
        return {
          ok: true,
          data: await compareSupplierQuotes({
            rfqId: typeof args.rfqId === "number" ? args.rfqId : undefined,
            rfqNo: args.rfqNo ? String(args.rfqNo) : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined,
          }),
        };
      }
      case "detect_duplicates": {
        if (!ctx.settings.allowDatabase)
          return { ok: false, error: "الوصول لقاعدة البيانات معطّل" };
        return {
          ok: true,
          data: await detectDuplicates({
            table:
              args.table === "suppliers" || args.table === "customer_pos"
                ? args.table
                : "purchase_orders",
            column: String(args.column ?? ""),
            limit: typeof args.limit === "number" ? args.limit : undefined,
          }),
        };
      }
      case "find_missing_records": {
        if (!ctx.settings.allowDatabase)
          return { ok: false, error: "الوصول لقاعدة البيانات معطّل" };
        const table =
          args.table === "purchase_orders" || args.table === "customer_pos" || args.table === "rfq"
            ? args.table
            : "customer_rfqs";
        return {
          ok: true,
          data: await findMissingRecords({
            numbers: Array.isArray(args.numbers) ? args.numbers.map(String) : [],
            table,
            column: String(args.column ?? ""),
          }),
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
      case "scan_emails": {
        if (!ctx.settings.allowEmail) return { ok: false, error: "الوصول للبريد معطّل" };
        const requested = args.mailbox ? String(args.mailbox) : "*";
        const compareTable = args.compareTable ? String(args.compareTable) : undefined;
        const compareColumn = args.compareColumn ? String(args.compareColumn) : undefined;
        const useCompare = Boolean(compareTable && compareColumn);

        const census = await scanEmails({
          from: args.from ? String(args.from) : undefined,
          subject: args.subject ? String(args.subject) : undefined,
          query: args.query ? String(args.query) : undefined,
          sinceDate: args.sinceDate ? String(args.sinceDate) : undefined,
          beforeDate: args.beforeDate ? String(args.beforeDate) : undefined,
          unseenOnly: Boolean(args.unseenOnly),
          mailbox: requested,
          folder: args.folder === "sent" ? "sent" : "inbox",
          limit: typeof args.limit === "number" ? args.limit : undefined,
          includeAttachments: Boolean(args.includeAttachments),
          compare: useCompare
            ? (numbers, target) => compareNumbersWithSystem(numbers, target)
            : undefined,
          compareTarget: useCompare
            ? { table: compareTable as string, column: compareColumn as string }
            : undefined,
        });

        if (args.exportCsv) {
          ctx.outbox.push({
            buffer: Buffer.from(censusCsv(census), "utf8"),
            filename: `email-census-${new Date().toISOString().slice(0, 10)}.csv`,
            mimeType: CSV_UPLOAD_MIME,
          });
        }

        // The missing-number PDF is built HERE, from the complete server-side
        // comparison — not from rows the model chose. Asking the model to pass
        // the list to generate_pdf is what silently truncated the report to the
        // first 20 numbers.
        let pdfSent = false;
        if (args.exportPdf) {
          if (!census.compare) {
            return {
              ok: false,
              error:
                "لا يمكن إنشاء تقرير PDF بدون مقارنة. مرّر compareTable و compareColumn مع exportPdf.",
            };
          }
          if (!ctx.settings.allowPdf) return { ok: false, error: "إنشاء PDF معطّل" };
          const buffer = await generateMissingNumbersPdf(census.compare);
          const filename = `missing-numbers-${new Date().toISOString().slice(0, 10)}.pdf`;
          ctx.outbox.push({ buffer, filename, mimeType: "application/pdf" });
          pdfSent = true;
        }

        return {
          ok: true,
          data: {
            // Coverage FIRST, so the model reads whether this is a total before
            // it reads the number — the whole point of the capability.
            note: census.note,
            isTotal: !census.scope.truncated,
            matched: census.matched,
            distinctNumbers: census.distinctNumbers,
            byMailbox: census.byMailbox,
            byMonth: census.byMonth,
            bySender: census.bySender,
            // A `from` filter that matched nothing is NOT "no mail from this
            // company" — the shorthand may not be an address at all. Sending the
            // resolution lets the model name the real sender (or ask which one)
            // instead of announcing an absence it cannot support.
            senderResolution: census.senderResolution ?? null,
            comparison: census.compare ?? null,
            attachmentCoverage: census.attachmentCoverage ?? null,
            numbers: census.numbers,
            numbersTruncated: census.numbersTruncated,
            returned: census.returned,
            emails: census.emails,
            csvSent: Boolean(args.exportCsv),
            pdfSent,
            scope: census.scope,
          },
        };
      }
      case "scan_email_items": {
        if (!ctx.settings.allowEmail) return { ok: false, error: "الوصول للبريد معطّل" };
        const requested = args.mailbox ? String(args.mailbox) : "*";
        const contains = args.contains ? String(args.contains).trim() : "";
        // Reuse the census to find the matching messages (whole mailbox, exact
        // count) and to DOWNLOAD their attachments once; the item parser then
        // works on those bytes locally, with no model call.
        //
        // The scan is RESUMABLE, not single-shot: the envelope census is cached
        // once, then batches of attachments are opened across tool calls until
        // the cursor reaches the end. A follow-up question continues the SAME
        // census («ليه السخانات الأريستون مش في التقرير؟» right after «اكتر بند
        // اتكرر» must not restart a ~2-minute scan and blow the budget), and a
        // year too large for one call is finished by the next call rather than
        // reported as a sample. The session holds only derived rows, never the
        // downloaded PDF buffers.
        const scanArgs = {
          from: args.from ? String(args.from) : undefined,
          subject: args.subject ? String(args.subject) : undefined,
          query: args.query ? String(args.query) : undefined,
          sinceDate: args.sinceDate ? String(args.sinceDate) : undefined,
          beforeDate: args.beforeDate ? String(args.beforeDate) : undefined,
          mailbox: requested,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        };

        // Leave the agent room to answer after the scan stops (calls, verification
        // and delivery), so the scan deadline sits below the whole-run budget.
        const scanDeadline = Date.now() + scanCallBudgetMs();
        const { session } = await runItemScan(
          scanCacheKey("items", scanArgs),
          scanArgs,
          scanDeadline,
        );
        const census = session.census;
        const parsed = {
          items: session.items,
          messages: session.messages,
          coverage: session.coverage,
          aggregate: aggregateItems(session.items),
        };
        const scanCoverage = sessionAttachmentCoverage(session);

        const top = Math.min(Math.max(Number(args.top ?? 50), 1), 300);
        const truncated = scanCoverage.truncated;

        // A brand/part lookup («فين السخانات الأريستون؟») is a filter over the
        // rows already parsed — it must never look like a fresh census. The
        // match is BRAND-AWARE (see matchesPartQuery): «أريستون» must find a
        // part printed `...ARSTON...`, otherwise the lookup reports a false
        // «not found» for data that exists.
        const matchedItems = contains
          ? parsed.items.filter(
              (i) =>
                matchesPartQuery(i.description, contains) ||
                matchesPartQuery(i.partNo ?? "", contains) ||
                // The Line Item code is what EDC prints, so «26R…»/«0666.001.ARSTON.0004»
                // must be searchable even though it is not the Part Number.
                matchesPartQuery(i.lineItemNo ?? "", contains),
            )
          : parsed.items;

        // Default to FREQUENCY: «أكتر بند اتكرر» is the common ask, and ranking
        // by quantity alone answers a different question (one huge one-off order
        // would top it). The quantity view stays available for volume questions.
        //
        // In frequency mode a part seen on a single order is excluded by default
        // (`minOrders` 2): that is the operator's explicit rule — a 7,000-piece
        // line ordered once must not appear in a "most repeated" list.
        const ordering = args.ordering === "qty" ? "qty" : "mostRepeated";
        // A `contains` lookup answers "where did THIS part appear?" — a single
        // occurrence is a valid answer there, so the singleton exclusion applies
        // only to the ranked list, never to a targeted lookup.
        const minOrders = contains ? 1 : Math.max(1, Number(args.minOrders ?? 2) || 2);
        const ranked =
          ordering === "qty"
            ? aggregateItems(matchedItems)
            : aggregateItemsByOccurrence(matchedItems, minOrders);

        const coverage = parsed.coverage;
        // A complete scan that found ZERO files is not "the orders have no
        // items" — it means no attachment was recognised. Saying so prevents the
        // honest-looking "0 بنود، الحصر كامل" the model would otherwise report.
        const noAttachments = coverage.attachments === 0;
        // "Complete" is a fact about the CURSOR, not about one pass: the scan is
        // resumable, so a session is complete only once every matched message has
        // been opened (session.complete), no file was unreadable, and the pass
        // did not stop short. `allOpened` guards the count independently.
        const allOpened = coverage.messages >= census.matched;
        const complete =
          session.complete &&
          !noAttachments &&
          coverage.unreadable === 0 &&
          !truncated &&
          allOpened;

        // ── Oversize census → hand off to a background job ──────────────────
        // A resumable scan still makes the OPERATOR drive the resumption: each
        // «أعد النداء» costs a model round-trip from the day's scarce quota. When
        // the remaining work is clearly too large to finish in a couple of
        // interactive calls, the tool decides once, queues the job itself and
        // returns — the worker then walks the cursor to the end unattended and
        // pushes the finished report to WhatsApp. The model is told the job is
        // running so it does not promise a partial sample as the answer.
        //
        // Deliberately NOT applied to a `contains` lookup: that question is «فين
        // البند ده؟» and is best answered from what has already been read, with
        // its scope stated. Turning it into a job would replace an answer with a
        // «جاري الحصر» notice, which is a worse reply for a lookup.
        if (
          !complete &&
          !contains &&
          !args.noAutoJob &&
          (wantsCompleteCensus(args) || session.remaining >= autoCensusMinRemaining())
        ) {
          const scopeLabel = [
            args.from ? `من ${String(args.from)}` : "",
            args.subject ? `موضوع ${String(args.subject)}` : "",
          ]
            .filter(Boolean)
            .join("، ");
          return launchCensusJob(
            ctx,
            scanArgs as CensusJobArgs,
            `حصر بنود البريد${scopeLabel ? " — " + scopeLabel : ""}`,
          );
        }
        // The item counts are only ever facts about the messages actually OPENED.
        // State the scope beside them so a staged scan cannot be relayed as the
        // whole year — the mailbox matched thousands, and a sample is not a total.
        // Name the REASON the scan stopped, from `truncatedReason`, so the model
        // never has to invent one (a live reply told the operator «الحد 400» when
        // the real ceiling was the time budget).
        const reason =
          scanCoverage.truncatedReason === "time"
            ? "بسبب ميزانية الوقت"
            : scanCoverage.truncatedReason === "error"
              ? "بسبب تعذّر جلب بعض الرسائل"
              : scanCoverage.truncatedReason === "count"
                ? "بسبب حد عدد الرسائل"
                : "";
        const scope =
          !allOpened || truncated
            ? `النطاق: فُتح ${coverage.messages} من ${census.matched} رسالة مطابقة (لم يُفحص الباقي${reason ? " " + reason : ""})`
            : `النطاق: كل الرسائل المطابقة (${census.matched})`;
        // The scan is staged, so an incomplete census is not a dead end: the next
        // call continues from the cursor. Say so, and tell the model to call the
        // tool again instead of reporting a sample as the year.
        const continueHint = complete
          ? ""
          : ` تبقّى ${session.remaining} رسالة لم تُفتح بعد. أعد نداء scan_email_items بنفس الوسائط لإكمال الحصر من حيث توقف — لا تعرض النتيجة كحصر كامل قبل أن يصبح isComplete=true.`;
        const partialDetail = [
          coverage.unreadable > 0 ? `تعذّرت قراءة ${coverage.unreadable} رسالة` : "",
          !allOpened || truncated ? `ولم تُفحص كل الرسائل${reason ? ` (${reason})` : ""}` : "",
        ]
          .filter(Boolean)
          .join("، ");

        // Only POs are counted, so say so — and say how many RFQs were skipped,
        // because the operator's rule is explicit that a quotation is not an
        // order. Silence here would look like the RFQs were counted.
        const docMix =
          coverage.rfqDocuments > 0
            ? ` المستندات: ${coverage.poDocuments} أمر شراء (تُحسب) و${coverage.rfqDocuments} طلب عرض/عرض سعر (مستبعد).`
            : coverage.poDocuments > 0
              ? ` المستندات: ${coverage.poDocuments} أمر شراء.`
              : "";

        if (args.exportCsv) {
          ctx.outbox.push({
            buffer: Buffer.from(itemsCsv(parsed), "utf8"),
            filename: `email-items-${new Date().toISOString().slice(0, 10)}.csv`,
            mimeType: CSV_UPLOAD_MIME,
          });
          ctx.outbox.push({
            buffer: Buffer.from(itemsAggregateCsv(ranked), "utf8"),
            filename: `email-items-summary-${new Date().toISOString().slice(0, 10)}.csv`,
            mimeType: CSV_UPLOAD_MIME,
          });
        }

        let pdfSent = false;
        if (args.exportPdf) {
          if (!ctx.settings.allowPdf) return { ok: false, error: "إنشاء PDF معطّل" };
          // The report states its own coverage: how many messages matched, how
          // many attachments were actually opened, and whether that was all of
          // them. A report that lists 20 parts without saying it read 381 of 480
          // documents invites the operator to trust a sample as a total.
          const scopeLine =
            !allOpened || truncated
              ? `النطاق: فُتح ${parsed.coverage.messages} من ${census.matched} رسالة مطابقة — الحصر ناقص، لم تُفحص كل الرسائل${reason ? ` (${reason})` : ""}.`
              : `النطاق: كل الرسائل المطابقة (${census.matched}) — الحصر كامل.`;
          const buffer = await generateAssistantPdf({
            title: "أكثر البنود تكرارًا في أوامر الشراء",
            subtitle:
              ordering === "qty"
                ? `أكثر ${top} بندًا كمية — من ${parsed.coverage.withItems} رسالة`
                : `أكثر ${top} بندًا تكرارًا (من ${minOrders} أوامر فأكثر) — من ${parsed.coverage.withItems} رسالة`,
            sections: [
              {
                paragraphs: [
                  `رسائل مطابقة: ${census.matched} — رسائل فُتحت مرفقاتها وقرأنا بنودها: ${parsed.coverage.withItems}.`,
                  `بنود مقروءة: ${parsed.coverage.lines} سطرًا من ${parsed.coverage.attachments} ملف.`,
                  `المستندات المحسوبة: ${parsed.coverage.poDocuments} أمر شراء فقط` +
                    (parsed.coverage.rfqDocuments
                      ? ` (واستُبعد ${parsed.coverage.rfqDocuments} طلب عرض/عرض سعر — ليست أوامر شراء).`
                      : ".") +
                    (parsed.coverage.unknownDocuments
                      ? ` ونوع ${parsed.coverage.unknownDocuments} مستند غير مؤكد (حُسبت بنودها).`
                      : ""),
                  scopeLine,
                  parsed.coverage.unreadable
                    ? `تنبيه: تعذّرت قراءة ${parsed.coverage.unreadable} رسالة.`
                    : "",
                  `ترتيب القائمة: ${ordering === "qty" ? "بحسب إجمالي الكمية" : "بحسب عدد أوامر الشراء التي ورد فيها البند (وليس الكمية)"}، ` +
                    (ordering === "qty"
                      ? "مع استبعاد ما لا يمكن تجميعه."
                      : `مع استبعاد أي بند ورد في أقل من ${minOrders} أمر شراء.`),
                  "هوية البند محسوبة من مجموعة بياناته كاملة (الوصف والمواصفات والموديل والمقاس والقدرة والوحدة) " +
                    "وليس من رقم القطعة وحده؛ لذلك قد يظهر أكثر من رقم قطعة لنفس البند.",
                  `بنود لم يمكن تحديد هويتها بشكل مؤكد (لا رقم قطعة ولا كود موديل): ${
                    ranked.filter((p) => !p.identityConfident).length
                  } من ${ranked.length}.`,
                  "إجمالي المبلغ لكل بند = مجموع إجماليات الأسطر (Line Totals) من كل أمر شراء على حدة — وليس الكمية الإجمالية × متوسط سعر الوحدة.",
                  "عمود «مصدر الإجمالي»: «من المستند» يعني أن المبلغ منقول من أمر الشراء مباشرةً، و«محسوب» يعني أنه حُسب من كمية × سعر نفس الأمر لعدم طبع إجمالي.",
                  "«Line Item» هو كود البند كما يطبعه EDC (مثال 1531.032.GENRAL.7538)، وهو مختلف عن رقم القطعة (Part Number).",
                  "«عدد الأوامر» يحسب أوامر الشراء المختلفة فقط؛ تكرار البند داخل نفس الأمر لا يزيد العدد.",
                ].filter(Boolean),
              },
              {
                table: {
                  columns: [
                    "الترتيب",
                    "وصف البند الكامل",
                    "رقم القطعة (Part Number)",
                    "Line Item",
                    "عدد أوامر الشراء",
                    "إجمالي الكمية",
                    "الوحدة",
                    "متوسط سعر الوحدة (للعلم)",
                    "إجمالي المبلغ (مجموع Line Totals)",
                    "مصدر الإجمالي",
                    "العملة",
                    "أرقام أوامر الشراء",
                  ],
                  rightAligned: ["وصف البند الكامل", "Line Item", "رقم القطعة (Part Number)"],
                  rows: ranked.slice(0, top).map((p, i) => [
                    i + 1,
                    p.description || "غير متوفر",
                    p.partNo ?? "غير متوفر",
                    // The ERP's own `Line Item` code — the value the operator
                    // asked for by name and by example (1531.032.GENRAL.7538).
                    p.lineItemNos.length ? p.lineItemNos.join("، ") : "غير متوفر",
                    p.occurrences,
                    p.qty,
                    p.uom ?? "غير متوفر",
                    p.avgUnitPrice != null ? p.avgUnitPrice.toFixed(2) : "غير متوفر",
                    p.totalValue != null ? p.totalValue.toFixed(2) : "غير متوفر",
                    p.totalValue == null
                      ? "غير متوفر"
                      : p.totalComputed
                        ? "محسوب (كمية × سعر نفس الأمر)"
                        : "من المستند",
                    p.avgUnitPrice != null || p.totalValue != null ? "EGP" : "غير متوفر",
                    p.documents.length ? p.documents.join("، ") : "غير متوفر",
                  ]),
                },
              },
            ],
          });
          ctx.outbox.push({
            buffer,
            filename: `email-items-${new Date().toISOString().slice(0, 10)}.pdf`,
            mimeType: "application/pdf",
          });
          pdfSent = true;
        }

        // A `contains` lookup answers about ONE brand/part: report its own
        // count, and when the scan was capped say plainly that older messages
        // were not searched — otherwise «مش موجود» reads as «لا يوجد في البريد»
        // when the truth is «لم أفحص هذه الفترة». This is exactly how the
        // Ariston follow-up looked wrong: the items were real but older than the
        // 400-message window.
        if (contains) {
          const filterNote =
            `بحث عن «${contains}» داخل ${coverage.messages} رسالة فُتحت ` +
            `(${coverage.lines} سطر بند من ${coverage.attachments} ملف). ` +
            `النتائج: ${matchedItems.length} سطرًا. ` +
            (truncated
              ? `تنبيه: لم تُفحص كل الرسائل — ${scope}. إن لم يظهر ما تبحث عنه فقد يكون في رسائل أقدم، ` +
                "فأعد النداء لإكمال الحصر، أو وسّع النطاق (sinceDate). لا تقل «غير موجود في البريد»." +
                continueHint
              : "تم فحص كل الرسائل المطابقة.");
          return {
            ok: true,
            data: {
              note: filterNote,
              contains,
              isComplete: complete,
              scope,
              hasAttachments: !noAttachments,
              ordering,
              matchedMessages: census.matched,
              scannedMessages: coverage.messages,
              remainingMessages: session.remaining,
              batches: session.batches,
              coverage,
              attachmentCoverage: scanCoverage,
              matchedLines: matchedItems.length,
              distinctParts: ranked.length,
              totalLines: coverage.lines,
              topItems: ranked.slice(0, top),
              csvSent: Boolean(args.exportCsv),
              pdfSent,
            },
          };
        }

        return {
          ok: true,
          data: {
            note: noAttachments
              ? census.senderResolution && !census.senderResolution.resolved
                ? // The sender filter matched NOBODY, so there is no scope to
                  // report an absence over. Saying «no readable attachments»
                  // here is what told the operator their POs were not in the
                  // mailbox when the search string was simply wrong.
                  `لم يطابق أي مُرسل «${census.senderResolution.requested}» — لم يُبحث بعد عن مُرسل صحيح، ` +
                  `فلا يُدّعى أنه لا توجد أوامر شراء. المُرسلون الموجودون فعلًا: ` +
                  `${census.senderResolution.observed?.join("، ") || "غير معروف"}.` +
                  (census.senderResolution.candidates.length
                    ? ` أو تطابق أكثر من مُرسل: ${census.senderResolution.candidates.join("، ")}.`
                    : "") +
                  " اطلب من المستخدم تحديد المُرسل الصحيح."
                : `لم أجد أي مرفق PDF يمكن قراءته في ${census.matched} رسالة مطابقة. ` +
                  "لا تقل إن الطلبات بلا بنود — قل إنه لم يُعثر على ملفات بنود في هذا النطاق، وجرّب وسّع المدة أو غيّر المُرسل."
              : `حصر بنود من مرفقات البريد: ${census.matched} رسالة مطابقة، فُتح مرفق ${coverage.messages} رسالة، ` +
                `وقُرئ ${coverage.lines} سطر بند من ${coverage.attachments} ملف.` +
                docMix +
                " " +
                scope +
                (complete
                  ? " — الحصر كامل على كل الرسائل المطابقة."
                  : ` — تنبيه: الحصر جزئي (${partialDetail}). اذكر أن الترتيب مبني على المفحوص حتى الآن ولا تدّعِ الكمال.` +
                    continueHint),
            isComplete: complete,
            scope,
            hasAttachments: !noAttachments,
            ordering,
            matchedMessages: census.matched,
            scannedMessages: coverage.messages,
            remainingMessages: session.remaining,
            batches: session.batches,
            coverage,
            attachmentCoverage: scanCoverage,
            senderResolution: census.senderResolution ?? null,
            distinctParts: parsed.aggregate.length,
            totalLines: coverage.lines,
            // The counts the operator asked for, so the final report relays facts
            // instead of estimates. `poDocuments`/`rfqDocuments` make the PO-only
            // rule auditable: a quotation read but excluded is visible, not
            // silently absent.
            poDocuments: coverage.poDocuments,
            rfqDocumentsExcluded: coverage.rfqDocuments,
            unknownDocuments: coverage.unknownDocuments,
            // The final-report numbers the operator asked for, computed HERE so
            // the model relays facts rather than estimating them. A census that
            // has not finished must not look finished: `completionPct` is the
            // share of matched messages actually opened, and
            // `identityUncertain` counts the items whose identity rests on prose
            // alone (no part number, no model code) — the operator explicitly
            // asked for that count and for the scan to continue until 100%.
            completionPct:
              census.matched > 0
                ? Math.min(100, Math.round((coverage.messages / census.matched) * 100))
                : 100,
            totalAttachments: coverage.attachments,
            identityUncertain: ranked.filter((p) => !p.identityConfident).length,
            // Ranked by how MANY orders carried the part by default — the
            // «أكتر بند اتكرر» answer — with occurrences always present so the
            // model can quote the count.
            topItems: ranked.slice(0, top),
            csvSent: Boolean(args.exportCsv),
            pdfSent,
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
        // WhatsApp. A readable document (PDF / image) is ALSO extracted to text,
        // so a question about its contents ("إيه البنود والكميات جوه الملف؟") is
        // answered from the real file rather than from the email body — the
        // whole point when the body itself carries no item details.
        //
        // A PDF is detected by CONTENT as well as the declared type: EDC labels
        // its PDF attachments `application/doc`, so keying on the MIME alone
        // both mislabelled the file on WhatsApp and skipped local extraction.
        const isPdf = isPdfAttachment({
          mimeType: att.mimeType,
          filename: att.filename,
          content: att.content,
        });
        const textLike = isTextLikeMime(att.mimeType);
        ctx.outbox.push({
          buffer: att.content,
          filename: att.filename,
          mimeType: isPdf ? "application/pdf" : att.mimeType || "application/octet-stream",
        });

        if (textLike) {
          return {
            ok: true,
            data: {
              sent: true,
              filename: att.filename,
              mimeType: att.mimeType,
              size: att.size,
              content: att.content.toString("utf8").slice(0, 12_000),
            },
          };
        }

        // `read: false` skips extraction for a plain "send me the file" request.
        const shouldRead = args.read !== false;
        if (shouldRead && (isPdf || isReadableDocumentMime(att.mimeType || ""))) {
          // A PDF with a text layer is read LOCALLY first: the Gemini path is
          // quota-limited (20 requests/day/model) and returns null once the day
          // is spent, which is how "read the PDF" turned into a generic failure.
          // The inline type is reported as a PDF too, so a provider that sniffs
          // the declared type does not reject bytes it already has.
          const inlineMime = isPdf ? "application/pdf" : att.mimeType || "application/octet-stream";
          const extracted = isPdf
            ? (await extractPdfText(att.content)).slice(0, MAX_DOCUMENT_CHARS) ||
              (await extractDocumentText(
                att.content,
                inlineMime,
                ctx.settings.baseUrl,
                ctx.settings.model,
              ))
            : await extractDocumentText(
                att.content,
                inlineMime,
                ctx.settings.baseUrl,
                ctx.settings.model,
              );
          if (extracted) {
            return {
              ok: true,
              data: {
                sent: true,
                filename: att.filename,
                mimeType: att.mimeType,
                size: att.size,
                content: extracted.slice(0, MAX_DOCUMENT_CHARS),
                note: "تم إرسال الملف للمستخدم على واتساب، وهذا محتواه لتستخرج منه البنود والكميات.",
              },
            };
          }
          // Extraction unavailable (non-Gemini endpoint, or quota exhausted).
          // Say so rather than letting the model describe a file it never read.
          return {
            ok: true,
            data: {
              sent: true,
              filename: att.filename,
              mimeType: att.mimeType,
              size: att.size,
              readFailed: true,
              note:
                "تم إرسال الملف للمستخدم على واتساب، لكن تعذّرت قراءة محتواه الآن. " +
                "أخبر المستخدم أن الملف أُرسل ولا تدّعِ معرفة ما بداخله.",
            },
          };
        }

        return {
          ok: true,
          data: {
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
        // P7: sending is an irreversible external action, so it is gated behind an
        // explicit confirmation. Without it the tool returns the draft for review
        // and sends NOTHING — the model must show it to the operator and re-call
        // with confirmed:true. This is enforced here, in code, rather than trusted
        // to the prompt, because a prompt rule is not a permission boundary.
        if (args.confirmed !== true) {
          return {
            ok: true,
            data: {
              sent: false,
              needsConfirmation: true,
              draft: {
                to: String(args.to ?? ""),
                cc: args.cc ? String(args.cc) : undefined,
                subject: String(args.subject ?? ""),
                body: String(args.body ?? ""),
              },
              instructions:
                "لم يُرسل البريد. اعرض هذا الملخّص على المستخدم واطلب تأكيدًا صريحًا، " +
                "ثم أعد الاستدعاء بنفس البيانات مع confirmed=true.",
            },
          };
        }
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
      case "remember_fact": {
        const row = await rememberFact({
          phone: args.shared ? "" : ctx.phone,
          category: args.category ? String(args.category) : "fact",
          key: String(args.key ?? ""),
          value: String(args.value ?? ""),
          importance: typeof args.importance === "number" ? args.importance : undefined,
          source: args.shared ? "admin" : "user",
        });
        return {
          ok: true,
          data: {
            saved: true,
            id: row.id,
            key: row.key,
            value: row.value,
            scope: row.phone ? "خاص" : "مشترك",
          },
        };
      }
      case "recall_memory": {
        const rows = await recallMemories({
          phone: ctx.phone,
          query: args.query ? String(args.query) : undefined,
          category: args.category ? String(args.category) : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          trackUse: true,
        });
        return {
          ok: true,
          data: {
            count: rows.length,
            memories: rows.map((m) => ({
              id: m.id,
              category: m.category,
              key: m.key,
              value: m.value,
              importance: m.importance,
              pinned: m.pinned,
              scope: m.phone ? "خاص" : "مشترك",
            })),
            note: rows.length
              ? "هذه معلومات محفوظة في ذاكرتك — استخدمها في الرد."
              : "لا توجد معلومة محفوظة مطابقة. لا تدّعِ أنك تعرفها؛ اسأل المستخدم أو ابحث بالأدوات.",
          },
        };
      }
      case "forget_memory": {
        const removed = await forgetMemory({
          phone: ctx.phone,
          key: args.key ? String(args.key) : undefined,
          id: typeof args.id === "number" ? args.id : undefined,
        });
        return {
          ok: true,
          data: {
            closed: removed,
            note: removed ? "تم إنهاء صلاحية المعلومة." : "لم أجد معلومة مطابقة.",
          },
        };
      }
      case "job_status": {
        const one = typeof args.id === "number" ? await getJob(args.id) : null;
        const rows = one ? [one] : await listJobs(ctx.phone, Math.min(Number(args.limit ?? 5), 20));
        if (!rows.length) {
          return {
            ok: true,
            data: { count: 0, note: "لا توجد مهام خلفية لهذا الرقم." },
          };
        }
        return {
          ok: true,
          data: {
            count: rows.length,
            jobs: rows.map((j) => {
              const r = (j.result ?? {}) as Record<string, unknown>;
              // Delivery evidence, read straight from the stored artifact. The
              // assistant must not tell the operator "تم الإرسال" without a
              // message id being present here — that claim is what made a lost
              // report look delivered.
              const delivered = Boolean(r.pdfMessageId || r.textMessageId);
              return {
                id: j.id,
                kind: j.kind,
                status: j.status,
                question: j.question,
                progress: j.progress,
                error: j.error,
                summary: describeJob(j),
                startedAt: j.startedAt,
                finishedAt: j.finishedAt,
                delivered,
                textMessageId: r.textMessageId ?? null,
                pdfMessageId: r.pdfMessageId ?? null,
                pdfError: r.pdfError ?? null,
                resultSummary:
                  r.matched != null
                    ? {
                        matched: r.matched,
                        opened: r.opened,
                        files: r.files,
                        pages: r.pages,
                        lines: r.lines,
                        complete: r.complete,
                      }
                    : null,
                topItems: Array.isArray(r.topItems) ? r.topItems : null,
              };
            }),
            note:
              "هذه حالة المهام كما هي في قاعدة البيانات — لا تخمّن تقدمًا غير مذكور هنا. " +
              "‏`delivered=true` وحدها تعني أن التقرير أُرسل فعلًا (مع pdfMessageId). " +
              "إن كانت `delivery_failed` أو `delivered=false` فلا تقل إن التقرير وصل؛ " +
              "أخبر المستخدم بفشل الإرسال وأن النتيجة محفوظة ويمكن إعادة إرسالها.",
          },
        };
      }
      case "cancel_job": {
        const id = Number(args.id);
        if (!Number.isFinite(id)) return { ok: false, error: "حدّد رقم المهمة (id)." };
        const job = await cancelJob(id);
        if (!job) return { ok: false, error: `لا توجد مهمة بالرقم ${id}.` };
        return {
          ok: true,
          data: {
            id: job.id,
            status: job.status,
            note:
              job.status === "cancelled"
                ? `تم إيقاف المهمة #${job.id}. لن يُرسَل تقريرها.`
                : `المهمة #${job.id} حالتها «${job.status}» بالفعل — لم أُوقفها.`,
          },
        };
      }
      case "resend_job_report": {
        // Re-send the STORED artifact. A re-scan would be the wrong answer on
        // two counts: it costs minutes, and it can disagree with the report the
        // operator already has (the earlier contradiction was exactly a second
        // search returning a different story).
        const id = Number(args.id);
        const jobs =
          Number.isFinite(id) && id > 0
            ? [await getJob(id)].filter(Boolean)
            : (await listJobs(ctx.phone, 20)).filter((j) => j.result != null);
        const job = jobs[0] as (typeof jobs)[number] | undefined;
        if (!job) {
          return {
            ok: false,
            error:
              Number.isFinite(id) && id > 0
                ? `لا توجد مهمة بالرقم ${id}.`
                : "لا توجد مهمة حصر مكتملة بنتيجة محفوظة — ابدأ الحصر أولًا.",
          };
        }
        const r = (job.result ?? {}) as Record<string, any>;
        if (!Array.isArray(r.topItems) || !r.topItems.length) {
          return { ok: false, error: `المهمة #${job.id} لا تحتوي على بنود محفوظة لإرسالها.` };
        }
        try {
          const { generateAssistantPdf } = await import("./pdf");
          const buffer = await generateAssistantPdf({
            title: "حصر بنود البريد (إعادة إرسال)",
            subtitle: `${Math.min(20, r.topItems.length)} بندًا محفوظًا من المهمة #${job.id}`,
            sections: [
              {
                paragraphs: [
                  `رسائل مطابقة: ${r.matched ?? 0}، فُتحت: ${r.opened ?? 0}، ` +
                    `صفحات: ${r.pages ?? 0}، بنود: ${r.lines ?? 0}.`,
                  String(r.scope ?? ""),
                ],
              },
              {
                table: {
                  columns: [
                    "الترتيب",
                    "وصف البند الكامل",
                    "رقم القطعة (Part Number)",
                    "Line Item",
                    "عدد أوامر الشراء",
                    "إجمالي الكمية",
                    "الوحدة",
                    "متوسط سعر الوحدة",
                    "إجمالي المبلغ",
                  ],
                  rightAligned: ["وصف البند الكامل", "Line Item", "رقم القطعة (Part Number)"],
                  rows: (r.topItems as any[])
                    .slice(0, 20)
                    .map((p, i) => [
                      i + 1,
                      p.description || "غير متوفر",
                      p.partNo ?? "—",
                      Array.isArray(p.lineItemNos) && p.lineItemNos.length
                        ? p.lineItemNos.join("، ")
                        : "—",
                      p.orders ?? 0,
                      p.qty ?? 0,
                      p.uom ?? "—",
                      p.avgUnitPrice != null ? Number(p.avgUnitPrice).toFixed(2) : "—",
                      p.totalValue != null ? Number(p.totalValue).toFixed(2) : "غير متوفر",
                    ]),
                },
              },
              {
                heading: "تفاصيل كل ظهور (PO / كمية / سعر الوحدة)",
                paragraphs: (r.topItems as any[]).slice(0, 20).map((p, i) => {
                  const ls = Array.isArray(p.lines) ? p.lines : [];
                  const det = ls
                    .map(
                      (l: any) =>
                        `PO ${l.docId} · كمية ${l.qty ?? "—"} · سعر ${
                          l.unitPrice ?? "غير متوفر"
                        }${l.lineTotal != null ? ` · إجمالي ${l.lineTotal}` : ""}`,
                    )
                    .join("\n");
                  return `${i + 1}. ${p.description}\n${det || "لا تفاصيل"}`;
                }),
              },
            ],
            footer: "إعادة إرسال من النتيجة المحفوظة — لم يُعَد الفحص.",
          });
          const messageId = await sendWhatsAppDocument(
            ctx.phone,
            buffer,
            `email-items-job-${job.id}.pdf`,
            "application/pdf",
            `تقرير حصر بنود EDC (إعادة إرسال) — ${r.topItems.length} بندًا`,
          );
          if (!messageId) {
            return { ok: false, error: "تعذّر إرسال التقرير على واتساب (لا يوجد messageId)." };
          }
          return {
            ok: true,
            data: {
              jobId: job.id,
              messageId,
              items: r.topItems.length,
              note: `أُعيد إرسال تقرير المهمة #${job.id} من النتيجة المحفوظة (لم يُعَد الفحص).`,
            },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, error: `فشل إعادة إرسال التقرير: ${msg}` };
        }
      }
      case "start_census_job": {
        if (!ctx.settings.allowEmail) return { ok: false, error: "الوصول للبريد معطّل" };
        const scanArgs: CensusJobArgs = {
          from: args.from ? String(args.from) : undefined,
          subject: args.subject ? String(args.subject) : undefined,
          query: args.query ? String(args.query) : undefined,
          sinceDate: args.sinceDate ? String(args.sinceDate) : undefined,
          beforeDate: args.beforeDate ? String(args.beforeDate) : undefined,
          mailbox: args.mailbox ? String(args.mailbox) : "*",
        };
        return launchCensusJob(ctx, scanArgs, String(args.question ?? "") || "حصر بنود البريد");
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
