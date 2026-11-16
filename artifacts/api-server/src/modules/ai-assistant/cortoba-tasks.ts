/**
 * The work Cortoba actually does, as ready-made plans.
 *
 * The agent can plan anything, but the operator's questions cluster around five
 * jobs: finding suppliers, analysing items, extracting supplier data, chasing
 * prices, and following up RFQs. Naming those explicitly means the plan for a
 * recurring job is the SAME every time — a supplier search always ends with a
 * comparison, an item analysis always ends with a recommendation — instead of
 * the model inventing a different shape per request, which is how the same
 * question got different answers on different days.
 *
 * Each template names the TOOLS it needs, so the permission layer can check the
 * whole job up front and tell the operator before any work starts when a
 * capability is disabled.
 */

import type { TaskPlan, PlanStep } from "./task-plan";

export type CortobaJob =
  | "supplier_search"
  | "item_analysis"
  | "supplier_data_extraction"
  | "price_research"
  | "rfq_followup";

interface Template {
  job: CortobaJob;
  label: string;
  steps: string[];
  tools: string[];
}

const TEMPLATES: Template[] = [
  {
    job: "supplier_search",
    label: "البحث عن موردين",
    steps: [
      "ابحث في الموردين المسجّلين عن المطابقين للبند/التصنيف المطلوب",
      "استخرج ما قدّمه كل مورد من عروض سابقة على نفس البند",
      "رتّبهم وأوصِ بالموردين المرشّحين مع سبب الترشيح",
    ],
    tools: ["search_database", "supplier_overview", "get_latest_supplier_price"],
  },
  {
    job: "item_analysis",
    label: "تحليل الأصناف",
    steps: [
      "اجمع بنود الصنف المطلوب من طلبات التسعير وأوامر الشراء",
      "وحّد المسمّيات واحسب الكميات والأسعار",
      "استخرج الفروق وأوصِ بالقرار",
    ],
    tools: ["aggregate_customer_po_items", "get_latest_supplier_price", "search_database"],
  },
  {
    job: "supplier_data_extraction",
    label: "استخراج بيانات موردين",
    steps: [
      "اقرأ الرسائل والمرفقات الواردة من المورد",
      "استخرج بيانات البنود والكميات والأسعار",
      "أعدّ النتيجة للتسجيل واذكر ما لم يُقرأ",
    ],
    tools: ["search_emails", "read_email", "get_email_attachment"],
  },
  {
    job: "price_research",
    label: "البحث عن الأسعار",
    steps: [
      "اجمع أسعار البند من العروض وأوامر الشراء",
      "قارنها واحسب الفروق بين الموردين",
      "اذكر أرخص/أغلى سعر ومصدر كل رقم",
    ],
    tools: ["get_latest_supplier_price", "compare_supplier_quotes", "search_database"],
  },
  {
    job: "rfq_followup",
    label: "متابعة طلبات التسعير",
    steps: [
      "حدّد الطلبات المفتوحة وغير المسعّرة",
      "حدّد البنود التي لم يصدر لها أمر شراء بعد",
      "أعدّ قائمة المتابعة مع الموظف المسؤول عن كل طلب",
    ],
    tools: ["get_unfulfilled_orders", "get_purchase_order_status", "search_database"],
  },
];

export function cortobaTemplates(): Template[] {
  return TEMPLATES;
}

export function findTemplate(job: CortobaJob): Template | undefined {
  return TEMPLATES.find((t) => t.job === job);
}

/** The plan for a named job — the same shape every time it is asked for. */
export function planForJob(job: CortobaJob, goal: string): TaskPlan {
  const t = findTemplate(job);
  const steps: PlanStep[] = (t?.steps ?? ["اجمع البيانات المطلوبة"]).map((text, i) => ({
    index: i + 1,
    text,
    status: "pending" as const,
  }));
  return { goal, steps };
}

/** Which tools a job needs, so the permission layer can vet it before starting. */
export function toolsForJob(job: CortobaJob): string[] {
  return findTemplate(job)?.tools ?? [];
}

/**
 * Match a question to a job. Deliberately narrow: a wrong template makes the
 * agent follow the wrong steps confidently, which is worse than no template.
 */
export function detectJob(question: string): CortobaJob | null {
  const q = String(question ?? "");
  if (/موردين|موردين جدد|ابحث عن مورد|ترشح مورد|مرشحين/i.test(q) && !/سعر|أسعار|اسعار/i.test(q))
    return "supplier_search";
  if (/سعر|أسعار|اسعار|أرخص|ارخص|أغلى|اغلى|قارن.*سعر/i.test(q)) return "price_research";
  if (/بيانات المورد|استخرج.*بيانات|بيانات بنكية|كشف.*مورد/i.test(q))
    return "supplier_data_extraction";
  if (/متابعة|لم يصدر|بدون أمر شراء|طلبات مفتوحة|على الموردين/i.test(q)) return "rfq_followup";
  if (/حلل|تحليل|الأصناف|البنود.*الأكثر|أكثر بند/i.test(q)) return "item_analysis";
  return null;
}
