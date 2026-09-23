/**
 * Source routing and scope (the live «من الميل مش قاعدة البيانات» failure).
 *
 * The operator asked for the mail, the assistant answered from the internal
 * purchase-order table (39 POs), and called it a complete census. These tests pin
 * the three mechanisms that make that impossible to repeat:
 *  1. the router recognises the mailbox as a REQUIRED source;
 *  2. a document is classified PO vs RFQ, and only POs are counted;
 *  3. the numeric verifier refuses to reconcile an email figure against the DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let poItemTotal = 0;
vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ total: poItemTotal }]),
      }),
    }),
  },
  purchaseOrderItemsTable: { _: "po_items" },
  customerPoItemsTable: { _: "customer_items" },
}));
vi.mock("drizzle-orm", () => ({
  sql: Object.assign((..._a: unknown[]) => ({ sql: true }), { join: () => ({}) }),
  ne: (...a: unknown[]) => ({ ne: a }),
}));

const { routeQuestion } = await import("../../modules/ai-assistant/router");
const { documentKind, documentNumber } = await import("../../modules/ai-assistant/email-items");
const { verifyAnswer } = await import("../../modules/ai-assistant/verifier");

beforeEach(() => {
  poItemTotal = 0;
  vi.clearAllMocks();
});

describe("routeQuestion — source scope", () => {
  it("marks the mailbox as the required source when the operator names it", () => {
    // The exact live phrasing: «بقولك من الميل مش قاعده البيانات».
    const plan = routeQuestion("بقولك من الميل مش قاعده البيانات، ادخل وافحص كل أوامر الشراء");
    expect(plan.sourceScope).toBe("email");
  });

  it("marks the scope from a plain «من البريد» directive", () => {
    expect(routeQuestion("هات أوامر الشراء من البريد").sourceScope).toBe("email");
  });

  it("marks the scope from an explicit database exclusion", () => {
    expect(routeQuestion("عايز الأرقام دي مش من قاعدة البيانات").sourceScope).toBe("email");
  });

  it("leaves the scope open for an ordinary database question", () => {
    const plan = routeQuestion("كام أمر شراء عندنا النهاردة؟");
    expect(plan.sourceScope).toBe("any");
  });

  it("carries the scope through every intent branch", () => {
    // A source constraint must survive whichever intent the question also
    // matches — otherwise a phrasing that routes to `analytics` would silently
    // lose it.
    for (const q of [
      "افحص البريد واعمل حصر كامل",
      "من الميل، كام أمر شراء متأخر؟",
      "من البريد، P26E14630 اتبعت لمين؟",
      "من البريد، قارن الموردين",
    ]) {
      expect(routeQuestion(q).sourceScope).toBe("email");
    }
  });
});

describe("documentKind — only POs count", () => {
  it("classifies an EDC purchase order as a PO", () => {
    expect(documentKind("PO number: P26E14630(RIG58)\nPURCHASE ORDER")).toBe("po");
  });

  it("classifies an EDC RFQ as an RFQ", () => {
    expect(documentKind("RFQ number: 26R011954\nREQUEST FOR QUOTATION")).toBe("rfq");
  });

  it("falls back to the number prefix when the title is missing", () => {
    // A scanned/OCR'd copy may lose the title; the code still identifies the type.
    expect(documentKind("PO number: P26E14630(RIG58)")).toBe("po");
    expect(documentKind("RFQ number: 26R011954")).toBe("rfq");
  });

  it("does not call a quotation a purchase order", () => {
    // The operator's rule: a quotation is NOT an order, however it is labelled.
    expect(documentKind("QUOTATION\nSupplier Quote Ref: 26R01098")).not.toBe("po");
  });

  it("returns unknown rather than guessing", () => {
    expect(documentKind("some unrelated document text")).toBe("unknown");
  });

  it("still reads the document number it classifies by", () => {
    // The captured code stops at the parenthesis (the `(RIG58)` suffix is a
    // location tag, not part of the number), which is what the doc-id and
    // occurrence counting key on.
    expect(documentNumber("PO number: P26E14630(RIG58)")).toBe("P26E14630");
  });
});

describe("verifyAnswer — a figure is only reconciled against its own source", () => {
  it("SKIPS the database reconciliation for an email-sourced figure", () => {
    // The live false alarm: an email census total (235,800) compared against the
    // database's PO items (14,265) and reported as PARTIALLY_VERIFIED — for a
    // reply that was entirely about the mail. The two sets legitimately differ.
    poItemTotal = 14_265;
    return verifyAnswer({ answerText: "إجمالي الكميات في الميل 235800", source: "email" }).then(
      (r) => {
        expect(r.outcome).toBe("skipped");
      },
    );
  });

  it("skips a mixed-source figure rather than guessing which side it is", () => {
    poItemTotal = 14_265;
    return verifyAnswer({ answerText: "إجمالي الكميات 235800", source: "mixed" }).then((r) => {
      expect(r.outcome).toBe("skipped");
    });
  });

  it("still reconciles a database-sourced figure", async () => {
    poItemTotal = 999;
    const r = await verifyAnswer({ answerText: "إجمالي الكميات 1,842 وحدة", source: "database" });
    expect(r.outcome).toBe("disagreement");
  });

  it("keeps the old behaviour when no source is given", async () => {
    // Existing callers that do not pass a source must not silently lose the check.
    poItemTotal = 1842;
    const r = await verifyAnswer({ answerText: "إجمالي الكميات 1,842 وحدة" });
    expect(r.outcome).toBe("verified");
  });
});
