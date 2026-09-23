/**
 * AI Assistant — evaluation suite.
 *
 * A labelled dataset plus a runner that scores the assistant's DETERMINISTIC
 * layers (the intent router and its tool hints) without touching the network or
 * spending a single model request. The prompt that drove this work asked for a
 * regression gate that reports accuracy / latency / tool-selection after every
 * change; this is that gate's offline half.
 *
 * Why offline only: the scarce resource in this system is the model quota
 * (Gemini free tier is 20 requests/day/MODEL). An evaluation that spent real
 * requests on every CI run would consume the very budget it exists to protect,
 * and would be non-deterministic (model variance) in CI.
 *
 * The live half is deliberately opt-in: `runLiveEvaluation` exists so a human can
 * run a fuller check on a machine with a key, but nothing in the normal suite
 * calls it.
 */
import { routeQuestion, type QueryIntent, type QueryPath } from "./router";

export interface EvalCase {
  /** The question exactly as an operator would type it. */
  question: string;
  /** Intents that would be acceptable for this question. */
  expectedIntents: QueryIntent[];
  /** The path it must take — this is the safety-critical assertion. */
  expectedPath: QueryPath;
  /** Tools the answer would legitimately need (advisory, for the live half). */
  allowedTools?: string[];
  /** The hard ceiling this question should be answered within, in ms. */
  maxLatencyMs?: number;
  /** Why this case exists — traces it back to a real incident where it can. */
  note?: string;
}

/**
 * The labelled set. Deliberately Arabic-first with English coverage, and shaped
 * around the failures that actually happened in this project (the census sample
 * reported as a total, the invented supplier name, the analyzer treated as a
 * quick lookup).
 */
