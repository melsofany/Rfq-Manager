/**
 * ONE permission layer for every tool the agent can reach.
 *
 * The agent had per-tool flags (`allowDatabase`, `allowEmail`, …) and a
 * `confirmed:true` argument on `send_email`, but no single place that says what
 * a tool IS. That is how a capability ends up reachable by accident: the guard
 * lives in the tool body, so a new tool is unguarded until someone remembers,
 * and an argument-supplied confirmation is a rule the MODEL can satisfy on its
 * own — the operator never saw it.
 *
 * This module classifies each tool by EFFECT and decides centrally:
 *
 *   read    — observes the system, changes nothing
 *   write   — changes internal data (journal, memory, learning)
 *   send    — leaves the company: WhatsApp, email, a file to a third party
 *
 * A `send` never happens on the model's say-so. It needs an explicit operator
 * approval recorded in the task record, so «أرسل العرض للمورد» becomes a step
 * the operator confirms rather than something the model decides mid-loop.
 *
 * Pure and dependency-free: the classification is unit-testable, and the
 * registry guard fails when a tool is added without a class.
 */

export type ToolEffect = "read" | "write" | "send";

/**
 * Every tool the agent can dispatch. `send` is the smallest set on purpose —
 * these leave the building.
 */
const TOOL_EFFECTS: Record<string, ToolEffect> = {
  // ── Leaves the company ──────────────────────────────────────────────────
  send_email: "send",
  send_whatsapp: "send",

  // ── Changes internal state ──────────────────────────────────────────────
  remember_fact: "write",
  forget_memory: "write",
  learn_organization: "write",
  start_census_job: "write",
  cancel_job: "write",
  resend_job_report: "send", // re-delivers a file to the operator

  // ── Observes ────────────────────────────────────────────────────────────
  search_database: "read",
  count_database: "read",
  describe_schema: "read",
  run_readonly_query: "read",
  system_overview: "read",
  supplier_overview: "read",
  lookup_document: "read",
  get_purchase_order_status: "read",
  get_supplier_performance: "read",
  aggregate_customer_po_items: "read",
  aggregate_po_items: "read",
  get_unfulfilled_orders: "read",
  get_latest_supplier_price: "read",
  get_open_supplier_invoices: "read",
  get_overdue_deliveries: "read",
  compare_supplier_quotes: "read",
  detect_duplicates: "read",
  find_missing_records: "read",
  search_emails: "read",
  search_sent_emails: "read",
  scan_emails: "read",
  scan_email_items: "read",
  list_mailboxes: "read",
  read_email: "read",
  get_email_attachment: "read",
  classify_document_number: "read",
  recall_memory: "read",
  job_status: "read",
  // `generate_pdf` builds a file but sends nothing — delivery is a separate,
  // classified act. Treating it as `send` would block report generation.
  generate_pdf: "write",
};

export const KNOWN_TOOLS = Object.keys(TOOL_EFFECTS);

/** Tools that read or send mail — gated by `allowEmail`, not `allowDatabase`. */
const MAIL_TOOLS = new Set(
  KNOWN_TOOLS.filter((n) => n.includes("email") || n.includes("mail") || n === "scan_email_items"),
);

export function toolEffect(name: string): ToolEffect | null {
  return TOOL_EFFECTS[name] ?? null;
}

/**
 * An unknown tool is refused, not assumed safe. A tool that reaches the
 * dispatcher without a classification is a defect, and the safe reading of an
 * unknown capability is «no».
 */
export function isKnownTool(name: string): boolean {
  return name in TOOL_EFFECTS;
}

export interface ToolDecision {
  allowed: boolean;
  /** Arabic reason, shown to the model so it reformulates or asks the operator. */
  reason?: string;
  requiresApproval: boolean;
}

export interface PermissionContext {
  settings: {
    allowDatabase?: boolean;
    allowEmail?: boolean;
    allowReadOnlySql?: boolean;
  };
  /** Approval the OPERATOR gave for this task, not an argument the model passed. */
  approvedEffects?: ToolEffect[];
}

export function decideToolUse(name: string, ctx: PermissionContext): ToolDecision {
  const effect = toolEffect(name);
  if (!effect) {
    return {
      allowed: false,
      reason: `الأداة «${name}» غير معروفة ولا يوجد تصنيف صلاحية لها، فلم تُنفَّذ.`,
      requiresApproval: false,
    };
  }

  // The operator's feature gates stay authoritative — the planner must not
  // route around a switch the operator turned off. Each capability is checked
  // on its OWN gate: a mail tool must not pass because the DATABASE gate is on,
  // which is how a disabled mailbox stayed reachable.
  const isMail = MAIL_TOOLS.has(name);
  if (isMail && ctx.settings.allowEmail === false) {
    return { allowed: false, reason: "الوصول للبريد معطّل في الإعدادات.", requiresApproval: false };
  }
  const isMemory = name === "recall_memory" || name === "remember_fact" || name === "forget_memory";
  if (!isMail && !isMemory && name !== "generate_pdf" && ctx.settings.allowDatabase === false) {
    return {
      allowed: false,
      reason: "الوصول لقاعدة البيانات معطّل في الإعدادات.",
      requiresApproval: false,
    };
  }
  if (name === "run_readonly_query" && ctx.settings.allowReadOnlySql === false) {
    return {
      allowed: false,
      reason: "الاستعلام الحر معطّل في الإعدادات.",
      requiresApproval: false,
    };
  }

  if (effect === "send") {
    const approved = (ctx.approvedEffects ?? []).includes("send");
    return approved
      ? { allowed: true, requiresApproval: false }
      : {
          allowed: false,
          requiresApproval: true,
          reason:
            "هذه الخطوة تُرسل شيئًا خارج الشركة (واتساب/إيميل/ملف لطرف ثالث). " +
            "لا تُنفَّذ من تلقاء نفسك: اعرض ما سترسله واطلب موافقة المشغّل صريحًا، ثم نفّذها بعد الموافقة.",
        };
  }

  return { allowed: true, requiresApproval: false };
}

/**
 * Approval is granted by the OPERATOR, in their own message — not by the model.
 * The model can describe intent; only a human reply carrying an approval phrase
 * unlocks `send`, so «أرسل العرض» typed by the model is not consent.
 */
const APPROVAL_RE =
  /(?:^|\s)(?:موافق|موافقة|أوافق|اوافق|تمام\s*ابعت|ابعت\s*فعلا|ابعت\s*فعلًا|نفّذ|نفذ|اعتمد|اعتماد|اكمل|أكمل|go\s*ahead|approve|approved|send\s*it)(?:\s|$)/i;

export function operatorApprovedSend(operatorText: string): boolean {
  return APPROVAL_RE.test(String(operatorText ?? ""));
}
