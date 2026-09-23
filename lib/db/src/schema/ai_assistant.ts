import { pgTable, text, serial, timestamp, integer, boolean, jsonb } from "drizzle-orm/pg-core";
import { employeesTable } from "./employees";

// ─── AI assistant allowlist ────────────────────────────────────────────────
// The assistant is restricted to admin/manager only. Access is granted per
// phone number; a number must be on the allowlist AND belong to an active
// employee whose role is admin/manager.
export const aiAssistantUsersTable = pgTable("ai_assistant_users", {
  id: serial("id").primaryKey(),
  phone: text("phone").notNull().unique(),
  name: text("name"),
  employeeId: integer("employee_id").references(() => employeesTable.id, { onDelete: "set null" }),
  role: text("role").notNull().default("manager"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Conversation history ──────────────────────────────────────────────────
// Short rolling history per phone so the assistant has multi-turn context.
// `role` is "user" | "assistant"; `content` is the raw text; `toolCalls`
// optionally records which tools were invoked for auditability.
export const aiAssistantMessagesTable = pgTable("ai_assistant_messages", {
  id: serial("id").primaryKey(),
  phone: text("phone").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  toolCalls: jsonb("tool_calls").$type<unknown>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Settings (single row, key='default') ──────────────────────────────────
// Editable from the admin UI: which model/endpoint to use, the default reply
// language, and whether read-only DB access is enabled at all.
export const aiAssistantSettingsTable = pgTable("ai_assistant_settings", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().default("default").unique(),
  enabled: boolean("enabled").notNull().default(true),
  model: text("model").notNull().default("gemini-3.8-flash"),
  baseUrl: text("base_url"),
  systemPrompt: text("system_prompt"),
  language: text("language").notNull().default("ar"),
  allowEmail: boolean("allow_email").notNull().default(true),
  allowDatabase: boolean("allow_database").notNull().default(true),
  allowPdf: boolean("allow_pdf").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Long-term memory ──────────────────────────────────────────────────────
// Durable facts the assistant carries across conversations, so it "learns"
// instead of re-deriving everything every time. Modelled on the open-source
// agent-memory line of work:
//   - Mem0: extract salient facts, then CONSOLIDATE (add/update/delete/noop)
//     rather than appending duplicates — hence the unique `key` per scope.
//   - Letta/MemGPT: the agent edits its own memory through tools, and the
//     most relevant entries are injected into the prompt ("core memory").
//   - Graphiti/Zep: a fact is time-scoped (`validFrom`/`validUntil`), so a
//     superseded fact is closed rather than destroyed — we keep the history.
//
// `phone` scopes a memory to the person who taught it (''=shared/company-wide),
// `importance` (0-100) and `useCount`/`lastUsedAt` feed local retrieval scoring.
export const aiAssistantMemoriesTable = pgTable("ai_assistant_memories", {
  id: serial("id").primaryKey(),
  /** Owner scope: a canonical phone, or '' for company-wide/shared memories. */
  phone: text("phone").notNull().default(""),
  /** fact | preference | entity | rule | lesson */
  category: text("category").notNull().default("fact"),
  /** Short lookup key, unique per (phone, category) for consolidation. */
  key: text("key").notNull(),
  value: text("value").notNull(),
  /** 0-100; higher survives pruning and ranks earlier in the prompt. */
  importance: integer("importance").notNull().default(50),
  /** Who introduced it: "user" | "assistant" | "admin" | "system". */
  source: text("source").notNull().default("user"),
  /** Pinned memories are never auto-pruned and always injected. */
  pinned: boolean("pinned").notNull().default(false),
  /** When the fact became true (bi-temporal); null = unknown/from creation. */
  validFrom: timestamp("valid_from", { withTimezone: true }),
  /** When it stopped being true; null = still current. Superseding closes it. */
  validUntil: timestamp("valid_until", { withTimezone: true }),
  useCount: integer("use_count").notNull().default(0),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Conversation state (P4) ───────────────────────────────────────────────
// A small per-phone "current context" so a follow-up question understands what
// «وطب آخر سعر له؟» refers to without re-running the whole search. This is NOT
// chat history (that is `ai_assistant_messages`): it is the last entity, period
// and job the operator was talking about, refreshed on every answered turn.
export const aiAssistantStateTable = pgTable("ai_assistant_state", {
  id: serial("id").primaryKey(),
  phone: text("phone").notNull().unique(),
  /** Last document the conversation referred to. */
  lastDocumentType: text("last_document_type"),
  lastDocumentNumber: text("last_document_number"),
  /** Last supplier / customer named in the conversation. */
  lastSupplier: text("last_supplier"),
  lastCustomer: text("last_customer"),
  /** Last part referenced (feeds «آخر سعر له»). */
  lastPartNo: text("last_part_no"),
  /** Last time scope, as the operator phrased it (e.g. "2026", "آخر شهر"). */
  lastPeriod: text("last_period"),
  /** Last async job started from this conversation. */
  lastJobId: integer("last_job_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Async jobs (P4/P6) ────────────────────────────────────────────────────
// Large operations (a year-long email census, hundreds of attachments, a big
// report) run as a tracked background job instead of blocking the WhatsApp
// reply. Progress is written to this row so the operator can be told where the
// job stands and a follow-up question can read its result.
export const aiAssistantJobsTable = pgTable("ai_assistant_jobs", {
  id: serial("id").primaryKey(),
  phone: text("phone").notNull(),
  /** e.g. "email_census", "email_items", "compare_email_db". */
  kind: text("kind").notNull(),
  /** queued | running | completed | failed | cancelled */
  status: text("status").notNull().default("queued"),
  /** The original question, for the job list. */
  question: text("question"),
  /** Input parameters, JSON. */
  params: jsonb("params").$type<unknown>(),
  /** Progress counters, JSON (e.g. {scanned, matched, processed}). */
  progress: jsonb("progress").$type<unknown>(),
  /** Final result summary, JSON. */
  result: jsonb("result").$type<unknown>(),
  error: text("error"),
  /** Idempotency: a re-issued identical job resumes rather than restarts. */
  jobKey: text("job_key"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AiAssistantUser = typeof aiAssistantUsersTable.$inferSelect;
export type AiAssistantMessage = typeof aiAssistantMessagesTable.$inferSelect;
export type AiAssistantSettings = typeof aiAssistantSettingsTable.$inferSelect;
export type AiAssistantMemory = typeof aiAssistantMemoriesTable.$inferSelect;
export type AiAssistantState = typeof aiAssistantStateTable.$inferSelect;
export type AiAssistantJob = typeof aiAssistantJobsTable.$inferSelect;
