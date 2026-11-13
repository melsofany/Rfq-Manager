import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Ownership model for the Chatwoot console.
 *
 * The requirement this guards: one supplier routinely has SEVERAL pricing
 * requests open at once, and a reply must be filed under the request it answers
 * — and therefore under the employee responsible for that request — not merely
 * under the supplier's phone number.
 *
 * Two failure modes matter more than the happy path:
 *   - a reply GUESSED onto the wrong request (silently misfiles a price), and
 *   - a supplier's thread leaking into another supplier's request.
 */

// Pure functions need no database; the module is imported for them alone.
vi.mock("@workspace/db", () => ({
  db: {},
  chatwootLinksTable: { phone: "phone", rfqId: "rfq_id", conversationId: "conversation_id" },
  suppliersTable: { id: "id", name: "name", phone: "phone" },
  sentLogTable: { rfqId: "rfq_id", supplierId: "supplier_id", employeeId: "employee_id" },
  rfqTable: { id: "id", internalRfqNo: "internal_rfq_no", status: "status" },
  employeesTable: { id: "id", name: "name", email: "email" },
}));
// Every export the bridge imports must exist here, or vitest throws
// "No <name> export is defined on the mock" and the whole suite fails to load.
vi.mock("../../modules/chatwoot/client", () => ({
  isChatwootConfigured: false,
  findContactByPhone: vi.fn(),
  createContact: vi.fn(),
  createConversation: vi.fn(),
  createMessage: vi.fn(),
  getConversationContactPhone: vi.fn(),
  findAgentByEmail: vi.fn(),
  createAgent: vi.fn(),
  assignConversation: vi.fn(),
  setConversationCustomAttributes: vi.fn(),
}));

const { canonicalPhone, pickRequestFromText } = await import("../../modules/chatwoot/bridge");

const openRequests = [
  { rfqId: 11, internalRfqNo: "RFQ-2026-000111", employeeId: 3, employeeName: "أحمد" },
  { rfqId: 22, internalRfqNo: "RFQ-2026-000222", employeeId: 4, employeeName: "منى" },
  { rfqId: 33, internalRfqNo: "RFQ-2026-000333", employeeId: null, employeeName: null },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("canonicalPhone", () => {
  it("folds the formats one number is stored in to a single form", () => {
    expect(canonicalPhone("+20 100 000 0000")).toBe("201000000000");
    expect(canonicalPhone("00201000000000")).toBe("201000000000");
    expect(canonicalPhone("201000000000")).toBe("201000000000");
    expect(canonicalPhone("01000000000")).toBe("201000000000");
    // A Cairo LANDLINE: 10 digits, trunk 0, area 2. It has no mobile-length
    // special case, so it stayed local and Chatwoot refused it — the last
    // failure of the live replay.
    expect(canonicalPhone("0227538195")).toBe("20227538195");
    expect(canonicalPhone("1000000000")).toBe("201000000000");
  });

  it("strips bidi marks and non-digits", () => {
    expect(canonicalPhone("‪+201000000000‬")).toBe("201000000000");
  });
});

describe("pickRequestFromText — which request does this reply answer?", () => {
  it("treats an explicit request number as authoritative", () => {
    const result = pickRequestFromText("بخصوص RFQ-2026-000333 السعر 120", openRequests);
    expect(result).toEqual({ rfqId: 33, ambiguous: false });
  });

  it("matches the number regardless of spacing", () => {
    const result = pickRequestFromText("RFQ 2026 000222", openRequests);
    expect(result).toEqual({ rfqId: 22, ambiguous: false });
  });

  it("uses the single open request when the supplier has exactly one", () => {
    const one = [openRequests[0]];
    expect(pickRequestFromText("السعر 100", one)).toEqual({ rfqId: 11, ambiguous: false });
  });

  it("refuses to guess when several requests are open and none is named", () => {
    // The important case: guessing here files a price under the wrong request.
    expect(pickRequestFromText("السعر 100", openRequests)).toEqual({
      rfqId: null,
      ambiguous: true,
    });
  });

  it("does not match a request that is not open", () => {
    // RFQ-2026-000999 was never offered, so it cannot be selected.
    expect(pickRequestFromText("RFQ-2026-000999", openRequests)).toEqual({
      rfqId: null,
      ambiguous: true,
    });
  });
});
