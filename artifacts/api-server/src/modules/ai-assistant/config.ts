/**
 * AI Assistant — configuration & access control
 *
 * The assistant is a WhatsApp agent restricted to admins/managers. A phone
 * number must be present (and active) in `ai_assistant_users`. Registration is
 * managed from the portal and is itself restricted to admin/manager roles.
 */
import { db, aiAssistantUsersTable, aiAssistantSettingsTable, employeesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../shared/logger";

export const DEFAULT_MODEL = process.env.AI_MODEL || "gemini-3.8-flash";
// Default to Google Gemini's OpenAI-compatible endpoint. Any OpenAI-compatible
// gateway still works by setting AI_BASE_URL.
export const DEFAULT_BASE_URL =
  process.env.AI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai";

/**
 * Models tried, in order, when the primary model is unavailable or out of
 * quota (Gemini free tier is 20 requests/day/model). Only used on the Gemini
 * endpoint, where these ids exist. Override with AI_FALLBACK_MODELS.
 */
export const FALLBACK_MODELS = (
  process.env.AI_FALLBACK_MODELS || "gemini-3.6-flash,gemini-3.1-flash-lite"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

export interface AiSettings {
  enabled: boolean;
  model: string;
  baseUrl: string | null;
  systemPrompt: string | null;
  language: string;
  allowEmail: boolean;
  allowDatabase: boolean;
  allowPdf: boolean;
}

export const DEFAULT_SETTINGS: AiSettings = {
  enabled: true,
  model: DEFAULT_MODEL,
  baseUrl: process.env.AI_BASE_URL || null,
  systemPrompt: null,
  language: "ar",
  allowEmail: true,
  allowDatabase: true,
  allowPdf: true,
};

export const AI_API_KEY =
  process.env.AI_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || "";

/**
 * True when the configured endpoint is Google Gemini. Gemini shares the OpenAI
 * wire format for chat/tools/vision, but differs in two ways that matter here:
 * a native `generateContent` endpoint must be used for WhatsApp voice notes
 * (the OpenAI-compat audio path rejects `ogg`), and Gemini 3 requires the
 * assistant tool-call turn's `thought_signature` to be echoed back.
 */
export function isGeminiEndpoint(baseUrl?: string | null): boolean {
  const base = baseUrl || DEFAULT_BASE_URL;
  return /generativelanguage\.googleapis\.com/i.test(base);
}

export const isAiConfigured = Boolean(AI_API_KEY);

const MAX_HISTORY = 12;

export async function loadSettings(): Promise<AiSettings> {
  try {
    const [row] = await db
      .select()
      .from(aiAssistantSettingsTable)
      .where(eq(aiAssistantSettingsTable.key, "default"))
      .limit(1);
    if (!row) return { ...DEFAULT_SETTINGS };
    return {
      enabled: row.enabled,
      model: row.model || DEFAULT_SETTINGS.model,
      baseUrl: row.baseUrl,
      systemPrompt: row.systemPrompt,
      language: row.language || "ar",
      allowEmail: row.allowEmail,
      allowDatabase: row.allowDatabase,
      allowPdf: row.allowPdf,
    };
  } catch (err) {
    logger.warn({ err }, "AI assistant: could not load settings, using defaults");
    return { ...DEFAULT_SETTINGS };
  }
}

/** Digits-only canonical phone form — matches how representatives are stored. */
export function canonicalPhone(phone: string): string {
  // eslint-disable-next-line no-control-regex
  let cleaned = phone.replace(
    /[\u2066\u2067\u2068\u2069\u200e\u200f\u202a\u202b\u202c\u202d\u202e]/g,
    "",
  );
  cleaned = cleaned.replace(/[^\d]/g, "");
  if (cleaned.startsWith("00")) cleaned = cleaned.slice(2);
  if (cleaned.length === 11 && cleaned.startsWith("0")) cleaned = "2" + cleaned;
  if (cleaned.length === 10 && cleaned.startsWith("1")) cleaned = "20" + cleaned;
  return cleaned;
}

export interface AiAuthorizedUser {
  id: number;
  phone: string;
  name: string | null;
  employeeId: number | null;
  role: string;
}

/**
 * Resolve an allowlisted AI user for an incoming phone, verifying the linked
 * employee is still active. Returns null when the number is not authorized.
 */
export async function findAuthorizedUser(phone: string): Promise<AiAuthorizedUser | null> {
  const target = canonicalPhone(phone);
  const rows = await db
    .select()
    .from(aiAssistantUsersTable)
    .where(eq(aiAssistantUsersTable.isActive, true));
  const match = rows.find((r) => canonicalPhone(r.phone) === target);
  if (!match) return null;

  if (match.employeeId != null) {
    const [employee] = await db
      .select({ isActive: employeesTable.isActive })
      .from(employeesTable)
      .where(eq(employeesTable.id, match.employeeId))
      .limit(1);
    if (!employee || !employee.isActive) return null;
  }
  return {
    id: match.id,
    phone: canonicalPhone(match.phone),
    name: match.name,
    employeeId: match.employeeId,
    role: match.role,
  };
}

export { MAX_HISTORY };
