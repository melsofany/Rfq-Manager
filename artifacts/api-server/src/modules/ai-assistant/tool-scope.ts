/**
 * Per-intent tool scoping — the fix for "the assistant ignores the tools and
 * bluffs".
 *
 * ## The measured defect
 *
 * The model does NOT lack judgement. Probed live with the real provider:
 *
 * | catalogue | question | tools the model picked |
 * |---|---|---|
 * | 2 tools | «هل يوجد أمر شراء P26E11407؟» | `lookup_document` ✅ |
 * | 28 tools | «اكتر بند اتكرر في أوامر شراء EDC من الميل info» | `search_database`, `learn_organization`, `aggregate_customer_po_items` — **never `scan_email_items`** ❌ |
 * | 28 tools | «كم عدد الموردين؟» | `count_database`, `system_overview`, `run_readonly_query` ✅ |
 *
 * The same model with the same prompt chose correctly from a small catalogue and
 * chose *plausible-but-wrong* tools from a large one. That is catalogue
 * overload — and it explains the recorded behaviour precisely: it reaches for
 * `cancel_job` / `job_status` / `resend_job_report` on a data question, or
 * answers with no tool call at all, because it cannot hold 28 tool contracts in
 * view while reasoning about the question.
 *
 * Scoping is not a hint. The prompts already described the correct tool and were
 * ignored, so the WRONG tools are REMOVED from the catalogue rather than
 * discouraged in prose. The router is deterministic, free and already unit-tested
 * — this turns its output into an actual constraint.
 *
 * ## Why not merely lower MAX_TOOL_ROUNDS
 *
 * The rounds budget limits how many times the model may call a tool; it does not
 * change WHICH tool it picks. The wrong tool was chosen on round 1.
 */
import type { QueryIntent, SourceScope } from "./router";

/**
 * The always-available core: identity, memory and the universal escapes.
 *
 * Deliberately small. Everything here earns its place on EVERY question, so it
 * must never crowd out the intent-specific tools.
 */
const CORE_TOOLS = [
  "lookup_document", // one thing by its number — the most common single ask
  "search_database", // generic record search
  "count_database", // generic count
  "learn_organization", // record a document-number pattern / entity alias the operator taught
  "remember_fact", // long-term memory (cheap, no I/O)
  "recall_memory",
  "forget_memory",
  // Job state belongs to EVERY question, not just a mail one.
  //
  // Live: a mail census ran and the operator asked «إيه حالة المهمة؟» / «الي أين
  // وصلت» many times. Neither `job_status` nor the real job ids were in the
  // email-scoped catalogue, so the model could not read the true state and
  // INVENTED a progress narrative — «12% … 48% … 82% … 95% … 100%» — plus a
  // progress-bar answer for a job (`#213`) that does not exist in the database at
  // all. A capability the model cannot see is a capability it fabricates.
  //
  // Also prevents the doubled-census bug: without `job_status` the model cannot
  // check whether a job is ALREADY running, so a re-ask starts a second one.
  "job_status",
  "cancel_job",
  "resend_job_report",
];

/** Reading the mailbox: search is a SAMPLE, the censuses are totals. */
const EMAIL_TOOLS = [
  "scan_email_items", // the attachment/item census — the real analyser
  "scan_emails", // the envelope census (counts by month/sender)
  "search_emails", // sample search (inbox)
  // «what did WE send?» is a distinct question the inbox can never answer — the
  // Sent folder is found by its `\Sent` attribute, not a path. The prompt tells
  // the model to look there, so the tool MUST survive scoping or the instruction
  // is unsatisfiable.
  "search_sent_emails",
  "list_mailboxes", // which mailbox, and the default
  "get_email_attachment", // open one file
  "read_email", // read one message
  // Sending is a mail capability too. It is gated in CODE (requires
  // `confirmed:true`), so exposing it in scope is safe — removing it would make
  // "ابعت إيميل لـ EDC" unanswerable in the very scope that names the mail.
  "send_email",
  // Starting a mail census job IS reading the mail — it just reads it in the
  // background and answers on WhatsApp later. Found live: the model called
  // `start_census_job`, the reply said «بدأت المهمة الجديدة من البريد», and the
  // very same message carried «ولم يُقرأ البريد في هذه الجولة» — a self-
  // contradictory warning produced because the scope check did not recognise
  // the job-starting tool as a mail read. `job_status` / `resend_job_report`
  // report on it, and `cancel_job` stops it, so all three belong to the scope.
  "start_census_job",
  "job_status",
  "resend_job_report",
  "cancel_job",
];

/**
 * The mail-tool set, exported so `agent.ts` classifies a run by the SAME list
 * that scoped it. A second, hand-maintained copy had drifted (it lacked
 * `send_email`/`start_census_job`/`job_status`) and mislabelled a live run that
 * had started a mail census job as «لم يُقرأ البريد في هذه الجولة».
 */
export const EMAIL_TOOL_NAMES = new Set(EMAIL_TOOLS);

/** Analytic questions about procurement data. */
const ANALYTICS_TOOLS = [
  "aggregate_po_items",
  "aggregate_customer_po_items",
  "get_supplier_performance",
  "compare_supplier_quotes",
  "get_latest_supplier_price",
  "supplier_overview",
  "get_purchase_order_status",
];

