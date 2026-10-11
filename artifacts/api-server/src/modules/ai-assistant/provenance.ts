/**
 * AI Assistant — provenance footer.
 *
 * Whether an answer rests on data or on the model's own words is the one thing an
 * operator cannot see in the text. Prompting the model to cite its sources relies
 * on the model being honest about itself; this footer is built by CODE from the
 * tools that actually ran and succeeded, so it can only say what happened.
 *
 *  - answer backed by tools → «المصدر: …» listing the real tables / the mailbox;
 *  - a data question answered with NO successful tool → an explicit warning.
 *
 * It is appended to the outgoing reply only, never stored in the history, so the
 * model cannot learn to imitate it without having run a tool.
 */
import type { QueryIntent } from "./router";
import { EMAIL_TOOLS } from "./answer-guard";

interface UsedTool {
  name: string;
  args: unknown;
  ok: boolean;
}

const DATA_INTENTS = new Set<QueryIntent>([
  "document_lookup",
  "supplier_lookup",
  "count_aggregate",
  "email_search",
  "report",
  "analytics",
  "procurement_ops",
]);

/** Tools that read nothing from the data sources. */
const NON_SOURCE_TOOLS = new Set([
  "job_status",
  "cancel_job",
  "resend_job_report",
  "start_census_job",
  "remember_fact",
  "recall_memory",
  "forget_memory",
  "learn_organization",
  "describe_schema",
  "classify_document_number",
  "list_mailboxes",
  "send_email",
  "generate_pdf",
]);

function tablesFromSql(sql: unknown): string[] {
  if (typeof sql !== "string") return [];
  return [...sql.matchAll(/\b(?:from|join)\s+"?([a-z_][a-z0-9_]*)"?/gi)].map((m) =>
    m[1].toLowerCase(),
  );
}

export function provenanceFooter(opts: {
  intent: QueryIntent;
  reply: string;
  usedTools: UsedTool[];
}): string {
  const { reply } = opts;
  if (opts.intent === "smalltalk" || opts.intent === "job_control") return "";
  if (/المصدر\s*[:：]/.test(reply)) return "";
  if (reply.trim().length < 40) return "";

  const ok = opts.usedTools.filter((t) => t.ok && !NON_SOURCE_TOOLS.has(t.name));
  const tables = new Set<string>();
  let mail = false;
  let otherDb = false;
  for (const t of ok) {
    const args = (t.args && typeof t.args === "object" ? t.args : {}) as Record<string, unknown>;
    if (EMAIL_TOOLS.has(t.name)) {
      mail = true;
    } else if (t.name === "search_database" && typeof args.table === "string") {
      tables.add(args.table);
    } else if (t.name === "run_readonly_query") {
      for (const x of tablesFromSql(args.sql)) tables.add(x);
    } else if (t.name === "lookup_document" && typeof args.type === "string") {
      tables.add(String(args.type));
    } else {
      otherDb = true;
    }
  }

  const parts: string[] = [];
  if (tables.size || otherDb) {
    const list = [...tables].slice(0, 4).join("، ");
    parts.push(`قاعدة البيانات${list ? ` (${list})` : ""}`);
  }
  if (mail) parts.push("البريد الإلكتروني");
  if (parts.length) return `\n\n— المصدر: ${parts.join(" · ")}`;

  // No successful read, yet the operator asked about data and the reply states
  // concrete facts: say plainly that nothing was looked up.
  if (DATA_INTENTS.has(opts.intent) && /\d{3,}|[A-Za-z]+\d{3,}/.test(reply)) {
    return "\n\n⚠️ هذا الرد لم يستند إلى أي نتيجة من قاعدة البيانات أو البريد في هذه الجولة — تحقّق منه قبل الاعتماد عليه.";
  }
  return "";
}
