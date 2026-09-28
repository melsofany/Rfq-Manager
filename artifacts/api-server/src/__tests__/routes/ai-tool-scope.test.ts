/**
 * Tool scoping — the fix for "the assistant ignores the tools and bluffs".
 *
 * The measured defect: with the full 28-tool catalogue the model chose
 * `search_database` / `run_readonly_query` / `cancel_job` for questions that
 * needed the EMAIL census, and sometimes answered with no tool call at all. The
 * same model, offered a small catalogue, chose correctly. Cooled by scoping the
 * catalogue to the routed intent (and, when the operator named the source, to
 * that source).
 *
 * These tests pin the SCOPE, not the model: a scope that hides the tool a
 * question needs is the regression that matters, so the assertions are about
 * membership of the tool the question genuinely requires.
 */
import { describe, it, expect } from "vitest";
import {
  filterToolDefinitions,
  toolsForIntent,
  EMAIL_TOOL_NAMES,
} from "../../modules/ai-assistant/tool-scope";
import { routeQuestion } from "../../modules/ai-assistant/router";

const names = (defs: Array<{ function: { name: string } }>) => defs.map((d) => d.function.name);

describe("tool-scope: source scope is a constraint", () => {
  it("removes the database tools when the operator named the mailbox", () => {
    // «من الميل …» — the recorded failure answered this from the internal
    // purchase-order tables and presented it as a census of the mail.
    const q =
      "هتخش للميل info وهتشوف وامر الشراء كلها الوارده من EDC وهتشوف اكتر ٢٠ بند - وليس من قاعده البيانات";
    const plan = routeQuestion(q);
    expect(plan.sourceScope).toBe("email");

    const allowed = toolsForIntent(plan.intent, plan.sourceScope)!;
    expect(allowed).toContain("scan_email_items");
    expect(allowed).toContain("search_emails");
    // The wrong source must be REMOVED, not merely warned about: every recorded
    // run shows the prose warning firing after the wrong source was already read.
    expect(allowed).not.toContain("search_database");
    expect(allowed).not.toContain("count_database");
    expect(allowed).not.toContain("run_readonly_query");
    expect(allowed).not.toContain("aggregate_po_items");
    expect(allowed).not.toContain("aggregate_customer_po_items");
  });

  it("recognises the operator's real phrasings for the mail source", () => {
    for (const q of [
      "هتخش للميل info",
      "اكتر بند اتكرر من الميل",
      "ادخل الميل واقرأ المرفقات",
      "هتشوف البيانات للميل",
      "من البريد كل الرسائل",
      "وليس من قاعده البيانات",
      "من الميل مش قاعدة البيانات",
    ]) {
      expect(routeQuestion(q).sourceScope, q).toBe("email");
    }
  });

  it("does not invent an email scope for a plain database question", () => {
    for (const q of [
      "كم عدد الموردين في النظام؟",
      "هل يوجد أمر شراء رقم P26E11407؟",
      "اكتب البرومبت في الملف",
    ]) {
      expect(routeQuestion(q).sourceScope, q).toBe("any");
    }
  });
});

describe("tool-scope: per-intent catalogue", () => {
  it("gives an email_search question the mail tools", () => {
    const allowed = toolsForIntent("email_search")!;
    expect(allowed).toContain("scan_email_items");
    expect(allowed).toContain("scan_emails");
  });

  it("keeps the email census available to analytics and reports", () => {
    // «اكتر بند اتكرر» is an EMAIL census, not a database aggregate. Dropping it
    // from the analytical scope made the tool it needed invisible — the exact
    // regression this file exists to prevent.
    for (const intent of ["analytics", "report"] as const) {
      expect(toolsForIntent(intent)!, intent).toContain("scan_email_items");
    }
  });

  it("exposes EVERY mail capability the prompt tells the model to use", () => {
    // A regression guard for a real defect: `search_sent_emails` («what did WE
    // send?») and `send_email` were scoped OUT of the mail-only catalogue while
    // the prompt still instructed the model to use them — an unsatisfiable
    // instruction, and exactly the class of bug this file exists to prevent.
    const scoped = toolsForIntent("email_search", "email")!;
    for (const t of [
      "search_emails",
      "search_sent_emails",
      "scan_emails",
      "scan_email_items",
      "read_email",
      "get_email_attachment",
      "list_mailboxes",
      "send_email",
    ]) {
      expect(scoped, t).toContain(t);
    }
  });

  it("offers a conversational turn no data tools", () => {
    const allowed = toolsForIntent("smalltalk")!;
    expect(allowed).not.toContain("cancel_job");
    expect(allowed).not.toContain("start_census_job");
    expect(allowed).not.toContain("search_database");
  });

  it("is materially smaller than the full catalogue", () => {
    const full = Array.from({ length: 28 }, (_, i) => ({ function: { name: `t${i}` } }));
    for (const intent of ["email_search", "document_lookup", "count_aggregate"] as const) {
      expect(toolsForIntent(intent)!.length, intent).toBeLessThan(full.length);
    }
  });
});

describe("tool-scope: the mail-tool set is the ONE source of truth", () => {
  it("counts starting a census job as reading the mail", () => {
    // Live: the operator asked for a mail census, the model called
    // `start_census_job`, the reply said «بدأت المهمة الجديدة من البريد» — and the
    // SAME message carried «ولم يُقرأ البريد في هذه الجولة». The warning came from
    // a second, drifted copy of the mail-tool set in `agent.ts` that did not list
    // the job tool. Both now come from this exported set.
    for (const t of ["start_census_job", "job_status", "resend_job_report", "cancel_job"]) {
      expect(EMAIL_TOOL_NAMES.has(t), t).toBe(true);
    }
  });

  it("covers every tool that genuinely reads the mailbox", () => {
    // The set must list every mailbox-READING capability, or a run that used the
    // mail is judged as "no mail was read". The list is explicit so adding a
    // reader without classifying it here is a deliberate act, not an oversight.
    for (const t of [
      "scan_email_items",
      "scan_emails",
      "search_emails",
      "search_sent_emails",
      "read_email",
      "get_email_attachment",
      "list_mailboxes",
      "send_email",
      "start_census_job",
    ]) {
      expect(EMAIL_TOOL_NAMES.has(t), `${t} must count as a mail read`).toBe(true);
    }
  });
});

describe("tool-scope: filterToolDefinitions", () => {
  const defs = [
    { function: { name: "scan_email_items" } },
    { function: { name: "search_database" } },
    { function: { name: "lookup_document" } },
  ];

  it("keeps only the allowed names, preserving order", () => {
    expect(names(filterToolDefinitions(defs, ["lookup_document", "scan_email_items"]))).toEqual([
      "scan_email_items",
      "lookup_document",
    ]);
  });

  it("preserves the full catalogue when the scope is null", () => {
    expect(names(filterToolDefinitions(defs, null))).toEqual(names(defs));
  });

  it("falls back to the full catalogue when nothing matches", () => {
    // A scoping mistake must degrade to the old behaviour, never to "no tools":
    // offering none would turn a typo into a total failure.
    expect(names(filterToolDefinitions(defs, ["does_not_exist"]))).toEqual(names(defs));
  });
});
