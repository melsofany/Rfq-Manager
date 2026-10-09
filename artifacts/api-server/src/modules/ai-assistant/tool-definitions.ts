/**
 * AI Assistant — tool DEFINITIONS (the JSON schemas the model sees).
 *
 * Split out of `tools.ts`, which had grown to ~3,900 lines with the schemas and
 * the executors in one file. Keeping the schema list apart means a prompt-facing
 * change (a description, a parameter) is reviewed on its own, and the executor
 * file is no longer where a schema edit has to be found.
 *
 * Behaviour-neutral: the function body is moved verbatim. `toolDefinitions` is
 * still re-exported from `tools.ts`.
 */
import { isEmailReadConfigured } from "./email";
import { sqlColumnCatalogue, tableListForPrompt } from "./db-tools";
import type { ToolDefinition } from "./llm";
import type { ToolContext } from "./tools";

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
        name: "run_readonly_query",
        description:
          "تنفيذ استعلام SQL **للقراءة فقط** على قاعدة بيانات النظام عندما لا تكفي الأدوات الجاهزة " +
          "(مثل تجميع أو ربط لا تدعمه الأدوات، أو إحصاء بشروط مركّبة). " +
          "القراءة فقط إلزاميًا: يُرفض أي INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/COPY وأي كلمة تعديل، " +
          "ويُرفض تعدد الاستعلامات. لا يمكن حذف أو تعديل أي شيء من هذه الأداة — هذا قيد على مستوى قاعدة البيانات نفسها. " +
          "استخدمها كخيار أخير بعد الأدوات الجاهزة، واكتب SELECT واضحًا مع LIMIT. " +
          "أسماء أعمدة SQL بصيغة snake_case (مثل internal_no) وليست مفاتيح camelCase التي ترجعها الأدوات (internalNo)؛ " +
          "هذه أعمدة الجداول الأساسية، وللباقي استدعِ describe_schema:\n" +
          sqlColumnCatalogue(),
        parameters: {
          type: "object",
          properties: {
            sql: {
              type: "string",
              description:
                "استعلام SELECT واحد فقط (أو WITH … SELECT). بلا فاصلة منقوطة في المنتصف وبلا أي كلمة تعديل.",
            },
          },
          required: ["sql"],
        },
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
        name: "aggregate_customer_po_items",
        description:
          "تقرير كل الأصناف التي تم توريدها للعملاء من جدول بنود أوامر شراء العملاء (customer_po_items)، " +
          "بتجميع SQL كامل — يقرأ كل السطور ولا يعرض عيّنة. " +
          "يعيد الصنف ووصفه وإجمالي كميته وعدد مرات وروده، وبدون تكرار (يدمج الكتابات المختلفة لنفس الصنف). " +
          "استخدمها لأي طلب تقرير/حصر للأصناف المورَّدة (مثال: «كل الأصناف المورَّدة في 2025 و2026 بكمياتها»). " +
          "الأرقام محسوبة في قاعدة البيانات — لا تجمعها بنفسك ولا تختصر القائمة. " +
          "لطلب «بدون تكرار» هذه الأداة تدمج تكرارات نفس الصنف تلقائيًا. " +
          "**لطلب ملف/تقرير PDF مرّر exportPdf=true** (وللـCSV مرّر exportCsv=true): الملف يُبنى على الخادم " +
          "بكل الأصناف تلقائيًا ويُرسل على واتساب. لا تُمرّر الصفوف إلى generate_pdf — لن تحملها كلها. " +
          "حقل rows في الرد نافذة للعرض فقط، وعدد الأصناف الحقيقي في count.",
        parameters: {
          type: "object",
          properties: {
            fromDate: {
              type: "string",
              description: "تاريخ بداية (YYYY-MM-DD) على تاريخ أمر شراء العميل — مثال 2025-01-01",
            },
            toDate: {
              type: "string",
              description: "تاريخ نهاية غير شامل (YYYY-MM-DD) — مثال 2027-01-01",
            },
            match: {
              type: "string",
              description: "قصر على أصناف يحتوي وصفها/رقمها على هذه الكلمة",
            },
            minQty: {
              type: "number",
              description: "أقل كمية إجمالية لإظهار الصنف (لفلترة الأصناف الدقيقة)",
            },
            includeDetached: {
              type: "boolean",
              description: "تضمين البنود المحذوفة من أوامر الشراء (افتراضي لا)",
            },
            exportPdf: {
              type: "boolean",
              description: "أرسل ملف PDF بكل الأصناف والكميات على واتساب (يُبنى على الخادم)",
            },
            exportCsv: {
              type: "boolean",
              description: "أرسل ملف CSV بكل الأصناف (مفيد للأعداد الكبيرة والمراجعة)",
            },
            pdfTitle: { type: "string", description: "عنوان ملف الـPDF" },
            source: {
              type: "string",
              description:
                "نص طلب المستخدم/البرومبت حرفيًا ليُطبع داخل الملف (عندما يطلب «اكتب الملف بالبرومبت»)",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "aggregate_po_items",
        description:
          "أكثر البنود تكرارًا/كمية عبر بنود أوامر الشراء **الصادرة مننا للموردين** " +
          "(purchase_order_items)، بتجميع SQL. " +
          "by=qty (افتراضي) للترتيب بإجمالي الكمية، by=occurrences للترتيب بعدد مرات الورود. " +
          "**لا تستخدمها لأوامر شراء العملاء** (EDC وأمثالها) — تلك في جدول customer_po_items " +
          "وأداتها aggregate_customer_po_items. هذا الجدول صغير جدًا، فاستخدامه للسؤال عن " +
          "أوامر العملاء يُرجع رقمًا صغيرًا وينفي آلاف السجلات الموجودة.",
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
            query: {
              type: "string",
              description:
                "كلمة في **الموضوع أو المُرسل فقط** — وليس في محتوى الملفات. " +
                "لا تمرّر هنا اسم بند/صنف/ماركة (مثل «Maico EZQ»): وصف البند لا يوجد في الموضوع، " +
                "فيمرّ الفلتر بلا مطابقة ويبدو كأن البريد فارغ. للبحث عن بند/صنف/ماركة استخدم contains.",
            },
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
            qty: {
              type: "number",
              description:
                "الكمية المطلوبة بالضبط على السطر (مثل 230). مرّرها حين يذكر المدير كمية بعينها — " +
                "فلتر على السطر نفسه، فيُرجع أوامر الشراء التي فيها هذه الكمية فقط.",
            },
            terms: {
              type: "array",
              items: { type: "string" },
              description:
                'كلمات يجب أن تظهر كلها في سطر البند (مثل ["70", "12"] للمقاس). ' +
                "ضع الاسم الكامل في contains («cable lug») ولا تختصره لكلمة مبتورة مثل «lug» لأنها تطابق كلمات أخرى.",
            },
            docKind: {
              type: "string",
              enum: ["po", "rfq", "all"],
              description:
                "نوع المستند المطلوب: po = أوامر الشراء فقط، rfq = طلبات التسعير/عروض السعر فقط، " +
                "all = الاثنان معًا. الافتراضي في قائمة التكرار هو po، لكن أي سؤال عن «طلبات التسعير» " +
                "أو «الطلبات الواردة» أو «هل ظهر البند في الطلبات؟» يجب أن يستخدم rfq أو all، " +
                "وإلا فستكون الإجابة صفرًا لأن أوامر الشراء لا تحتوي الطلب الأصلي. " +
                "في وضع all يُذكر لكل بند من أي نوع جاء العدد.",
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
            source: {
              type: "string",
              description:
                "المصدر/البرومبت الذي طلب به المستخدم التقرير — يُطبع في الملف. " +
                "انسخ نص طلب المستخدم هنا حرفيًا عندما يطلب «اكتب الملف بالبرومبت».",
            },
          },
          required: ["title", "sections"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "learn_organization",
        description:
          "تعلّم كل ما يمكن معرفته عن جهة (شركة/مورد/عميل): اسمها وأسماؤها البديلة، " +
          "نطاق بريدها، الصندوق الذي تصل إليه مستنداتها، و**أنماط أرقام مستنداتها** " +
          "(مثال: طلبات التسعير تبدأ بـ 26 ثم R، وأوامر الشراء تبدأ بـ P ثم 26 ثم E). " +
          "استخدمها عندما يشرح المستخدم أسماءً أو صيغ أرقام أو معاني أجزائها، أو عند استنتاج " +
          "قاعدة من عدة مستندات رأيتها. النمط يُشتق تلقائيًا من الأمثلة التي تعطيها في examples. " +
          "بعد التعلّم ستتعرّف على أرقام لم ترها من قبل — لا تعِد تعلّم نفس الشيء.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "اسم الجهة كما نطقها المستخدم أو كما وردت في البريد (مثال: «شركة الحفر المصرية» أو EDC).",
            },
            aliases: {
              type: "array",
              items: { type: "string" },
              description: "كل الأسماء التي تُعرف بها (EDC، Egyptian Drilling، الحفر المصرية…).",
            },
            domains: {
              type: "array",
              items: { type: "string" },
              description: "نطاقات بريدها (مثال: edc-egypt.com).",
            },
            mailboxes: {
              type: "array",
              items: { type: "string" },
              description: "صناديق البريد التي تصل إليها مستنداتها (مثال: info).",
            },
            examples: {
              type: "array",
              description:
                "أمثلة على أرقام مستنداتها. كل مثال: {number, kind} حيث kind = po أو rfq أو invoice. " +
                "كن صادقًا: مثال واحد كافٍ إذا أكّده المستخدم، لكن لا تخترع أمثلة.",
              items: {
                type: "object",
                properties: {
                  number: {
                    type: "string",
                    description: "رقم مستند فعلي رأيته (مثال: P26E11407).",
                  },
                  kind: {
                    type: "string",
                    enum: ["po", "rfq", "invoice", "quotation", "other"],
                    description: "نوع المستند.",
                  },
                },
                required: ["number"],
              },
            },
            meaning: {
              type: "string",
              description:
                "معنى أجزاء الرقم كما شرحه المستخدم (مثال: «26 = السنة، R = طلب تسعير» أو " +
                "«P = أمر شراء، 26 = السنة، E = EDC، والباقي رقم مسلسل»). هذا هو الجزء الذي " +
                "لا يمكن استنتاجه من شكل المستند وحده — يُسجَّل قاعدة مع النمط.",
            },
            notes: {
              type: "string",
              description: "أي معلومة أخرى عن الجهة (اتفاقيات، مواعيد، طريقة التعامل).",
            },
          },
          required: ["name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "classify_document_number",
        description:
          "اسأل عمّا تعرفه عن رقم مستند: أي جهة تُصدره وما نوعه (أمر شراء/طلب تسعير/فاتورة)، " +
          "استنادًا إلى الأنماط التي تعلّمتها. استخدمها قبل أن تخمّن نوع رقم غير مألوف. " +
          "إن لم تطابق أي نمط معروف فستُعيد matched=false — عندها قل إن النمط غير معروف " +
          "ولا تجبره على نمط قريب.",
        parameters: {
          type: "object",
          properties: {
            number: { type: "string", description: "رقم المستند (مثال: P26E11407 أو 26R011936)." },
          },
          required: ["number"],
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
        name: "describe_schema",
        description:
          "اقرأ بنية قاعدة البيانات الحقيقية: بدون table تعيد قائمة الجداول، ومع table تعيد أعمدته وأنواعها. " +
          "استخدمها قبل كتابة SQL إن لم تكن متأكدًا من اسم جدول أو عمود، وعند أي خطأ «does not exist» في read-only query.",
        parameters: {
          type: "object",
          properties: {
            table: { type: "string", description: "اسم الجدول (اختياري)" },
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
            contains: {
              type: "string",
              description:
                "بند/ماركة/كود Line Item للبحث عنه داخل المرفقات («EZQ 20/4»، «أريستون»). " +
                "يُستخدم لسؤال «البند ده اتطلب كام مرة وكميته الإجمالية؟» — العدّ والإجمالي " +
                "صحيحان فقط بعد قراءة كل المطابقات، ولهذا يُسلَّم للمهمة الخلفية.",
            },
            qty: {
              type: "number",
              description:
                "الكمية المطلوبة بالضبط على السطر (مثل 230). مرّرها حين يذكر المدير كمية بعينها — " +
                "فلتر على السطر نفسه، فيُرجع أوامر الشراء التي فيها هذه الكمية فقط.",
            },
            terms: {
              type: "array",
              items: { type: "string" },
              description:
                'كلمات يجب أن تظهر كلها في سطر البند (مثل ["70", "12"] للمقاس). ' +
                "ضع الاسم الكامل في contains («cable lug») ولا تختصره لكلمة مبتورة مثل «lug» لأنها تطابق كلمات أخرى.",
            },
            docKind: {
              type: "string",
              enum: ["po", "rfq", "all"],
              description:
                "po = أوامر الشراء فقط، rfq = طلبات التسعير فقط، all = الاثنان. " +
                "أي سؤال عن «طلبات التسعير» يجب أن يستخدم rfq أو all.",
            },
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