/** Open procurement work: what is owed, late, or duplicated. */
const PROCUREMENT_TOOLS = [
  "get_unfulfilled_orders",
  "get_overdue_deliveries",
  "get_open_supplier_invoices",
  "get_purchase_order_status",
  "detect_duplicates",
  "find_missing_records",
  "supplier_overview",
];

/**
 * The tool names allowed for an intent.
 *
 * `null` means "no restriction" — used for the intents where scoping cannot be
 * justified, so a mis-classification degrades to the old behaviour instead of
 * hiding the tool the question needed.
 */
export function toolsForIntent(
  intent: QueryIntent,
  sourceScope: SourceScope = "any",
): string[] | null {
  /**
   * The operator named the SOURCE, so the source is a constraint.
   *
   * Measured: asked «هتخش للميل info … وليس من قاعدة البيانات», the model called
   * `search_database` on `purchase_orders`/`customers` and answered from the
   * internal tables — the exact opposite of the instruction. The tool was on the
   * table and was the easiest thing to reach for.
   *
   * With the database tools REMOVED it has no wrong source to read: the answer
   * must come from the mail tools (whose own `scan_emails` already performs the
   * mail-vs-system comparison, so nothing is lost). A prose warning was not
   * enough — the recorded runs show the email-scope warning firing on answers
   * that had already been produced from the wrong source.
   */
  if (sourceScope === "email") {
    return [
      ...EMAIL_TOOLS,
      "lookup_document", // "is this number in our system?" is still a mail-comparison need
      "classify_document_number",
      "generate_pdf",
      "start_census_job", // a full-year census may exceed one reply
      // Job STATE must be reachable here. This list spells the core entries out
      // by hand, so it had silently omitted the job tools: a mail question could
      // not read its own census's state, and the model invented a progress
      // narrative for it. Added BY NAME rather than by spreading CORE_TOOLS —
      // the core carries `search_database`/`count_database`, and spreading it
      // would re-introduce the wrong SOURCE this scope exists to remove.
      "job_status",
      "cancel_job",
      "resend_job_report",
    ];
  }

  switch (intent) {
    case "email_search":
      // The operator named the mailbox, so email tools lead. The core stays
      // available because a mail question often still needs a record looked up
      // (is this PO in our system?) — removing them would break the comparison
      // the operator actually asked for.
      return [...EMAIL_TOOLS, ...CORE_TOOLS];

    case "job_control":
      // Keep operational follow-ups small and factual. In particular, do not
      // expose the analytical catalogue to «حالة المهمة» or the model may
      // answer with a fresh census instead of reading the existing job row.
      return ["job_status", "start_census_job", "resend_job_report", "cancel_job", ...CORE_TOOLS];

    case "document_lookup":
      return [
        "lookup_document",
        "classify_document_number",
        "get_purchase_order_status",
        "count_database",
        "search_database",
        // A document question sometimes refers to a mailed order.
        "search_emails",
        "get_email_attachment",
        "read_email",
        ...CORE_TOOLS,
      ];

    case "count_aggregate":
      return [
        "count_database",
        "aggregate_po_items",
        "aggregate_customer_po_items",
        "scan_email_items",
        "scan_emails",
        ...CORE_TOOLS,
      ];

    case "analytics":
    case "report":
      return [
        ...ANALYTICS_TOOLS,
        // An analytical question is often "most repeated item", which is an
        // EMAIL census, not a database aggregate. Dropping these made the tool
        // it needed invisible — the exact regression this file exists to fix.
        "scan_email_items",
        "scan_emails",
        "run_readonly_query",
        "generate_pdf", // the answer may need a file
        "start_census_job", // and may be too big for one reply
        ...CORE_TOOLS,
      ];

    case "procurement_ops":
      return [
        ...PROCUREMENT_TOOLS,
        "run_readonly_query",
        "generate_pdf",
        "start_census_job",
        "job_status",
        ...CORE_TOOLS,
      ];

    case "supplier_lookup":
      return [
        "supplier_overview",
        "get_supplier_performance",
        "search_database",
        "count_database",
        "compare_supplier_quotes",
        "get_latest_supplier_price",
        ...CORE_TOOLS,
      ];

    case "smalltalk":
      // Conversational turns need no data tools beyond memory. Offering 28 of
      // them is what produced «تم إلغاء المهمة 177» — it reached for a job tool
      // because job tools were on the table.
      return ["remember_fact", "recall_memory", "forget_memory"];

    default:
      return null;
  }
}

/**
 * Filter the registry down to the allowed names.
 *
 * Order is preserved from the input so the catalogue the model sees stays
 * stable between runs — a reordered catalogue is a needless source of variance
 * when the whole point is to make tool choice predictable.
 *
 * Unknown names in `allowed` are ignored (a tool may be renamed or feature-
 * flagged off); an EMPTY result falls back to the full catalogue, because
 * silently offering no tools would turn a scoping mistake into a total failure.
 */
export function filterToolDefinitions<T extends { function: { name: string } }>(
  defs: T[],
  allowed: string[] | null,
): T[] {
  if (!allowed) return defs;
  const allow = new Set(allowed);
  const kept = defs.filter((d) => allow.has(d.function.name));
  return kept.length ? kept : defs;
}