export const EVAL_CASES: EvalCase[] = [
  // ── Document lookups (must be fast) ──────────────────────────────────────
  {
    question: "أمر الشراء P26E11407 تبع مين؟",
    expectedIntents: ["document_lookup"],
    expectedPath: "fast",
    allowedTools: ["lookup_document", "get_purchase_order_status"],
    maxLatencyMs: 30_000,
  },
  {
    question: "رقم الفاتورة 45001234",
    expectedIntents: ["document_lookup"],
    expectedPath: "fast",
    note: "a bare document number must not trigger a full scan",
  },
  {
    question: "إيه حالة أمر الشراء 104؟",
    expectedIntents: ["document_lookup"],
    expectedPath: "fast",
    allowedTools: ["get_purchase_order_status", "lookup_document"],
  },

  // ── Supplier lookups (must be fast, single round) ────────────────────────
  {
    question: "مين مورد هاي فولت؟",
    expectedIntents: ["supplier_lookup"],
    expectedPath: "fast",
    allowedTools: ["supplier_overview"],
    note: "the «هاي فولت» incident: a supplier name must resolve in one call",
  },
  {
    question: "أداء المورد EDC إيه؟",
    expectedIntents: ["supplier_lookup", "analytics"],
    expectedPath: "fast",
    allowedTools: ["get_supplier_performance", "supplier_overview"],
  },

  // ── Counting (fast but verified) ─────────────────────────────────────────
  {
    question: "كام أمر شراء عندنا؟",
    expectedIntents: ["count_aggregate"],
    expectedPath: "fast",
    allowedTools: ["count_database"],
  },
  {
    question: "how many suppliers are registered?",
    expectedIntents: ["count_aggregate"],
    expectedPath: "fast",
  },

  // ── Analyses and email scopes (must go deep) ─────────────────────────────
  {
    question: "اعمل حصر لكل PO في البريد خلال 2026",
    expectedIntents: ["analytics", "email_search"],
    expectedPath: "deep",
    allowedTools: ["scan_emails", "scan_email_items"],
    note: "the 3,710-message census: must not be answered from a sample",
  },
  {
    question: "إيه أكتر بند اتكرر؟",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
    allowedTools: ["aggregate_po_items", "scan_email_items"],
  },
  {
    question: "قارن البريد بالنظام وأقولي الأرقام الناقصة",
    expectedIntents: ["analytics", "email_search"],
    expectedPath: "deep",
    allowedTools: ["scan_emails", "find_missing_records"],
  },
  {
    question: "هات كل المرفقات من إيميلات EDC",
    expectedIntents: ["email_search"],
    expectedPath: "deep",
    allowedTools: ["search_emails", "scan_email_items"],
  },
  {
    question: "اعمل تقرير كامل بكل البنود",
    expectedIntents: ["report"],
    expectedPath: "deep",
    allowedTools: ["aggregate_po_items", "generate_pdf"],
  },
  {
    question: "إيه أوامر الشراء اللي لسه ما اترحّلتش لأي مورد؟",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
    allowedTools: ["get_unfulfilled_orders"],
  },

  // ── Ambiguous / misspelled (must degrade to deep, never guess) ───────────
  {
    question: "الوضع عامل ايه النهاردة يا باشا",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
    note: "unclassifiable → safe default, never a fabricated quick answer",
  },
  {
    question: "اه ياعم شغل",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
    note: "slang/incomplete → deep, not smalltalk",
  },

  // ── Greetings (must be fast, no verification) ────────────────────────────
  {
    question: "السلام عليكم",
    expectedIntents: ["smalltalk"],
    expectedPath: "fast",
    note: "no facts to verify — must not spend a verification round",
  },
  {
    question: "صباح الخير يا هندسة",
    expectedIntents: ["smalltalk"],
    expectedPath: "fast",
  },
  {
    question: "شكراً جداً",
    expectedIntents: ["smalltalk"],
    expectedPath: "fast",
  },

  // ── Purchase orders (volume coverage) ────────────────────────────────────
  {
    question: "P26E13477 اتبعت لمين؟",
    expectedIntents: ["document_lookup"],
    expectedPath: "fast",
    allowedTools: ["lookup_document", "get_purchase_order_status"],
  },
  {
    question: "وريني أمر الشراء 45001234",
    expectedIntents: ["document_lookup"],
    expectedPath: "fast",
  },
  {
    question: "حالة أمر الشراء رقم 9001 ايه؟",
    expectedIntents: ["document_lookup"],
    expectedPath: "fast",
  },
  {
    question: "امتى اتبعت أمر الشراء CPO-2026-000123؟",
    expectedIntents: ["document_lookup"],
    expectedPath: "fast",
  },
  {
    question: "الـ PO بتاع مورد EDC وصل ولا لسه؟",
    expectedIntents: ["document_lookup", "supplier_lookup"],
    expectedPath: "fast",
  },
  {
    question: "أوامر الشراء المفتوحة كام؟",
    expectedIntents: ["count_aggregate", "analytics"],
    expectedPath: "fast",
    allowedTools: ["count_database", "get_unfulfilled_orders"],
  },
  {
    question: "ليه فيه أوامر شراء لسه ما اتبعتتش؟",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
    allowedTools: ["get_unfulfilled_orders"],
  },
  {
    question: "إجمالي كميات البنود في أوامر الشراء",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
    allowedTools: ["aggregate_po_items"],
  },
  {
    question: "أوامر الشراء المتأخرة عن التسليم",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
    allowedTools: ["get_overdue_deliveries", "get_unfulfilled_orders"],
  },
  {
    question: "الأصناف اللي اتكررت في أوامر الشراء",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
    allowedTools: ["aggregate_po_items", "detect_duplicates"],
  },

  // ── Suppliers (volume coverage) ──────────────────────────────────────────
  {
    question: "مين المورد بتاع القواطع الكهربائية؟",
    expectedIntents: ["supplier_lookup"],
    expectedPath: "fast",
  },
  {
    question: "أرقام الموردين المسجلين",
    expectedIntents: ["count_aggregate"],
    expectedPath: "fast",
  },
  {
    question: "قارن أداء الموردين في آخر سنة",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
    allowedTools: ["get_supplier_performance"],
  },
  {
    question: "أفضل مورد من حيث عدد أوامر الشراء",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
    allowedTools: ["get_supplier_performance"],
  },
  {
    question: "الموردين اللي عرضوا أسعار آخر شهر",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
  },
  {
    question: "كل مورد عندنا رصيده كام؟",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
    allowedTools: ["get_supplier_performance"],
  },

  // ── Offers / quotations / pricing (volume coverage) ──────────────────────
  {
    question: "قارن عروض الموردين لطلب التسعير ده",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
    allowedTools: ["compare_supplier_quotes"],
  },
  {
    question: "أرخص عرض لبند الكابل النحاس",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
    allowedTools: ["get_latest_supplier_price"],
  },
  {
    question: "آخر سعر للمورد EDC على البند ده",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
    allowedTools: ["get_latest_supplier_price"],
  },
  {
    question: "الفرق بين أسعار العروض في RFQ رقم 26R011954",
    expectedIntents: ["analytics", "document_lookup"],
    expectedPath: "deep",
    allowedTools: ["compare_supplier_quotes", "lookup_document"],
  },
  {
    question: "كام عرض سعر وصل للطلب ده؟",
    expectedIntents: ["count_aggregate", "analytics"],
    expectedPath: "fast",
  },

  // ── Email / attachments (volume coverage, must all go deep) ──────────────
  {
    question: "ابحث في البريد عن إيميلات شركة EDC",
    expectedIntents: ["email_search"],
    expectedPath: "deep",
    allowedTools: ["search_emails", "scan_emails"],
  },
  {
    question: "هات آخر 10 إيميلات من المورد EDC",
    expectedIntents: ["email_search"],
    expectedPath: "deep",
    allowedTools: ["search_emails"],
  },
  {
    question: "فين بند الأريستون في المرفقات؟",
    expectedIntents: ["email_search", "analytics"],
    expectedPath: "deep",
    allowedTools: ["scan_email_items"],
  },
  {
    question: "اقرأ المرفق اللي في إيميل أمر الشراء ده",
    expectedIntents: ["email_search"],
    expectedPath: "deep",
    allowedTools: ["get_email_attachment", "read_email"],
  },
  {
    question: "اعمل حصر لكل أوامر الشراء في البريد خلال السنة",
    expectedIntents: ["analytics", "email_search"],
    expectedPath: "deep",
    allowedTools: ["scan_emails", "scan_email_items"],
  },
  {
    question: "قارن أرقام أوامر الشراء في البريد مع النظام",
    expectedIntents: ["analytics", "email_search"],
    expectedPath: "deep",
    allowedTools: ["scan_emails", "find_missing_records"],
  },
  {
    question: "إيه الإيميلات اللي فيها ملفات PDF للأسعار؟",
    expectedIntents: ["email_search"],
    expectedPath: "deep",
    allowedTools: ["search_emails", "scan_email_items"],
  },
  {
    question: "الأرقام اللي في البريد ومش موجودة في النظام",
    expectedIntents: ["analytics", "email_search"],
    expectedPath: "deep",
    allowedTools: ["scan_emails", "find_missing_records"],
  },
  {
    question: "ابعت تقرير بالأرقام الناقصة على PDF",
    expectedIntents: ["report", "email_search"],
    expectedPath: "deep",
    allowedTools: ["scan_emails", "generate_pdf"],
  },

  // ── Invoices / payments (volume coverage) ────────────────────────────────
  {
    question: "فواتير الموردين المفتوحة كام؟",
    expectedIntents: ["count_aggregate", "analytics"],
    expectedPath: "fast",
    allowedTools: ["get_open_supplier_invoices"],
  },
  {
    question: "إيه الفواتير المستحقة على مورد EDC؟",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
    allowedTools: ["get_open_supplier_invoices"],
  },
  {
    question: "إجمالي الفواتير المستحقة هذا الشهر",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
    allowedTools: ["get_open_supplier_invoices"],
  },
  {
    question: "حالة فاتورة رقم 45009999",
    expectedIntents: ["document_lookup"],
    expectedPath: "fast",
  },
  {
    question: "الضرائب على مشتريات الشهر",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
  },

  // ── Ambiguous / misspelled (volume coverage) ─────────────────────────────
  {
    question: "عايز أشوف المورردين",
    expectedIntents: ["analytics", "supplier_lookup"],
    expectedPath: "deep",
    note: "misspelling must not produce a confident wrong answer",
  },
  {
    question: "الاوامر بتاعت الشراء",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
  },
  {
    question: "البنود اللي مش موجودة",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
  },
  {
    question: "طب وده ايه؟",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
    note: "pronoun-only follow-up → deep; the conversation state supplies the noun",
  },
  {
    question: "وطب آخر سعر له؟",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
    note: "the «وطب آخر سعر له» follow-up the conversation state exists to resolve",
  },
  {
    question: "مين أكبر مورد في المعدات؟",
    expectedIntents: ["supplier_lookup", "analytics"],
    expectedPath: "fast",
  },
  {
    question: "المخزون اللي خلص ولا لسه؟",
    expectedIntents: ["analytics"],
    expectedPath: "deep",
  },
];

