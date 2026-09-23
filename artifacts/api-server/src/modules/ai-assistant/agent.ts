/**
 * AI Assistant — agent loop.
 *
 * Runs a tool-calling conversation against the LLM: takes the operator's
 * message (text or image), lets the model call any registered tool, feeds the
 * results back, and loops until the model produces a final answer. Conversation
 * history is persisted per phone for multi-turn context.
 */
import { db, aiAssistantMessagesTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { logger } from "../../shared/logger";
import {
  chatCompletion,
  transcribeAudio,
  extractDocumentText,
  MAX_DOCUMENT_CHARS,
  isTimeoutError,
  isQuotaError,
  type ChatMessage,
  type ContentPart,
  type ToolCall,
} from "./llm";
export { MAX_DOCUMENT_CHARS } from "./llm";
import { loadSettings, MAX_HISTORY, type AiSettings } from "./config";
import { recallMemories, renderMemoryBlock, distillMemories } from "./memory";
import {
  toolDefinitions,
  executeTool,
  asText,
  type ToolContext,
  type OutboxAttachment,
} from "./tools";
import { entityVocabulary, findUnknownEntityNames, type EntityName } from "./db-tools";
import { routeQuestion, routeHint, DEEP_MAX_ROUNDS } from "./router";
import { verifyAnswer } from "./verifier";
import { recordMetrics } from "./metrics";
import {
  loadConversationState,
  saveConversationState,
  renderConversationState,
  inferStatePatch,
} from "./conversation";

/**
 * Rounds allowed for the DEEP path (the router picks it per question). Kept as
 * an alias of the router's constant so there is one source of truth.
 */
export const MAX_TOOL_ROUNDS = DEEP_MAX_ROUNDS;

/**
 * Hard ceiling on one whole answer, across every tool round and model fallback.
 *
 * The operator is waiting live in a chat window. Past this, a late answer is
 * worse than an honest timeout: they have already given up and concluded they
 * are being ignored — the reported symptom. Set above the per-completion budget
 * so a single completion can use its full share, but far below the worst case of
 * rounds × models × attempts × timeout.
 */
export const AGENT_BUDGET_MS = 150_000;

/**
 * Rounds with the full toolset before the last one, which forbids tools. A
 * model that never stops calling tools would otherwise exhaust the budget and
 * leave `finalText` null — surfacing as "no final answer" to the operator.
 */
const FORCE_ANSWER_ON_LAST_ROUND = true;

/**
 * Least time that must remain in the run budget before a grounding-verification
 * round is attempted. The operator is waiting live: if there is not enough time
 * for another provider round-trip, shipping the answer as-is beats a timeout
 * notice. See `verifyGroundedAnswer`.
 */
export const VERIFY_MIN_REMAINING_MS = 30_000;

/**
 * Least time that must remain before a second re-ask is attempted, and the
 * ceiling on how many times one run may re-ask. The re-ask exists for the case
 * where the model met a genuinely empty result and gave up: it is worth one more
 * attempt, never an open loop (the operator is waiting and the quota is scarce).
 */
export const RETRY_MIN_REMAINING_MS = 35_000;
export const MAX_REFUSAL_REASKS = 1;

/** How much of the known supplier/customer list to put in the prompt. */
const VOCAB_PROMPT_LIMIT = 120;

const LANGUAGE_NAME: Record<string, string> = { ar: "العربية", en: "English" };

export function systemPrompt(settings: AiSettings): string {
  const lang = LANGUAGE_NAME[settings.language] ?? "العربية";
  const base = `أنت «المساعد الذكي» لنظام قرطبة للتوريدات لإدارة طلبات عروض الأسعار وأوامر الشراء.
لديك صلاحية القراءة لكل بيانات النظام (العملاء، الموردين، طلبات التسعير، أوامر الشراء، العروض، الاستلامات، التسليمات، الفواتير، المحاسبة، سجل الواتساب) وبريد الشركة.
مهامك:
- الإجابة على أي سؤال عن أي معلومة داخل النظام بالبحث في قاعدة البيانات وأدوات أخرى.
- جلب معلومات البريد الإلكتروني وقراءتها، وإرسال مرفقاته على واتساب.
- قراءة الصور والملفات التي يرسلها المستخدم وتحليلها.
- إنشاء ملفات PDF (تقارير/ملخصات/مستندات) وإرسالها للمستخدم عند طلبها.

قواعد صارمة ضد التخمين (الأهم على الإطلاق):
- لا تذكر أي اسم مورد أو عميل أو رقم أو مبلغ لم ترَه حرفيًا في نتيجة أداة. أي معلومة لا تظهر في نتيجة أداة = غير معروفة، فقل «غير متوفر» ولا تؤلّفها.
- راجع حقل «searchNote» في نتيجة search_database. إذا كان searchApplied=false فالنتائج غير مفلترة ولا تصلح كإجابة عن البحث — أعد البحث بجدول أو كلمة أخرى، أو أخبر المستخدم أن البحث لم يفلح.
- لا تستنتج اسمًا من رقم (id). إذا ظهر لك رقم مورد فقط، استخدم supplier_overview أو search_database على جدول suppliers لجلب الاسم الحقيقي.
- لا تنسب أمر شراء إلى مورد إلا إذا ظهر اسم المورد صراحة في صفوف ذلك الأمر أو بنوده.
- إذا قال المستخدم إنك أخطأت، لا تُقدّم تخمينًا آخر. أعد التحقق بالأدوات، واذكر مصدر كل معلومة، وإن لم تجدها فاعتذر بوضوح واذكر ما بحثت فيه بالضبط.
- عند ذكر أي معلومة، اذكر مصدرها بإيجاز (مثال: «من جدول بنود أوامر الشراء: البند كذا في الأمر كذا»).
- لا تكتب أبدًا رقم مستند (طلب/أمر/فاتورة) لم يظهر حرفيًا في نتيجة أداة. قبل إرسال الرد تأكد أن كل رقم ذكرته موجود في نتائج الأدوات فعلًا؛ وإن لم يوجد فقل «غير متوفر» بدلًا من كتابته.

عقلية العمل (كن دقيقًا كالقنّاص، لا تكتفِ بأول نتيجة):
- اشتغل كأن كل رقم ستكتبه سيُراجَع عليك. لو شكّكت في معلومة، تحقّق منها بأداة ثانية قبل كتابتها، لا بعد أن يسألك المدير.
- عند أي تناقض بين مصدرين: لا تجمع بينهما في إجابة واحدة. الأحدث والأخص هو المرجع، واذكر أن هناك اختلافًا.
- لو لم تجد ما طُلب بعد محاولتين، وسّع البحث (اسم بديل، بريد آخر، مدة أطول، جدول آخر) قبل أن تعلن عدم العثور. اذكر بالضبط ما جرّبته.
- الإجابة الناقصة الصادقة أقوى من إجابة كاملة فيها تخمين. إن كان جزء من السؤال لا تملك بياناته فقل صراحةً «هذا الجزء غير متوفر» وأكمل الباقي.
- لا تُغلق السؤال بالاعتذار وأنت قادر على محاولة أخرى بالأدوات. حاول أولًا، وإن فشلت فاشرح ما جرى بدقة.

قدراتك وحدودها (لا تدّعي ما ليس لديك):
- قراءة سجل محادثات الواتساب: نعم. إرسال رسائل واتساب للموردين من داخل المحادثة: لا — لا توجد أداة لإرسال واتساب، والواتساب للقراءة فقط. إن طلب المستخدم إرسال رسالة، قل ذلك بوضوح واقترح صياغة نصية يرسلها هو بنفسه.
- إرسال بريد إلكتروني: نعم عبر send_email. قراءة البريد: نعم. إنشاء PDF: نعم.

ذاكرتك طويلة المدى (تتعلّم باستمرار):
- لديك ذاكرة دائمة تعرفها في كل المحادثات القادمة، وتُعرض لك في أعلى هذه التعليمات تحت «ذاكرتك طويلة المدى».
- عندما يقول المستخدم «افتكر إن…» أو «من الآن اعتبر…» أو يعلّمك قاعدة عمل، استخدم remember_fact بمفتاح قصير ثابت وقيمة كاملة. تعليم نفس المفتاح ثانيةً يُحدِّث القيمة.
- قبل أن تقول «لا أعرف» عن شيء قد يكون تعليمًا سابقًا، استخدم recall_memory للبحث في ذاكرتك.
- عندما يقول المستخدم إن معلومة قديمة أو خاطئة، استخدم forget_memory لإنهاء صلاحيتها.
- عند تعارض معلومة محفوظة مع نتيجة أداة حديثة، الأداة هي الأصح — وحدّث الذاكرة عبر remember_fact.
- لا تحفظ في الذاكرة أرقامًا متغيّرة (عدد رسائل، رصيد لحظي، سعر متغيّر) — هذه تُقرأ من الأدوات كل مرّة.

أسلوب العمل (مهم جدًا):
- استخدم supplier_overview عند السؤال عن مورد (تجلب كل شيء في استدعاء واحد).
- استخدم lookup_document عند وجود رقم مستند.
- اعمل على مرحلتين: مرحلة جمع (استدعاء أو استدعاءان) ثم مرحلة إجابة.
- بعد أن تحصل على نتيجة كافية، توقّف فورًا عن استدعاء الأدوات واكتب الرد النصي النهائي.
- لا تُكرّر نفس الاستدعاء بنفس المعطيات، ولا تستدعِ أداة ثانية لمعلومة وصلتك بالفعل.
- التكرار الحرفي لنفس الأداة بنفس المعطيات يُعاد استخدام نتيجته من الذاكرة (لا فائدة فيه)، فغيّر المعطيات أو استخدم النتيجة التي معك.
- الحد الأقصى 4 استدعاءات متتالية؛ بعدها يجب أن تكون كتبت الرد.
قواعد عامة:
- عند السؤال عن رقم (أمر شراء/طلب/فاتورة) استخدم lookup_document أو search_database.
- عند قول المستخدم «PO» أو «أمر شراء» دون ذكر البريد صراحةً، اعتبر المصدر الأساسي هو جدول أوامر الشراء الداخلي purchase_orders وبنوده purchase_order_items. لا تستخدم RFQ أو Quotation أو رسائل البريد كبديل، ولا تسمِّها PO. إذا طلب المستخدم فحص مرفقات البريد تحديدًا، استخدم scan_email_items فقط بعد التأكد أن الرسائل/المرفقات تحمل PO فعلًا؛ إن كانت RFQ/Quotation فقل إنها ليست POs.
- لا تخلط أبدًا بين RFQ/Quotation وPO: رقم يبدأ بـ 26R أو عنوان REQUEST FOR QUOTE يدل على RFQ، بينما PO الداخلي أو مستند PURCHASE ORDER له هوية مختلفة. عند الشك، لا تصنّف المستند من نفسك واذكر أن نوعه غير مؤكد.
- الأرقام المالية اكتبها كأرقام إنجليزية (مثل 1,234.50) والجنيه المصري عند اللزوم.
- كن موجزًا ومرتبًا، واستخدم نقاطًا عند الحاجة.
- رد دائمًا بال${lang} إلا إذا طلب المستخدم غير ذلك.
- عند طلب تقرير/ملف، استخدم generate_pdf ثم أخبر المستخدم أن الملف تم إرساله.
- عند طلب «ملف من الإيميل» أو مرفق رسالة: ابحث بـ search_emails ثم اقرأ الرسالة بـ read_email لمعرفة المرفقات، ثم استخدم get_email_attachment لجلب المرفق. المرفقات تُرسل للمستخدم على واتساب كملفات، فلا حاجة لإنشاء PDF بديل منها.
- get_email_attachment تقرأ أيضًا محتوى الـ PDF والصور وترجعه لك كنص؛ فإذا سأل المستخدم عن بنود أو كميات داخل مرفق (مثل «إيه البنود والكميات في ملف الأوردر؟»)، استخدمها واذكر التفاصيل من المحتوى نفسه. وإن رجعت readFailed فلا تخمّن ما داخل الملف، بل قل إن الملف أُرسل ولم أتمكن من قراءته.
- البريد: الشركة لها أكثر من صندوق بريد. search_emails تبحث تلقائيًا في كل الصناديق إن لم تحدّد mailbox، وlist_mailboxes تعرض المتاح. اذكر مع كل نتيجة البريد والمجلد اللذين وُجدت فيهما.

قواعد الحصر والإحصاء (مهمة جدًا — لا تخلط بين «عيّنة» و«إجمالي»):
- search_emails تعرض عيّنة فقط (٣٠ رسالة كحد أقصى من نافذة زمنية محدودة). لا يجوز أبدًا أن تقول «عدد الطلبات كذا» أو «الحصر كذا» بناءً على نتيجة search_emails — هذا كان خطأً فعليًا: قيل «10 رسائل» والعدد الحقيقي 1582.
- لأي سؤال فيه «كم عدد…» أو «كل…» أو «الحصر» أو «قارن البريد بالنظام» استخدم أداة scan_emails وحدها. هي تفحص الصندوق كله وتعيد العدد الإجمالي والتوزيع على الشهور وأرقام المستندات المستخرجة من الموضوع.
- انظر دائمًا إلى حقل note و isTotal في نتيجة scan_emails قبل ذكر أي رقم. إذا كان isTotal=false فالعدد حدّ أدنى وليس إجمالًا؛ قل ذلك صراحةً وأعد الحصر بفترة أضيق.
- scan_emails تصلح للحصر الكامل في استدعاء واحد على صندوق بحجم عشرات الآلاف من الرسائل. لا تقسّم العمل إلى «أجزاء» ولا تقل إن العدد «أكبر من الحد الأقصى» — إن كان الحصر ناقصًا فقسّمه بالتواريخ (sinceDate/beforeDate) ثم اجمع الأرقام بنفسك واذكر المجموع.
- للمقارنة بين البريد والنظام: مرّر compareTable وcompareColumn في scan_emails (مثال: customer_rfqs + customerRfqNo) لتُعاد الأرقام الموجودة في البريد وغير المسجّلة. لا تحاول مطابقة مئات الأرقام باستدعاءات متتالية.
- عند طلب «ملف» أو «تقرير» بالحصر، مرّر exportCsv=true ليُرسل الملف الكامل على واتساب، ثم اذكر الإجمالي في الرد. ولا تقل إن القائمة الكبيرة غير ممكنة — الملف يحملها كاملة.
- عندما تطلب منك الإدارة «قارن البريد بالنظام» أو «الأرقام اللي في الميل مش في النظام»: استخدم scan_emails مع compareTable/compareColumn. وإن طلبوا ملفًا بالفرق، أضف exportPdf=true — التقرير يُبنى في الخادم من القائمة الكاملة، فلن تُقتطع مهما كان عدد الأرقام. لا تنقل الأرقام بنفسك إلى generate_pdf أبدًا.
- الرقم قد يكون داخل المرفق لا في الموضوع (مثل إشعارات «Quotation Import» من EDC). إن أردت حصرًا أدق، مرّر includeAttachments=true مع scan_emails.
- لسؤال عن «البنود والكميات» أو «أكتر بند اتكرر» داخل ملفات/طلبات/أوامر توريد واردة بالبريد: استخدم scan_email_items وحدها (تقرأ داخل مرفقات PDF وتجمّع البنود). لا تقل «البنود داخل الملفات ولا أستطيع قراءتها» — الأداة تفعل ذلك. ترتيبها الافتراضي بالتكرار (مرات ورود البند) وهو المقصود بـ«أكتر بند اتكرر»؛ وإن كان السؤال عن الكمية الإجمالية مرّر ordering=qty. وإن طلب المستخدم ملفًا، مرّر exportCsv=true (كل البنود) أو exportPdf=true (ملخص).
- إن رجعت scan_email_items بـ isComplete=false فالحصر لم ينتهِ بعد، والترتيب مبني على ما فُحص حتى الآن فقط. اذكر النطاق صريحًا («فُتح N من أصل M رسالة مطابقة») ثم أعد نداء scan_email_items بنفس الوسائط لإكمال الحصر من حيث توقف. لا تقدّم الترتيب على أنه حصر لكل الرسائل، ولا تقل إن بندًا «غير موجود» قبل isComplete=true.
- إن رجعت scan_email_items بـ hasAttachments=false فهذا يعني أن الحصر لم يعثر على ملفات بنود في النطاق المطلوب، وليس أن الطلبات بلا بنود. لا تقل «الطلبات لا تحتوي بنودًا»؛ قل إنه لم يُعثر على ملفات بنود في هذا النطاق، واقترح توسيع المدة (sinceDate) أو تغيير المُرسل.
- عندما يطلب المستخدم قائمة كاملة بالأرقام وعددها أكبر من أن يُكتب في الرسالة: أرسل الملف (exportCsv) واذكر الإجمالي والتوزيع على الشهور، ولا تسرد الأرقام كلها في نص الرسالة.
- إن سأل المستخدم عن شيء أرسلناه نحن (لا وصلنا): استخدم search_sent_emails لمجلد «المرسل»، وليس search_emails.
- عند فتح رسالة بـ read_email أو جلب مرفق، مرّر نفس mailbox و folder اللذين ظهرا مع الرسالة في نتيجة البحث؛ فمعرّف UID لا يكون فريدًا إلا داخل مجلد واحد في صندوق واحد.
- عند البحث في البريد ولا تجد شيئًا: جرّب search_sent_emails إن كان السؤال عن رسالة صادرة، أو وسّع المدة (sinceDays)، أو جرّب اسمًا بديلًا أو بريدًا آخر، وأخبر المستخدم بما بحثت فيه فعلًا بدل قول «لم أجد» فقط.`;

  if (settings.systemPrompt && settings.systemPrompt.trim()) {
    return base + "\n\nتعليمات إضافية من الإدارة:\n" + settings.systemPrompt.trim();
  }
  return base;
}

async function loadHistory(phone: string): Promise<ChatMessage[]> {
  const rows = await db
    .select()
    .from(aiAssistantMessagesTable)
    .where(eq(aiAssistantMessagesTable.phone, phone))
    .orderBy(desc(aiAssistantMessagesTable.id))
    .limit(MAX_HISTORY);
  return rows
    .reverse()
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
}

async function saveMessage(
  phone: string,
  role: string,
  content: string,
  toolCalls?: unknown,
): Promise<void> {
  try {
    await db.insert(aiAssistantMessagesTable).values({ phone, role, content, toolCalls });
  } catch (err) {
    logger.warn({ err, phone }, "AI assistant: failed to persist message");
  }
}

export interface AgentInput {
  phone: string;
  text?: string;
  imageUrl?: string;
  audio?: { buffer: Buffer; mimeType: string };
  /** A document the operator sent (PDF, spreadsheet, scanned image). */
  document?: { buffer: Buffer; mimeType: string; filename?: string };
}

export interface AgentOutput {
  reply: string;
  attachments: OutboxAttachment[];
}

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const settings = await loadSettings();
  if (!settings.enabled) {
    return { reply: "المساعد الذكي معطّل حاليًا. تواصل مع الإدارة.", attachments: [] };
  }

  let userText = input.text?.trim() || "";
  if (input.audio) {
    const transcript = await transcribeAudio(
      input.audio.buffer,
      input.audio.mimeType,
      settings.baseUrl,
      settings.model,
    );
    if (transcript) userText = transcript;
    else userText = userText || "[رسالة صوتية — تعذّر تحويلها إلى نص]";
  }

  // A document is read into text UP FRONT rather than handed to the model as a
  // tool result: the operator's question usually refers to it ("لخّص هذا الملف",
  // "ابحث عن البند ده"), so the model needs the contents in the same turn.
  let documentNote = "";
  if (input.document) {
    const extracted = await extractDocumentText(
      input.document.buffer,
      input.document.mimeType,
      settings.baseUrl,
      settings.model,
    );
    if (extracted) {
      documentNote =
        `\n\n[محتوى الملف المرفق «${input.document.filename || "ملف"}»:]\n` +
        extracted.slice(0, MAX_DOCUMENT_CHARS);
    } else {
      userText =
        userText ||
        `تعذّر قراءة الملف «${input.document.filename || "الملف"}» (${input.document.mimeType}).`;
    }
  }

  const ctx: ToolContext = { settings, phone: input.phone, outbox: [] };

  // The router is deterministic and free: it classifies the question before any
  // provider request, so a simple lookup does not pay for the budget an analysis
  // needs (and vice versa). It never answers — it only allocates rounds and
  // supplies a short tool hint.
  const plan = routeQuestion(userText);
  // Rounds actually allowed for THIS question. The last one still forbids tools
  // (see FORCE_ANSWER_ON_LAST_ROUND) so an answer is always produced.
  const maxRounds = plan.maxRounds;

  // Independent loads run concurrently. Previously these were awaited in
  // sequence — history, then memories, then the vocabulary — which added their
  // latencies together on the path of every single question. Nothing here
  // depends on anything else in the group, so the only correct behaviour is to
  // overlap them.
  const [history, memories, vocabulary, conversationState] = await Promise.all([
    loadHistory(input.phone),
    // Core memory: the memories most relevant to THIS message are injected into
    // the system prompt, so a fact taught weeks ago is available without the model
    // having to spend a tool round asking for it (and without the whole table
    // crowding the context). Retrieval is local keyword scoring — no model quota.
    recallMemories({
      phone: input.phone,
      query: userText,
      limit: 12,
      trackUse: true,
    }),
    // The real supplier/customer vocabulary, prefetched so the model can tell an
    // invented name from a real one. Two cheap selects, cached upstream — no model
    // quota spent, and it is what makes a name checkable before it is written
    // rather than after the operator challenges it.
    settings.allowDatabase
      ? entityVocabulary()
      : Promise.resolve({ suppliers: [] as EntityName[], customers: [] as EntityName[] }),
    // What the conversation was last about, so «وطب آخر سعر له؟» resolves "له"
    // without the operator restating the part. Read-only, best-effort.
    loadConversationState(input.phone),
  ]);
  const memoryBlock = renderMemoryBlock(memories);
  const vocabularyBlock = renderVocabularyBlock(vocabulary);
  const stateBlock = renderConversationState(conversationState);

  const system: ChatMessage = {
    role: "system",
    content: systemPrompt(settings) + routeHint(plan) + stateBlock + memoryBlock + vocabularyBlock,
  };

  let userContent: string | ContentPart[];
  if (input.imageUrl) {
    userContent = [
      { type: "text", text: (userText || "حلّل هذه الصورة وأخبرني بما تحتويه.") + documentNote },
      { type: "image_url", image_url: { url: input.imageUrl } },
    ];
  } else {
    userContent = (userText || "(رسالة فارغة)") + documentNote;
  }

  const messages: ChatMessage[] = [system, ...history, { role: "user", content: userContent }];

  const tools = toolDefinitions(ctx);
  const usedTools: Array<{ name: string; args: unknown }> = [];
  let finalText: string | null = null;
  let rounds = 0;
  let fallbackUsed = false;
  let verificationRan = false;
  const startedAt = Date.now();

  // Per-run memo of tool results, keyed on the tool name + canonical arguments.
  // A model that re-issues an identical call (documented live: it repeats the
  // same search when the first result did not match its expectation) would
  // otherwise spend another scarce round on work already done — one of the
  // recorded causes of the assistant going silent on the free-tier quota. The
  // cache is scoped to this run only: a later question must see fresh data.
  const toolCache = new Map<string, Promise<string>>();
  // Grounding ledger: every token that appeared in a tool result (or was stated
  // by the operator). The verifier checks the final answer against this — see
  // `findUngroundedNumbers`.
  const groundedNumbers = new Set<string>();
  // Anything the operator, the conversation, the attached document, or the
  // learned memory already stated is fair game for the answer to quote back —
  // the verifier only challenges tokens the run itself introduced.
  for (const n of findGroundingNumbers(userText + documentNote + memoryBlock + vocabularyBlock)) {
    groundedNumbers.add(n);
  }
  for (const m of history) {
    if (typeof m.content === "string") {
      for (const n of findGroundingNumbers(m.content)) groundedNumbers.add(n);
    }
  }

  // Hard ceiling on the WHOLE run (every round, every model, every tool). The
  // operator is waiting in a chat window: past this point a late answer is
  // worse than an honest "it timed out", because they have already given up.
  const runBudget = new AbortController();
  const runTimer = setTimeout(() => runBudget.abort(), AGENT_BUDGET_MS);

  try {
    for (let round = 0; round < maxRounds; round++) {
      // Last round: forbid tool calls so the model has to answer with what it
      // already gathered. Without this a model that keeps calling tools drains
      // the budget and leaves nothing to send.
      const isLastRound = FORCE_ANSWER_ON_LAST_ROUND && round === maxRounds - 1;
      const roundStartedAt = Date.now();
      const result = await chatCompletion({
        model: settings.model,
        baseUrl: settings.baseUrl,
        messages,
        tools,
        toolChoice: isLastRound ? "none" : "auto",
        signal: runBudget.signal,
      });
      rounds += 1;
      if (result.modelUsed && result.modelUsed !== settings.model) fallbackUsed = true;

      if (result.toolCalls.length === 0) {
        finalText = result.content;
        break;
      }

      // Some providers (observed: Gemini) still return tool calls under
      // tool_choice "none". Dropping the tool schemas entirely removes the option
      // and reliably yields text; if even that fails, report what did run rather
      // than silently swallowing the turn.
      if (isLastRound) {
        logger.warn(
          {
            providerToolChoiceIgnored: true,
            model: settings.model,
            calls: result.toolCalls.length,
          },
          "AI assistant: model ignored tool_choice=none on the final round",
        );
        const noTools = await chatCompletion({
          model: settings.model,
          baseUrl: settings.baseUrl,
          messages,
          toolChoice: "none",
        });
        rounds += 1;
        if (noTools.modelUsed && noTools.modelUsed !== settings.model) fallbackUsed = true;
        finalText = noTools.content ?? result.content ?? exhaustedAnswer(usedTools);
        break;
      }

      // Echo the assistant's tool-call turn back into the conversation, then run
      // every call in THIS round concurrently. The calls in one round are chosen
      // together by the model and are independent, so awaiting them in sequence
      // only added latency (a 3-line item scan cost 3 round-trips).
      messages.push({
        role: "assistant",
        content: result.content ?? null,
        tool_calls: result.toolCalls,
      });

      const calls = result.toolCalls.map((call) => {
        const parsed = parseArgs(call);
        usedTools.push({ name: call.function.name, args: parsed });
        return { call, parsed };
      });
      let dedupedCount = 0;
      const outcomes = await Promise.all(
        calls.map(async ({ call, parsed }) => {
          // Identical (tool, args) in the SAME run: reuse the earlier result
          // instead of re-running the tool. The calls in one round already run
          // concurrently, so the promise is cached rather than the value.
          const key = toolCacheKey(call.function.name, parsed);
          // Resumable census tools intentionally MUST NOT be memoized. A second
          // identical call is the resume operation: the session cursor has
          // advanced in shared cache and must be allowed to return the next
          // batch. Memoizing it made the model receive the first partial 150
          // messages forever, despite the prompt telling it to continue.
          const resumable = call.function.name === "scan_email_items";
          let pending = resumable ? undefined : toolCache.get(key);
          if (pending) {
            dedupedCount += 1;
          } else {
            pending = (async () => {
              const res = await executeTool(call.function.name, parsed, ctx);
              return res.ok ? asText(res.data) : `ERROR: ${res.error}`;
            })();
            if (!resumable) toolCache.set(key, pending);
          }
          const content = await pending;
          for (const n of findGroundingNumbers(content)) groundedNumbers.add(n);
          return { call, content };
        }),
      );
      for (const { call, content } of outcomes) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content,
        });
      }
      logger.info(
        {
          phone: input.phone,
          round,
          ms: Date.now() - roundStartedAt,
          toolCalls: calls.map((c) => c.call.function.name),
          deduped: dedupedCount,
        },
        "AI assistant: tool round complete",
      );
    }

    if (!finalText) {
      finalText = exhaustedAnswer(usedTools);
    }

    // ── Post-answer verification ────────────────────────────────────────────
    // Two independent checks, both deterministic (no model call to decide), so
    // the extra provider request is spent only when a real problem is found.
    // The router decides whether verification can pay off at all: a greeting has
    // no facts to check, so it never spends a round there.
    let refusals = 0;
    for (let pass = 0; plan.verify && pass <= MAX_REFUSAL_REASKS; pass++) {
      if (!finalText) break;
      const remaining = AGENT_BUDGET_MS - (Date.now() - startedAt);
      if (runBudget.signal.aborted || remaining < VERIFY_MIN_REMAINING_MS) break;

      // (a) Numbers the answer cites that appear nowhere in the evidence.
      const ungrounded = findUngroundedNumbers(finalText, groundedNumbers);

      // (b) Entity names the answer cites that are not in the real vocabulary.
      // This is the «هاي فولت» lesson: invented company names read as plausible
      // prose, and a challenge from the operator is the only thing that caught
      // it before. Now the check happens before the reply is sent.
      const unknownNames = findUnknownEntityNames(finalText, vocabulary);

      // (c) A reply that says it found nothing while it also cites nothing —
      // the "gave up too early" case. Worth one re-ask with an explicit order to
      // widen the search, because the operator's question was answerable.
      const looksLikeRefusal =
        !ungrounded.length &&
        !unknownNames.length &&
        isRefusalSentence(finalText) &&
        !looksLikeDataFound(finalText);
      const canReask =
        looksLikeRefusal && refusals < MAX_REFUSAL_REASKS && remaining >= RETRY_MIN_REMAINING_MS;

      if (!ungrounded.length && !unknownNames.length && !canReask) break;

      if (ungrounded.length || unknownNames.length) {
        logger.warn(
          {
            phone: input.phone,
            ungrounded: ungrounded.slice(0, 8),
            unknownNames: unknownNames.slice(0, 8),
          },
          "AI assistant: answer cites tokens absent from every tool result",
        );
      } else {
        refusals += 1;
        logger.info({ phone: input.phone }, "AI assistant: re-asking after a premature refusal");
      }

      verificationRan = true;
      const corrected = await verifyGroundedAnswer({
        settings,
        messages,
        finalText,
        ungrounded,
        unknownNames,
        reask: canReask && !ungrounded.length && !unknownNames.length,
        signal: runBudget.signal,
      });
      // A verification that produced nothing leaves the draft in place — an
      // unavailable verifier must never lose a good reply.
      if (!corrected) break;
      // A re-ask that came back with a still-empty answer is the model's final
      // word; do not loop on it.
      if (canReask && !ungrounded.length && !unknownNames.length) {
        if (isRefusalSentence(corrected) && !looksLikeDataFound(corrected)) {
          finalText = corrected;
          break;
        }
      }
      finalText = corrected;
    }

    // ── Deterministic numeric verification (P2 / PR 5) ──────────────────────
    // The pass above checks NAMES and IDENTIFIERS. This pass checks FIGURES: a
    // large quantity/money total in the answer is reconciled against a fresh SQL
    // aggregate. It is free (no model call) and runs even when the router said
    // the answer had no facts to verify, because a wrong total is exactly the
    // silent failure the operator cannot detect. On a mismatch the answer is NOT
    // rewritten — the caveat is appended, so the model's own wording stays visible
    // beside the correction.
    if (finalText) {
      try {
        const v = await verifyAnswer({ answerText: finalText });
        if (v.outcome === "disagreement" && v.note) {
          finalText = `${finalText}\n\n⚠️ تحقق آلي: ${v.note} — لذا النتيجة PARTIALLY_VERIFIED.`;
          verificationRan = true;
          logger.warn(
            { phone: input.phone, note: v.note },
            "AI assistant: numeric verification disagreed",
          );
        }
      } catch (err) {
        // A verifier failure must never lose the answer.
        logger.warn({ err }, "AI assistant: numeric verification skipped");
      }
    }
  } catch (err) {
    // A timeout or quota error still needs to be measured — those are the two
    // failure modes the operator actually reports, and without a metric here
    // they are invisible except in the logs.
    recordMetrics({
      phone: input.phone,
      intent: plan.intent,
      path: plan.path,
      routeReason: plan.reason,
      rounds,
      toolCalls: usedTools.length,
      toolNames: [...new Set(usedTools.map((t) => t.name))],
      verified: verificationRan,
      fallbackUsed,
      latencyMs: Date.now() - startedAt,
      outcome: isTimeoutError(err) ? "timeout" : isQuotaError(err) ? "quota" : "error",
    });
    throw err;
  } finally {
    clearTimeout(runTimer);
  }

  logger.info({ phone: input.phone, ms: Date.now() - startedAt, rounds }, "AI assistant: answered");

  recordMetrics({
    phone: input.phone,
    intent: plan.intent,
    path: plan.path,
    routeReason: plan.reason,
    rounds,
    toolCalls: usedTools.length,
    toolNames: [...new Set(usedTools.map((t) => t.name))],
    verified: verificationRan,
    fallbackUsed,
    latencyMs: Date.now() - startedAt,
    outcome: "answered",
  });

  // The extracted document text is intentionally kept out of the stored
  // history: it is large and only relevant to this one turn. The label keeps
  // the transcript understandable when it is replayed as context.
  const historyText = input.imageUrl
    ? `[صورة] ${userText}`.trim()
    : input.document
      ? `[ملف: ${input.document.filename || "ملف"}] ${userText}`.trim()
      : userText;
  await saveMessage(input.phone, "user", historyText);
  await saveMessage(input.phone, "assistant", finalText, usedTools.length ? usedTools : null);

  // Record what this turn was about, so a follow-up can resolve «له/بتاعه».
  // Only explicitly-named entities are recorded (see inferStatePatch) and it is
  // best-effort — a state-write failure must never surface to the operator.
  void saveConversationState(input.phone, inferStatePatch({ userText })).catch(() => {});

  // Learn from the exchange. Fire-and-forget: the reply is already produced, and
  // a memory-write failure must never turn a good answer into an error the
  // operator sees. The distiller uses only the operator's own words (no model
  // call), so this costs none of the scarce daily quota.
  void distillMemories({
    phone: input.phone,
    userText,
    assistantText: finalText,
  }).catch((err) => logger.warn({ err }, "AI assistant: background learning failed"));

  return { reply: finalText, attachments: ctx.outbox };
}

