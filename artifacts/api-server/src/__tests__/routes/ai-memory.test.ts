/**
 * Long-term memory: the pieces the rest of the assistant depends on.
 *
 * The behaviour that matters is that memory CONSOLIDATES (same key updates),
 * that recall is RELEVANT (a grounding query returns the matching fact and not
 * the rest), that retrieval NEVER invents a fact when nothing matches, and that
 * the assistant LEARNS from an explicit instruction without spending a model
 * call — the quota-free path that keeps "learning" from being the thing that
 * makes the assistant go silent.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/test";

// ── In-memory store the mocked drizzle layer reads and writes ────────────────
interface Row {
  id: number;
  phone: string;
  category: string;
  key: string;
  value: string;
  importance: number;
  source: string;
  pinned: boolean;
  validUntil: Date | null;
  useCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
let rows: Row[] = [];
let nextId = 1;

const table = { _: "aiMemories" };

function insertValues(v: Partial<Row>): Row {
  const existing = rows.find(
    (r) => r.phone === (v.phone ?? "") && r.category === (v.category ?? "fact") && r.key === v.key,
  );
  if (existing) {
    // onConflictDoUpdate semantics: update in place, preserving pin via GREATEST/OR.
    existing.value = String(v.value);
    existing.importance = Math.max(existing.importance, Number(v.importance ?? 50));
    existing.pinned = existing.pinned || Boolean(v.pinned);
    existing.validUntil = null;
    existing.updatedAt = new Date();
    return existing;
  }
  const row: Row = {
    id: nextId++,
    phone: String(v.phone ?? ""),
    category: String(v.category ?? "fact"),
    key: String(v.key),
    value: String(v.value),
    importance: Number(v.importance ?? 50),
    source: String(v.source ?? "user"),
    pinned: Boolean(v.pinned),
    validUntil: null,
    useCount: 0,
    lastUsedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  rows.push(row);
  return row;
}

vi.mock("@workspace/db", () => ({
  aiAssistantMemoriesTable: table,
  db: {
    insert: () => ({
      values: (v: Partial<Row>) => {
        const row = insertValues(v);
        return { onConflictDoUpdate: () => ({ returning: async () => [row] }) };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: async () => rows.slice() }),
        }),
      }),
    }),
    update: () => ({
      set: (patch: Partial<Row>) => {
        const applied: Row[] = [];
        const target = {
          where: () => ({
            returning: async () => {
              // The where clause is opaque to the mock; apply to all for the
              // id-targeted patches the route uses, else to open rows.
              for (const r of rows) {
                if (r.validUntil === null || patch.validUntil) {
                  Object.assign(r, patch, { updatedAt: new Date() });
                  applied.push(r);
                }
              }
              return applied;
            },
          }),
        };
        return target;
      },
    }),
    delete: () => ({ where: () => ({ returning: async () => rows.splice(0, rows.length) }) }),
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ __eq: [col, val] }),
  and: (...parts: unknown[]) => ({ __and: parts }),
  or: (...parts: unknown[]) => ({ __or: parts }),
  isNull: (col: unknown) => ({ __isNull: col }),
  desc: (col: unknown) => ({ __desc: col }),
  sql: Object.assign((..._a: unknown[]) => ({ __sql: "..." }), {
    join: (...a: unknown[]) => ({ __sqlJoin: a }),
  }),
}));

vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  canonicalKey,
  tokenize,
  scoreMemory,
  normalizeCategory,
  rememberFact,
  recallMemories,
  renderMemoryBlock,
  distillMemories,
} = await import("../../modules/ai-assistant/memory");

beforeEach(() => {
  rows = [];
  nextId = 1;
  vi.clearAllMocks();
});

describe("canonicalKey", () => {
  it("folds case, punctuation and Arabic variants so the same fact is one slot", () => {
    expect(canonicalKey("Milk  Price")).toBe(canonicalKey("milk-price"));
    expect(canonicalKey("سعر السكّر")).toBe(canonicalKey("سعر السكر"));
  });

  it("never returns empty", () => {
    expect(canonicalKey("   ")).toBe("memory");
  });
});

describe("tokenize", () => {
  it("drops stopwords and single letters but keeps the meaningful terms", () => {
    const t = tokenize("ما هو سعر السلك في أمر الشراء");
    expect(t).toContain("سعر");
    expect(t).toContain("السلك");
    expect(t).not.toContain("في");
  });
});

describe("scoreMemory", () => {
  it("scores a matching memory above an unrelated one", () => {
    const query = tokenize("سعر السلك النحاس");
    const onTopic = scoreMemory(
      {
        key: "سعر السلك النحاس",
        value: "السلك النحاس 50 جنيه",
        importance: 50,
        updatedAt: new Date(),
        useCount: 0,
      },
      query,
    );
    const offTopic = scoreMemory(
      {
        key: "اسم المورد المفضل",
        value: "شركة النور",
        importance: 90,
        updatedAt: new Date(),
        useCount: 0,
      },
      query,
    );
    expect(onTopic).toBeGreaterThan(offTopic);
    expect(offTopic).toBe(0);
  });
});

describe("normalizeCategory", () => {
  it("accepts the known families and defaults anything else to fact", () => {
    expect(normalizeCategory("lesson")).toBe("lesson");
    expect(normalizeCategory("banana")).toBe("fact");
    expect(normalizeCategory(undefined)).toBe("fact");
  });
});

describe("rememberFact consolidation", () => {
  it("UPDATES an existing key instead of piling up duplicates", async () => {
    await rememberFact({ phone: "2010", key: "مورد السلك", value: "النور" });
    await rememberFact({ phone: "2010", key: "مورد السلك", value: "الفجر" });
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("الفجر");
  });

  it("keeps the same key for different scopes as separate memories", async () => {
    await rememberFact({ phone: "2010", key: "مورد السلك", value: "النور" });
    await rememberFact({ phone: "", key: "مورد السلك", value: "الفجر" });
    expect(rows).toHaveLength(2);
  });

  it("never un-pins a pinned fact when it is mentioned again", async () => {
    const first = await rememberFact({ phone: "2010", key: "قاعدة", value: "أ", pinned: true });
    expect(first.pinned).toBe(true);
    await rememberFact({ phone: "2010", key: "قاعدة", value: "ب", pinned: false });
    expect(rows[0].pinned).toBe(true);
  });

  it("refuses an empty value", async () => {
    await expect(rememberFact({ phone: "2010", key: "k", value: "   " })).rejects.toThrow();
  });
});

describe("recallMemories", () => {
  it("returns the fact matching the query and not the unrelated ones", async () => {
    await rememberFact({ phone: "2010", key: "مورد السلك", value: "شركة النور" });
    await rememberFact({ phone: "2010", key: "عنوان المخزن", value: "العاشر من رمضان" });
    const found = await recallMemories({ phone: "2010", query: "مين مورد السلك؟" });
    expect(found.map((m) => m.key)).toContain("مورد السلك");
    expect(found.map((m) => m.key)).not.toContain("عنوان المخزن");
  });

  it("returns pinned memories regardless of the query", async () => {
    await rememberFact({
      phone: "2010",
      key: "قاعدة عامة",
      value: "لا تقل غير موجود قبل الفحص",
      pinned: true,
    });
    await rememberFact({ phone: "2010", key: "شيء آخر", value: "تفصيلة" });
    const found = await recallMemories({ phone: "2010", query: "سؤال لا علاقة له" });
    expect(found.map((m) => m.key)).toContain(canonicalKey("قاعدة عامة"));
  });

  it("does NOT fabricate a memory when nothing matches", async () => {
    await rememberFact({ phone: "2010", key: "عنوان المخزن", value: "العاشر من رمضان" });
    const found = await recallMemories({ phone: "2010", query: "سعر الحديد" });
    expect(found).toHaveLength(0);
  });

  it("sees shared (company-wide) memories alongside the phone's own", async () => {
    await rememberFact({ phone: "", key: "سياسة الشركة", value: "الخصم 3%" });
    const found = await recallMemories({ phone: "2010", query: "سياسة الشركة" });
    expect(found.map((m) => m.key)).toContain(canonicalKey("سياسة الشركة"));
  });
});

describe("renderMemoryBlock", () => {
  it("is empty when there is nothing to inject", () => {
    expect(renderMemoryBlock([])).toBe("");
  });

  it("labels each fact by category and warns to prefer live tool data", () => {
    const block = renderMemoryBlock([
      {
        id: 1,
        phone: "",
        category: "rule",
        key: "قاعدة",
        value: "القيمة",
        importance: 80,
        source: "admin",
        pinned: true,
        validFrom: null,
        validUntil: null,
        useCount: 0,
        lastUsedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    expect(block).toContain("قاعدة");
    expect(block).toContain("القيمة");
    expect(block).toContain("الأداة هي المصدر الأصح");
  });
});

describe("distillMemories (quota-free learning)", () => {
  it("learns a fact the operator explicitly asked to remember", async () => {
    await distillMemories({
      phone: "2010",
      userText: "افتكر إن مورد السلك المفضل هو شركة النور",
      assistantText: "تمام",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe("rule");
    expect(rows[0].value).toContain("شركة النور");
    expect(rows[0].source).toBe("distilled");
  });

  it("records a LESSON when the operator corrects the assistant", async () => {
    await distillMemories({
      phone: "2010",
      userText: "الرقم اللي قلته غلط",
      assistantText: "الرصيد 100",
    });
    expect(rows.some((r) => r.category === "lesson")).toBe(true);
  });

  it("learns an explicit RULE directive that never says «افتكر»", async () => {
    // The operator's real wording — a standing instruction to apply to every
    // future task. Missing it means the rule he asked to be recorded is never
    // stored, so the assistant has nothing to recall on the next request.
    await distillMemories({
      phone: "2010",
      userText:
        "أريد منك تسجيل هذه القاعدة كـ قاعدة أساسية ثابتة في منطق تحليل أوامر الشراء، وتطبيقها في جميع المهام المستقبلية المشابهة.",
      assistantText: "تم الحفظ",
    });
    expect(rows.some((r) => r.category === "rule")).toBe(true);
  });

  it("stores nothing for an ordinary question (no false learning)", async () => {
    await distillMemories({
      phone: "2010",
      userText: "كام أمر شراء الشهر ده؟",
      assistantText: "12",
    });
    expect(rows).toHaveLength(0);
  });
});
