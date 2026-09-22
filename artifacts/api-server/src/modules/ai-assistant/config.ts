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
  model: process.env.AI_MODEL || "gpt-4o",
  baseUrl: process.env.AI_BASE_URL || null,
  systemPrompt: null,
  language: "ar",
  allowEmail: true,
  allowDatabase: true,
  allowPdf: true,
};

export const AI_API_KEY = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "";
export const DEFAULT_BASE_URL = process.env.AI_BASE_URL || "https://api.openai.com/v1";

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