function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || "{}");
    return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Stable cache key for one tool call: the tool name plus its arguments in a
 * canonical form, so `{"a":1,"b":2}` and `{"b":2,"a":1}` dedupe to one entry.
 * Nested objects are sorted recursively; a non-object value falls back to its
 * string form.
 */
export function toolCacheKey(name: string, args: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = canonical((v as Record<string, unknown>)[k]);
          return acc;
        }, {});
    }
    return v;
  };
  try {
    return `${name}:${JSON.stringify(canonical(args ?? {}))}`;
  } catch {
    return `${name}:${String(args)}`;
  }
}

/**
 * Document-number-shaped tokens in a piece of text.
 *
 * Shape matters: only strings that carry BOTH letters and digits (optionally
 * hyphen-separated), like `26R011936`, `P26E13477`, `INV-2026-000045`, are
 * treated as a numbered document. Plain numbers — money amounts, quantities,
 * ids, years — are deliberately excluded, because challenging every `3` in a
 * sentence would reject correct prose.
 */
export function findGroundingNumbers(text: string): string[] {
  if (!text) return [];
  // Capture whole id-shaped runs first (letters/digits plus `._-` separators),
  // because splitting on the hyphen would turn `INV-2026-000045` into a bare
  // number and lose the letter that makes it a document id.
  const candidates = text.match(/[A-Za-z0-9][A-Za-z0-9._-]{2,}/g) ?? [];
  const out: string[] = [];
  for (const raw of candidates) {
    const t = raw.replace(/[._-]+$/, "").toUpperCase();
    if (t.length < 4) continue;
    // Must be a genuine mixed alphanumeric doc id: letters AND digits, and not
    // a bare decimal (money/quantity) which the operator never needs checked.
    if (!/\d/.test(t) || !/[A-Z]/.test(t)) continue;
    if (/^\d+(?:[.,]\d+)*$/.test(t)) continue;
    out.push(t);
  }
  return [...new Set(out)];
}

