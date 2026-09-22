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

const MAX_TOOL_ROUNDS = 6;

const LANGUAGE_NAME: Record<string, string> = { ar: "العربية", en: "English" };

export function systemPrompt(settings: AiSettings): string {
  const lang = LANGUAGE_NAME[settings.language] ?? "العربية";
  const base = `أنت «المساعد الذكي» لنظام قرطبة للتوريدات لإدارة طلبات عروض الأسعار وأوامر الشراء.
لديك صلاحية الوصول لكل بيانات النظام (العملاء، الموردين، طلبات التسعير، أوامر الشراء، العروض، الاستلامات، التسليمات، الفواتير، المحاسبة، واتساب) وبريد الشركة.
مهامك:
- الإجابة على أي سؤال عن أي معلومة داخل النظام بالبحث في قاعدة البيانات وأدوات أخرى.
- جلب معلومات البريد الإلكتروني وقراءتها عند الطلب.
- قراءة الصور والملفات التي يرسلها المستخدم وتحليلها.
- إنشاء ملفات PDF (تقارير/ملخصات/مستندات) وإرسالها للمستخدم عند طلبها.
قواعد مهمة:
- استخدم الأدوات دائمًا للحصول على بيانات حقيقية؛ لا تخمّن أرقامًا أو معلومات.
- عند السؤال عن رقم (أمر شراء/طلب/فاتورة) استخدم lookup_document أو search_database.
- الأرقام المالية اكتبها كأرقام إنجليزية (مثل 1,234.50) والجنيه المصري عند اللزوم.
- كن موجزًا ومرتبًا، واستخدم نقاطًا عند الحاجة.
- إذا لم تتوفر معلومة، اذكر ذلك بوضوح ولا تختلقها.
- رد دائمًا بال${lang} إلا إذا طلب المستخدم غير ذلك.
- عند طلب تقرير/ملف، استخدم generate_pdf ثم أخبر المستخدم أن الملف تم إرساله.`;

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
    const result = await chatCompletion({
      model: settings.model,
      baseUrl: settings.baseUrl,
      messages,
      tools,
    });

    if (result.toolCalls.length === 0) {
      finalText = result.content;
      break;
    }

    // Echo the assistant's tool-call turn back into the conversation.
    messages.push({
      role: "assistant",
      content: result.content ?? null,
      tool_calls: result.toolCalls,
    });

    for (const call of result.toolCalls) {
      const parsed = parseArgs(call);
      usedTools.push({ name: call.function.name, args: parsed });
      const res = await executeTool(call.function.name, parsed, ctx);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: res.ok ? asText(res.data) : `ERROR: ${res.error}`,
      });
    }
  }

  if (!finalText) {
    finalText = "تم تنفيذ طلبك لكنني لم أحصل على رد نهائي. جرّب إعادة صياغة السؤال بشكل أوضح.";
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
