import { describe, it, expect, vi, beforeEach } from "vitest";

// ── drizzle-orm sentinels ───────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: (left: any, right: any) => ({ __op: "eq", left, right }),
  and: (...args: any[]) => ({ __op: "and", args }),
  inArray: (left: any, right: any) => ({ __op: "inArray", left, right }),
  sql: Object.assign((strings: any, ...values: any[]) => ({ __op: "sql", strings, values }), {
    raw: (s: string) => ({ __op: "sql.raw", s }),
  }),
}));

function chainable(value: any, methods: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
}
function chain(value: any, extra: Record<string, any> = {}): any {
  const self = () =>
    chainable(value, {
      where: vi.fn(self),
      limit: vi.fn(self),
      orderBy: vi.fn(self),
      ...extra,
    });
  return self();
}

const itemClassificationIdentityTable = {
  _: "itemClassificationIdentity",
  identityKey: "identityKey",
  categoryId: "categoryId",
  source: "source",
  timesSeen: "timesSeen",
};

// The in-memory store the mock reads/writes, keyed by identity_key.
let store: Map<string, any>;
/** Records each upsert's `setWhere` so a test can assert the manual guard. */
const upserts: Array<{ key: string; source: string; setWhere: any; set: any }> = [];

const dbMock: any = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn((cond: any) => {
        if (cond?.__op === "inArray") {
          const wanted: string[] = cond.right ?? [];
          const rows = wanted.map((k) => store.get(k)).filter(Boolean);
          return chain(rows);
        }
        const row = store.get(cond?.right);
        return chain(row ? [row] : []);
      }),
    })),
  })),
  insert: vi.fn((table: any) => ({
    values: vi.fn((vals: any) => ({
      onConflictDoUpdate: vi.fn((cfg: any) => {
        const existing = store.get(vals.identityKey);
        const setWhere = cfg.setWhere ?? null;
        // Model the real semantics: the UPDATE applies only when the guard is
        // satisfied (undefined = always; eq(source,'auto') = only if the stored
        // row is still automatic).
        const guardOk =
          setWhere == null || (setWhere.__op === "eq" && existing?.source === setWhere.right);
        if (!existing) {
          store.set(vals.identityKey, { ...vals, timesSeen: 1 });
        } else if (guardOk) {
          store.set(vals.identityKey, {
            ...existing,
            ...cfg.set,
            timesSeen: (existing.timesSeen ?? 1) + 1,
          });
        }
        upserts.push({ key: vals.identityKey, source: vals.source, setWhere, set: cfg.set });
        return chainable(undefined);
      }),
    })),
  })),
};

vi.mock("@workspace/db", () => ({
  db: dbMock,
  itemClassificationIdentityTable,
}));

let rememberClassification: typeof import("../../modules/rfq/classification-memory").rememberClassification;
let lookupClassification: typeof import("../../modules/rfq/classification-memory").lookupClassification;
let loadClassificationMap: typeof import("../../modules/rfq/classification-memory").loadClassificationMap;

beforeEach(async () => {
  vi.clearAllMocks();
  store = new Map();
  upserts.length = 0;
  const mod = await import("../../modules/rfq/classification-memory");
  rememberClassification = mod.rememberClassification;
  lookupClassification = mod.lookupClassification;
  loadClassificationMap = mod.loadClassificationMap;
});

describe("classification memory", () => {
  it("creates a row keyed on the identity", async () => {
    const key = await rememberClassification({
      partNo: "680632",
      categoryId: 3,
      source: "auto",
      confidence: 90,
    });
    expect(key).toBe("pn:680632");
    expect(store.get("pn:680632")?.categoryId).toBe(3);
  });

  it("returns null (no write) for an item with no usable identity", async () => {
    const key = await rememberClassification({
      description: "CABLE",
      categoryId: 3,
      source: "auto",
    });
    expect(key).toBeNull();
    expect(store.size).toBe(0);
  });

  it("an automatic decision does NOT overwrite a manual one", async () => {
    await rememberClassification({
      partNo: "P0001",
      categoryId: 3,
      source: "manual",
      confidence: 100,
    });
    await rememberClassification({
      partNo: "P0001",
      categoryId: 2,
      source: "auto",
      confidence: 90,
    });
    expect(store.get("pn:p0001")?.categoryId).toBe(3); // still the manager's choice
    expect(store.get("pn:p0001")?.source).toBe("manual");
  });

  it("a manual decision DOES overwrite an automatic one", async () => {
    await rememberClassification({
      partNo: "P0002",
      categoryId: 2,
      source: "auto",
      confidence: 90,
    });
    await rememberClassification({
      partNo: "P0002",
      categoryId: 3,
      source: "manual",
      confidence: 100,
    });
    expect(store.get("pn:p0002")?.categoryId).toBe(3);
    expect(store.get("pn:p0002")?.source).toBe("manual");
  });

  it("an automatic decision updates an existing automatic row", async () => {
    await rememberClassification({
      partNo: "P0003",
      categoryId: 2,
      source: "auto",
      confidence: 80,
    });
    await rememberClassification({
      partNo: "P0003",
      categoryId: 3,
      source: "auto",
      confidence: 95,
    });
    expect(store.get("pn:p0003")?.categoryId).toBe(3);
  });

  it("looks up a remembered classification", async () => {
    await rememberClassification({
      partNo: "P0004",
      categoryId: 3,
      subcategoryIds: [10],
      source: "manual",
      confidence: 100,
    });
    const got = await lookupClassification("pn:p0004");
    expect(got?.categoryId).toBe(3);
    expect(got?.subcategoryIds).toEqual([10]);
    expect(got?.source).toBe("manual");
  });

  it("batch-loads several identities in one call", async () => {
    await rememberClassification({
      partNo: "A0001",
      categoryId: 3,
      source: "auto",
      confidence: 90,
    });
    await rememberClassification({
      partNo: "A0002",
      categoryId: 2,
      source: "auto",
      confidence: 90,
    });
    const map = await loadClassificationMap([
      { partNo: "A0001" },
      { partNo: "A0002" },
      { partNo: "A0003" },
    ]);
    expect(map.get("pn:a0001")?.categoryId).toBe(3);
    expect(map.get("pn:a0002")?.categoryId).toBe(2);
    expect(map.has("pn:a0003")).toBe(false);
  });
});