/**
 * Tokens in the answer that never appeared in any tool result.
 *
 * Compares in a normalised form (uppercase, spaces and hyphens removed) so
 * `26R 011936` and `26R-011936` are recognised as the number the tool returned.
 * A token that is a SUBSTRING of a grounded token is accepted too — that is how
 * the model quoting "011936" out of "26R011936" reads. The reverse (the answer
 * token CONTAINING a grounded one, e.g. an extra trailing digit) is not
 * accepted, because an extended id is not the id the tool returned.
 */
export function findUngroundedNumbers(answer: string, grounded: Set<string>): string[] {
  if (!answer) return [];
  const norm = (s: string) => s.replace(/[\s-]+/g, "").toUpperCase();
  const pool = new Set([...grounded].map(norm));
  const bad: string[] = [];
  for (const token of findGroundingNumbers(answer)) {
    const n = norm(token);
    if (pool.has(n)) continue;
    let covered = false;
    for (const g of pool) {
      if (g.includes(n)) {
        covered = true;
        break;
      }
    }
    if (!covered && !bad.includes(token)) bad.push(token);
  }
  return bad;
}

/**
 * The known supplier/customer names, rendered as a checkable list.
 *
 * Bounded on purpose: the prompt must stay small enough not to crowd out the
 * conversation. We list names (and their internal ids) — never prices or counts,
 * which change and belong in tool results.
 */
