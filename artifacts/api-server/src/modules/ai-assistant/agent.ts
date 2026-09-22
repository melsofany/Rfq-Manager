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
  type ChatMessage,
  type ContentPart,
  type ToolCall,
} from "./llm";
import { loadSettings, MAX_HISTORY, type AiSettings } from "./config";
import {
  toolDefinitions,
  executeTool,
  asText,
  type ToolContext,
  type OutboxAttachment,
} from "./tools";

/**
 * Tool-calling rounds before we force an answer. Each round costs one provider
 * request, so this is a budget as much as a limit: on Gemini's free tier (20
 * requests/day/model) a generous budget burns the day's quota in a few
 * questions. 5 covers gather → refine → answer, and the last round always
 * produces text (see FORCE_ANSWER_ON_LAST_ROUND).
 */
export const MAX_TOOL_ROUNDS = 5;

/**
 * Rounds with the full toolset before the last one, which forbids tools. A
 * model that never stops calling tools would otherwise exhaust the budget and
 * leave `finalText` null — surfacing as "no final answer" to the operator.
 */
const FORCE_ANSWER_ON_LAST_ROUND = true;

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

قدراتك وحدودها (لا تدّعي ما ليس لديك):
- قراءة سجل محادثات الواتساب: نعم. إرسال رسائل واتساب للموردين من داخل المحادثة: لا — لا توجد أداة لإرسال واتساب، والواتساب للقراءة فقط. إن طلب المستخدم إرسال رسالة، قل ذلك بوضوح واقترح صياغة نصية يرسلها هو بنفسه.
- إرسال بريد إلكتروني: نعم عبر send_email. قراءة البريد: نعم. إنشاء PDF: نعم.

أسلوب العمل (مهم جدًا):
- استخدم supplier_overview عند السؤال عن مورد (تجلب كل شيء في استدعاء واحد).
- استخدم lookup_document عند وجود رقم مستند.
- اعمل على مرحلتين: مرحلة جمع (استدعاء أو استدعاءان) ثم مرحلة إجابة.
- بعد أن تحصل على نتيجة كافية، توقّف فورًا عن استدعاء الأدوات واكتب الرد النصي النهائي.
- لا تُكرّر نفس الاستدعاء بنفس المعطيات، ولا تستدعِ أداة ثانية لمعلومة وصلتك بالفعل.
- الحد الأقصى 4 استدعاءات متتالية؛ بعدها يجب أن تكون كتبت الرد.
قواعد عامة:
- عند السؤال عن رقم (أمر شراء/طلب/فاتورة) استخدم lookup_document أو search_database.
- الأرقام المالية اكتبها كأرقام إنجليزية (مثل 1,234.50) والجنيه المصري عند اللزوم.
- كن موجزًا ومرتبًا، واستخدم نقاطًا عند الحاجة.
- رد دائمًا بال${lang} إلا إذا طلب المستخدم غير ذلك.
- عند طلب تقرير/ملف، استخدم generate_pdf ثم أخبر المستخدم أن الملف تم إرساله.
- عند طلب «ملف من الإيميل» أو مرفق رسالة: ابحث بـ search_emails ثم اقرأ الرسالة بـ read_email لمعرفة المرفقات، ثم استخدم get_email_attachment لجلب المرفق. المرفقات تُرسل للمستخدم على واتساب كملفات، فلا حاجة لإنشاء PDF بديل منها.
- البريد: الشركة لها أكثر من صندوق بريد. search_emails تبحث تلقائيًا في كل الصناديق إن لم تحدّد mailbox، وlist_mailboxes تعرض المتاح. اذكر مع كل نتيجة البريد والمجلد اللذين وُجدت فيهما.
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

  const ctx: ToolContext = { settings, phone: input.phone, outbox: [] };

  const history = await loadHistory(input.phone);
  const system: ChatMessage = { role: "system", content: systemPrompt(settings) };

  let userContent: string | ContentPart[];
  if (input.imageUrl) {
    userContent = [
      { type: "text", text: userText || "حلّل هذه الصورة وأخبرني بما تحتويه." },
      { type: "image_url", image_url: { url: input.imageUrl } },
    ];
  } else {
    userContent = userText || "(رسالة فارغة)";
  }

  const messages: ChatMessage[] = [system, ...history, { role: "user", content: userContent }];

  const tools = toolDefinitions(ctx);
  const usedTools: Array<{ name: string; args: unknown }> = [];
  let finalText: string | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Last round: forbid tool calls so the model has to answer with what it
    // already gathered. Without this a model that keeps calling tools drains
    // the budget and leaves nothing to send.
    const isLastRound = FORCE_ANSWER_ON_LAST_ROUND && round === MAX_TOOL_ROUNDS - 1;
    const result = await chatCompletion({
      model: settings.model,
      baseUrl: settings.baseUrl,
      messages,
      tools,
      toolChoice: isLastRound ? "none" : "auto",
    });

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
        { providerToolChoiceIgnored: true, model: settings.model, calls: result.toolCalls.length },
        "AI assistant: model ignored tool_choice=none on the final round",
      );
      const noTools = await chatCompletion({
        model: settings.model,
        baseUrl: settings.baseUrl,
        messages,
        toolChoice: "none",
      });
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
    const outcomes = await Promise.all(
      calls.map(async ({ call, parsed }) => {
        const res = await executeTool(call.function.name, parsed, ctx);
        return {
          call,
          content: res.ok ? asText(res.data) : `ERROR: ${res.error}`,
        };
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
  }

  if (!finalText) {
    finalText = exhaustedAnswer(usedTools);
  }

  const historyText = input.imageUrl ? `[صورة] ${userText}`.trim() : userText;
  await saveMessage(input.phone, "user", historyText);
  await saveMessage(input.phone, "assistant", finalText, usedTools.length ? usedTools : null);

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