export interface EvalCaseResult {
  question: string;
  passed: boolean;
  intent: QueryIntent;
  path: QueryPath;
  reason: string;
  /** Only the offline router portion is timed here; it must be negligible. */
  routeMs: number;
}

export interface EvalReport {
  total: number;
  passed: number;
  /** Fraction of cases whose router decision matched the label (0–1). */
  accuracy: number;
  /** Fraction whose PATH matched — the safety-critical metric (0–1). */
  pathAccuracy: number;
  /** Median router time across the set, in ms. */
  medianRouteMs: number;
  /** Worst router time, in ms. */
  maxRouteMs: number;
  failures: EvalCaseResult[];
  results: EvalCaseResult[];
}

/**
 * Score the deterministic router against the dataset.
 *
 * Returns BOTH an overall accuracy and a path-only accuracy, because they can
 * disagree: an intent may be labelled with two acceptable values while the path
 * is non-negotiable. Reporting them separately stops a lenient intent list from
 * masking a path regression.
 */
export function runOfflineEvaluation(cases: EvalCase[] = EVAL_CASES): EvalReport {
  const results: EvalCaseResult[] = cases.map((c) => {
    const started = performance.now();
    const plan = routeQuestion(c.question);
    const routeMs = performance.now() - started;
    const intentOk = c.expectedIntents.includes(plan.intent);
    const pathOk = plan.path === c.expectedPath;
    return {
      question: c.question,
      passed: intentOk && pathOk,
      intent: plan.intent,
      path: plan.path,
      reason: plan.reason,
      routeMs,
    };
  });

  const sortedTimes = results.map((r) => r.routeMs).sort((a, b) => a - b);
  const median =
    sortedTimes.length === 0
      ? 0
      : (sortedTimes[Math.floor(sortedTimes.length / 2)] ?? sortedTimes[0] ?? 0);
  const passed = results.filter((r) => r.passed).length;
  const pathPassed = results.filter((r, i) => r.path === cases[i].expectedPath).length;

  return {
    total: results.length,
    passed,
    accuracy: results.length ? passed / results.length : 0,
    pathAccuracy: results.length ? pathPassed / results.length : 0,
    medianRouteMs: Number(median.toFixed(3)),
    maxRouteMs: Number(Math.max(0, ...sortedTimes).toFixed(3)),
    failures: results.filter((r) => !r.passed),
    results,
  };
}

/**
 * Run the whole agent against the dataset — OPT-IN only.
 *
 * Kept for a human measuring end-to-end accuracy on a machine with a key. It is
 * never called by the test suite: it costs one or more real model requests per
 * case, which on the free tier is the day's entire budget.
 */
export async function runLiveEvaluation(
  runAgent: (input: { phone: string; text: string }) => Promise<{ reply: string }>,
  cases: EvalCase[] = EVAL_CASES,
): Promise<Array<{ question: string; latencyMs: number; reply: string; ok: boolean }>> {
  const out: Array<{ question: string; latencyMs: number; reply: string; ok: boolean }> = [];
  for (const c of cases) {
    const started = Date.now();
    try {
      const res = await runAgent({ phone: "0", text: c.question });
      const latencyMs = Date.now() - started;
      const ok = c.maxLatencyMs == null || latencyMs <= c.maxLatencyMs;
      out.push({ question: c.question, latencyMs, reply: res.reply, ok });
    } catch (err) {
      out.push({
        question: c.question,
        latencyMs: Date.now() - started,
        reply: `<error: ${err instanceof Error ? err.message : String(err)}>`,
        ok: false,
      });
    }
  }
  return out;
}