export function renderVocabularyBlock(known: {
  suppliers: EntityName[];
  customers: EntityName[];
}): string {
  const s = known.suppliers.slice(0, VOCAB_PROMPT_LIMIT);
  const c = known.customers.slice(0, VOCAB_PROMPT_LIMIT);
  if (!s.length && !c.length) return "";
  const line = (e: EntityName) => (e.id != null ? `${e.name} (${e.id})` : e.name);
  const parts = ["\n\nأسماء الجهات الحقيقية في النظام (لا تكتب اسمًا غير موجود في هذه القوائم):"];
  if (s.length) parts.push(`الموردون (${known.suppliers.length}): ${s.map(line).join("، ")}`);
  if (c.length) parts.push(`العملاء (${known.customers.length}): ${c.map(line).join("، ")}`);
  parts.push(
    "إن احتجت موردًا أو عميلًا غير موجود في القائمة فقل إنه غير مسجّل، ولا تخترع اسمًا مشابهًا.",
  );
  return parts.join("\n");
}

/**
 * Does the answer read as "I found nothing"? Deliberately conservative: it needs
 * an explicit negative phrase AND no cited document number or entity name, so an
 * answer that merely contains the word «لا» mid-sentence is not misread as a
 * refusal and re-asked needlessly.
 */
