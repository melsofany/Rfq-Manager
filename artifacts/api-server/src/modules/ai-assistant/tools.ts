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
  fetchMessageAttachments,
  extractPdfText,
  memoizeScan,
  scanCacheKey,
  type EmailCensusResult,
  type EmailCensusNumber,
} from "./email";
import {
  parseItemsFromAttachments,
  itemsCsv,
  itemsAggregateCsv,
  aggregateItems,
  aggregateItemsByOccurrence,
  type ItemScanResult,
} from "./email-items";
import { defaultMailbox, mailboxes } from "./mailboxes";
import { rememberFact, recallMemories, forgetMemory } from "./memory";
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
            from: { type: "string", description: "بريد المُرسل أو اسمه (مثل egyptian-drilling)" },
            subject: { type: "string", description: "كلمة في الموضوع (مثل RFQ أو PO)" },
            query: { type: "string", description: "كلمة في الموضوع/المُرسل" },
            sinceDate: { type: "string", description: "بداية الفترة YYYY-MM-DD" },
            beforeDate: { type: "string", description: "نهاية الفترة YYYY-MM-DD (غير شاملة)" },
            mailbox: { type: "string", description: "بريد محدّد (اتركه فارغًا لكل البريد)" },
            limit: {
              type: "integer",
              description:
                "أقصى عدد رسائل تُفتح مرفقاتها (افتراضي 400). العدد المطابق الكلي يُعاد دائمًا، " +
                "وإن كان أكبر من الحد فاذكر أن الترتيب مبني على أحدث المفحوص فقط.",
            },
            top: {
              type: "integer",
              description: "عدد البنود الأكثر تكرارًا في الملخص (افتراضي 50)",
            },
            ordering: {
              type: "string",
              enum: ["mostRepeated", "qty"],
              description:
                "ترتيب البنود: mostRepeated (افتراضي) = الأكثر تكرارًا/ورودًا، " +
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
        // The scan+parse is MEMOIZED on the scan arguments (NOT on `contains`,
        // which is applied to the already-parsed rows). A follow-up question
        // about the same mail — «ليه السخانات الأريستون مش في التقرير؟» right
        // after «اكتر بند اتكرر» — otherwise re-ran a ~30-100s scan and blew the
        // agent's budget, answering with a timeout. The memo holds the small
        // parsed rows, never the downloaded PDF buffers.
        const scanArgs = {
          from: args.from ? String(args.from) : undefined,
          subject: args.subject ? String(args.subject) : undefined,
          query: args.query ? String(args.query) : undefined,
          sinceDate: args.sinceDate ? String(args.sinceDate) : undefined,
          beforeDate: args.beforeDate ? String(args.beforeDate) : undefined,
          mailbox: requested,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        };

        const { census, parsed } = await memoizeScan(scanCacheKey("items", scanArgs), async () => {
          const c = await scanEmails({
            ...scanArgs,
            folder: "inbox",
            includeAttachments: true,
            returnAllMatches: true,
          });
          const p = await parseItemsFromAttachments(c.attachmentMessages ?? []);
          return { census: c, parsed: p };
        });

        const top = Math.min(Math.max(Number(args.top ?? 50), 1), 300);
        const truncated = census.attachmentCoverage?.truncated ?? false;

        // A brand/part lookup («فين السخانات الأريستون؟») is a filter over the
        // rows already parsed — it must never look like a fresh census.
        const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
        const needle = norm(contains);
        const matchedItems = contains
          ? parsed.items.filter(
              (i) => norm(i.description).includes(needle) || norm(i.partNo ?? "").includes(needle),
            )
          : parsed.items;

        // Default to FREQUENCY: «أكتر بند اتكرر» is the common ask, and ranking
        // by quantity alone answers a different question (one huge one-off order
        // would top it). The quantity view stays available for volume questions.
        const ordering = args.ordering === "qty" ? "qty" : "mostRepeated";
        const ranked =
          ordering === "qty"
            ? aggregateItems(matchedItems)
            : aggregateItemsByOccurrence(matchedItems);

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
          const buffer = await generateAssistantPdf({
            title: "بنود الطلبات من البريد الإلكتروني",
            subtitle:
              ordering === "qty"
                ? `أكثر ${top} بندًا كمية — من ${parsed.coverage.withItems} رسالة`
                : `أكثر ${top} بندًا تكرارًا — من ${parsed.coverage.withItems} رسالة`,
            sections: [
              {
                paragraphs: [
                  `رسائل مطابقة: ${census.matched} — رسائل فُتحت مرفقاتها: ${parsed.coverage.messages}`,
                  `بنود مقروءة: ${parsed.coverage.lines} سطرًا من ${parsed.coverage.attachments} ملف.`,
                  parsed.coverage.unreadable || census.attachmentCoverage?.truncated
                    ? "تنبيه: الحصر ناقص — بعض المرفقات لم تُقرأ أو لم تُفحص كلها."
                    : "تم فحص كل المرفقات المطابقة.",
                ],
              },
              {
                table: {
                  columns: ["رقم القطعة", "التوصيف", "مرات التكرار", "إجمالي الكمية", "الوحدة"],
                  rows: ranked
                    .slice(0, top)
                    .map((p) => [p.partNo ?? "", p.description, p.occurrences, p.qty, p.uom ?? ""]),
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

        const coverage = parsed.coverage;
        // A complete scan that found ZERO files is not "the orders have no
        // items" — it means no attachment was recognised. Saying so prevents the
        // honest-looking "0 بنود، الحصر كامل" the model would otherwise report.
        const noAttachments = coverage.attachments === 0;
        const complete = !noAttachments && coverage.unreadable === 0 && !truncated;
        // The item counts are only ever facts about the messages actually OPENED.
        // State the scope beside them so a capped scan cannot be relayed as the
        // whole year — the mailbox matched thousands, and a sample is not a total.
        const scope = truncated
          ? `النطاق: أحدث ${coverage.messages} رسالة من ${census.matched} مطابقة (لم يُفحص الباقي)`
          : `النطاق: كل الرسائل المطابقة (${census.matched})`;
        const partialDetail = [
          coverage.unreadable > 0 ? `تعذّرت قراءة ${coverage.unreadable} رسالة` : "",
          truncated ? "ولم تُفحص كل الرسائل" : "",
        ]
          .filter(Boolean)
          .join("، ");

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
                "فوسّع النطاق (sinceDate) أو خفّض from ثم أعد المحاولة. لا تقل «غير موجود في البريد»."
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
              coverage,
              attachmentCoverage: census.attachmentCoverage ?? null,
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
              ? `لم أجد أي مرفق PDF يمكن قراءته في ${census.matched} رسالة مطابقة. ` +
                "لا تقل إن الطلبات بلا بنود — قل إنه لم يُعثر على ملفات بنود في هذا النطاق، وجرّب وسّع المدة أو غيّر المُرسل."
              : `حصر بنود من مرفقات البريد: ${census.matched} رسالة مطابقة، فُتح مرفق ${coverage.messages} رسالة، ` +
                `وقُرئ ${coverage.lines} سطر بند من ${coverage.attachments} ملف. ` +
                scope +
                (complete
                  ? " — الحصر كامل على كل الرسائل المطابقة."
                  : ` — تنبيه: الحصر جزئي (${partialDetail}). اذكر أن الترتيب مبني على العينة المفحوصة ولا تدّعِ الكمال.`),
            isComplete: complete,
            scope,
            hasAttachments: !noAttachments,
            ordering,
            matchedMessages: census.matched,
            coverage,
            attachmentCoverage: census.attachmentCoverage ?? null,
            distinctParts: parsed.aggregate.length,
            totalLines: coverage.lines,
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
