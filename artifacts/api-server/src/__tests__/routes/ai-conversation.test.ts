/**
 * Conversation state (P4).
 *
 * A follow-up question like «وطب آخر سعر له؟» must resolve "له" to the part the
 * conversation was already about. These tests pin the two rules that make that
 * work — a null patch field never clears a remembered entity, and only EXPLICITLY
 * named entities are recorded (a wrong "last part" silently poisons the next
 * question, which is worse than not remembering it).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const stateT = { _: "ai_state", id: "id", phone: "phone" };

/** In-memory stand-in for the single state row, per phone. */
let store: Record<string, any> = {};
let insertCalls: any[] = [];
let updateCalls: any[] = [];

vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (w: any) => ({
          limit: () => {
            const phone = w?.__eq?.[1];
            return Promise.resolve(store[phone] ? [store[phone]] : []);
          },
        }),
      }),
    }),
    insert: () => ({
      values: (v: any) => {
        insertCalls.push(v);
        store[v.phone] = { id: 1, ...v };
        return Promise.resolve([store[v.phone]]);
      },
    }),
    update: () => ({
      set: (v: any) => ({
        where: (w: any) => {
          const phone = w?.__eq?.[1];
          updateCalls.push({ phone, v });
          store[phone] = { ...store[phone], ...v };
          return Promise.resolve([store[phone]]);
        },
      }),
    }),
    delete: () => ({ where: (w: any) => (delete store[w?.__eq?.[1]], Promise.resolve([])) }),
  },
  aiAssistantStateTable: stateT,
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: any, val: any) => ({ __eq: [col, val] }),
}));

vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  loadConversationState,
  saveConversationState,
  clearConversationState,
  renderConversationState,
  inferStatePatch,
} = await import("../../modules/ai-assistant/conversation");

describe("conversation state", () => {
  beforeEach(() => {
    store = {};
    insertCalls = [];
    updateCalls = [];
  });

  it("returns an empty state when nothing has been recorded", async () => {
    const s = await loadConversationState("2010");
    expect(s.lastPartNo).toBeNull();
    expect(s.lastDocumentNumber).toBeNull();
  });

  it("remembers only the fields it was given, and never clears others", async () => {
    await saveConversationState("2010", { lastPartNo: "0600.000.GENRAL.0005" });
    await saveConversationState("2010", { lastSupplier: "شركة الأمل" });
    const s = await loadConversationState("2010");
    // The second write named only a supplier; the part must survive it, or the
    // very follow-up this feature exists for would break.
    expect(s.lastPartNo).toBe("0600.000.GENRAL.0005");
    expect(s.lastSupplier).toBe("شركة الأمل");
  });

  it("ignores an empty patch instead of writing a blank row", async () => {
    await saveConversationState("2010", { lastSupplier: "" });
    expect(insertCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
  });

  it("renders only the fields that are actually known", () => {
    const block = renderConversationState({
      lastDocumentType: "أمر شراء",
      lastDocumentNumber: "P26E11407",
      lastSupplier: null,
      lastCustomer: null,
      lastPartNo: "0600.000.GENRAL.0005",
      lastPeriod: null,
      lastJobId: null,
    });
    expect(block).toContain("P26E11407");
    expect(block).toContain("0600.000.GENRAL.0005");
    expect(block).not.toContain("آخر مورد");
    expect(block).not.toContain("آخر عميل");
  });

  it("renders nothing at all when nothing is known", () => {
    const block = renderConversationState({
      lastDocumentType: null,
      lastDocumentNumber: null,
      lastSupplier: null,
      lastCustomer: null,
      lastPartNo: null,
      lastPeriod: null,
      lastJobId: null,
    });
    expect(block).toBe("");
  });

  it("clears the state on request (used by /reset)", async () => {
    await saveConversationState("2010", { lastSupplier: "شركة الأمل" });
    await clearConversationState("2010");
    const s = await loadConversationState("2010");
    expect(s.lastSupplier).toBeNull();
  });

  describe("entity extraction (conservative on purpose)", () => {
    it("records an alphanumeric document number the operator typed", () => {
      const p = inferStatePatch({ userText: "أمر الشراء P26E11407 تبع مين؟" });
      expect(p.lastDocumentNumber).toBe("P26E11407");
    });

    it("records a year as the active period", () => {
      const p = inferStatePatch({ userText: "اعمل حصر لكل PO في البريد خلال 2026" });
      expect(p.lastPeriod).toBe("2026");
    });

    it("records nothing for a question that names no entity", () => {
      // The whole point: an inference here would silently poison the NEXT
      // question, so an entity-less question must leave the state untouched.
      const p = inferStatePatch({ userText: "وطب آخر سعر له؟" });
      expect(p.lastDocumentNumber ?? p.lastSupplier ?? p.lastPartNo ?? p.lastPeriod).toBeFalsy();
    });
  });
});