const REFUSAL_PATTERNS = [
  /لا\s+(?:يوجد|توجد|توجد\s+نتائج|أجد|اجد|يوجد\s+نتائج|توجد\s+بيانات)/,
  /لم\s+(?:أجد|اجد|أعثر|اعثر|أتمكن|اتمكن)/,
  /لا\s+توجد\s+بيانات/,
  /غير\s+متوفر/,
  /لا\s+توجد\s+معلومات/,
  /(?:no|nothing|not)\s+(?:results?|found|records?|data)/i,
];

export function isRefusalSentence(text: string): boolean {
  return REFUSAL_PATTERNS.some((re) => re.test(text || ""));
}

/** Does the answer contain anything concrete (a cited id or a multi-digit number)? */
function looksLikeDataFound(text: string): boolean {
  // Only ids and 2+ digit numbers count as "data". Deliberately NOT keyed on
  // words like «مورد»/«أمر»: those appear in the refusal sentence itself
  // («لا يوجد مورد بهذا الاسم») and would suppress the very re-ask we want.
  return findGroundingNumbers(text).length > 0 || /\d{2,}/.test(text ?? "");
}

/**
 * The verification round: hand the model its own draft plus the specific tokens
 * that the evidence does not support, and ask it to remove or correct them.
 *
 * This is the LangGraph "generator → critic" pattern with a DETERMINISTIC critic
 * (token containment, no model call to decide), so it costs one provider request
 * only when a real problem is suspected — never on an ordinary answer. The draft
 * is kept if the model fails to improve it, so a verification failure can never
 * lose a good reply.
 */
async function verifyGroundedAnswer(opts: {
  settings: AiSettings;
  messages: ChatMessage[];
  finalText: string;
  ungrounded: string[];
  unknownNames: string[];
  /** True when the draft refused without evidence and should widen its search. */
  reask: boolean;
  signal: AbortSignal;
}): Promise<string | null> {
  const problems: string[] = [];
  if (opts.ungrounded.length) {
    problems.push(`أرقامًا لم تظهر في أي نتيجة أداة: ${opts.ungrounded.slice(0, 20).join(", ")}`);
  }
  if (opts.unknownNames.length) {
    problems.push(
      `أسماء جهات غير موجودة في قوائم النظام: ${opts.unknownNames.slice(0, 20).join(", ")}`,
    );
  }

  const instruction = opts.reask
    ? "ردك السابق أعلن عدم العثور على المعلومة دون أن تجرّب أدوات كافية. " +
      "لا تُنهِ الرد قبل أن تحاول مرة أخرى فعليًا:\n" +
      "1) جرّب اسمًا بديلًا أو تهجئة أخرى، أو بريدًا آخر، أو جدولًا آخر، أو وسّع المدة (sinceDays).\n" +
      "2) إن طُلب رقم مستند فجرّب البحث بالجزء منه (آخر أرقامه) لا بالرقم كاملًا فقط.\n" +
      "3) إن فشلت كل المحاولات فعلًا، اذكر بالضبط ما جرّبته (الجدول/الكلمة/المدة) — ولا تقل «غير متوفر» وحدها.\n" +
      "أعد نص الرد النهائي فقط، بدون شرح أو مقدمة."
    : "مراجعة إلزامية قبل الإرسال: الردّ التالي يحتوي " +
      problems.join(" و ") +
      ".\n" +
      "أعد كتابة الرد مع الالتزام الصارم بالآتي:\n" +
      "1) احذف أي رقم مستند/طلب/أمر/فاتورة لم يظهر حرفيًا في نتيجة أداة، ولا تستبدله برقم مخمّن.\n" +
      "2) احذف أو صحّح أي اسم مورد/عميل غير موجود في قوائم النظام المعطاة لك، ولا تخترع اسمًا شبيهًا.\n" +
      "3) إن كانت المعلومة المطلوبة تعتمد على تلك الأرقام أو الأسماء، فاذكر صراحةً أنها غير متوفرة ولم تُعثر عليها.\n" +
      "4) أبقِ باقي الرد كما هو — لا تُغيّر ما ظهر فعلًا في نتائج الأدوات.\n" +
      "أعد نص الرد النهائي فقط، بدون شرح أو مقدمة.";

  try {
    const res = await chatCompletion({
      model: opts.settings.model,
      baseUrl: opts.settings.baseUrl,
      messages: [
        ...opts.messages,
        { role: "assistant", content: opts.finalText },
        { role: "user", content: instruction },
      ],
      toolChoice: "none",
      signal: opts.signal,
    });
    const text = res.content?.trim();
    return text ? text : null;
  } catch (err) {
    // The draft is already written; an unavailable verifier must not lose it.
    logger.warn({ err }, "AI assistant: grounding verification round failed");
    return null;
  }
}

/**
 * Message shown when the model spent its whole budget on tools without
 * producing an answer. Naming the tools it did call tells the operator the
 * request was worked on (and that retrying the same way will hit the same wall)
 * instead of the misleading "rephrase your question".
 */
function exhaustedAnswer(usedTools: Array<{ name: string; args: unknown }>): string {
  if (usedTools.length === 0) {
    return "لم أتمكن من الوصول لإجابة. جرّب إعادة صياغة السؤال.";
  }
  const names = [...new Set(usedTools.map((t) => t.name))].join(", ");
  return (
    "نفدت محاولات المعالجة قبل الوصول لرد نهائي، لكن تم تنفيذ خطوات فعلية: " +
    names +
    ". جرّب سؤالًا أكثر تحديدًا (مثل رقم أمر التوريد) وسأجيب مباشرة."
  );
}

/** Clear conversation history for a phone (used by the reset command). */
export async function resetHistory(phone: string): Promise<void> {
  await db.delete(aiAssistantMessagesTable).where(eq(aiAssistantMessagesTable.phone, phone));
}

/** Most recent assistant message for a phone — used for idempotency checks. */
export async function lastAssistantMessage(phone: string): Promise<string | null> {
  const [row] = await db
    .select({ content: aiAssistantMessagesTable.content })
    .from(aiAssistantMessagesTable)
    .where(
      and(
        eq(aiAssistantMessagesTable.phone, phone),
        eq(aiAssistantMessagesTable.role, "assistant"),
      ),
    )
    .orderBy(desc(aiAssistantMessagesTable.id))
    .limit(1);
  return row?.content ?? null;
}
