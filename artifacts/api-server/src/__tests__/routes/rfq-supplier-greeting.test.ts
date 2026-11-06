import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * الترحيب بالمورد — the RFQ-send trigger.
 *
 * The behaviour under test is the DECISION (welcome now or not) and the fact
 * that the guide reaches both channels. The send functions and the guide loader
 * are mocked so the test measures the route's decision, not Meta's API.
 */

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

const sendRfqEmailMock = vi.fn().mockResolvedValue(undefined);
const sendGreetingEmailMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../shared/email", () => ({
  verifyEmailConnection: vi.fn().mockResolvedValue({ ok: true }),
  sendRfqEmail: (...a: any[]) => sendRfqEmailMock(...a),
  sendSupplierGreetingEmail: (...a: any[]) => sendGreetingEmailMock(...a),
  sendOfferConfirmation: vi.fn().mockResolvedValue({ ok: true }),
  sendPoEmail: vi.fn().mockResolvedValue(undefined),
}));

const sendRfqWhatsAppMock = vi.fn().mockResolvedValue({
  pdfSent: true,
  usedTemplate: true,
  waMessageId: "wa-1",
});
const sendGreetingWhatsAppMock = vi.fn().mockResolvedValue("wa-greet");
vi.mock("../../modules/communications/service", () => ({
  sendRfqWhatsApp: (...a: any[]) => sendRfqWhatsAppMock(...a),
  sendSupplierGreetingWhatsApp: (...a: any[]) => sendGreetingWhatsAppMock(...a),
  get isWhatsAppConfigured() {
    return true;
  },
  sendPoWhatsApp: vi.fn(),
  formatQty: (q: any) => (q == null ? null : String(q)),
}));

// A real-looking guide buffer, so "attached" is provable.
const GUIDE_BYTES = Buffer.from("%PDF-1.4 guide");
vi.mock("../../shared/supplier-guide", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/supplier-guide")>();
  return {
    ...actual,
    loadSupplierGuide: () => GUIDE_BYTES,
  };
});

vi.mock("../../shared/google-sheets", () => ({
  lookupRfqFromSheet: vi.fn().mockResolvedValue(null),
  listSheetRfqNumbers: vi.fn().mockResolvedValue([]),
  listSheetTabs: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../modules/rfq/assignment", () => ({
  ensureAssignmentsForRfqSafe: vi.fn().mockResolvedValue(undefined),
}));

// ── Chainable + thenable DB mock ───────────────────────────────────────────
function chainable(rows: any): any {
  const api: any = {
    from: vi.fn(() => api),
    leftJoin: vi.fn(() => api),
    innerJoin: vi.fn(() => api),
    where: vi.fn(() => chainable(rows)),
    limit: vi.fn(() => chainable(rows)),
    orderBy: vi.fn(() => chainable(rows)),
    returning: vi.fn(() => chainable(rows)),
    then: (resolve: any) => Promise.resolve(rows).then(resolve),
  };
  return api;
}

/** Results for successive `db.select(...)` calls. */
let selectQueue: any[] = [];
/** Every `db.update(...).set(vals)` recorded, for the contact-stamp assertions. */
const updateSets: any[] = [];
const insertCalls: any[] = [];
const auditRows: any[] = [];

const tables = {
  rfqTable: { _: "rfq" },
  rfqItemsTable: { _: "rfqItems" },
  sentLogTable: { _: "sentLog" },
  suppliersTable: { _: "suppliers" },
  employeesTable: { _: "employees" },
  offersTable: { _: "offers" },
  offerItemsTable: { _: "offerItems" },
  offerAttachmentsTable: { _: "offerAttachments" },
  auditLogTable: { _: "audit" },
  customerRfqsTable: { _: "customerRfqs" },
  customerRfqItemsTable: { _: "customerRfqItems" },
  whatsappChatsTable: { _: "waChats" },
};

const dbMock: any = {
  select: vi.fn(() => chainable(selectQueue.shift() ?? [])),
  update: vi.fn(() => ({
    set: vi.fn((vals: any) => {
      updateSets.push(vals);
      return { where: vi.fn(() => chainable(undefined)) };
    }),
  })),
  insert: vi.fn((table?: any) => ({
    values: vi.fn((vals: any) => {
      insertCalls.push({ table: table?._, vals });
      if (table?._ === "audit") auditRows.push(vals);
      return { returning: vi.fn(() => chainable([{ id: 1 }])) };
    }),
  })),
  delete: vi.fn(() => ({ where: vi.fn(() => chainable(undefined)) })),
  transaction: vi.fn(async (cb: any) => cb(dbMock)),
};

vi.mock("@workspace/db", () => ({ ...tables, db: dbMock }));

vi.mock("../../shared/permissions", () => ({
  guardFor: () => (_req: any, _res: any, next: any) => next(),
}));

let testApp: express.Express;

beforeAll(async () => {
  const { default: rfqRouter } = await import("../../modules/rfq/index");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = { employeeId: 1, role: "admin" };
    // `req.protocol` is a getter-only property on IncomingMessage — assigning
    // it throws. `resolvePublicBaseUrl` falls back to BASE_URL, so set that.
    process.env.BASE_URL = "https://cortoba-rfq.onrender.com";
    next();
  });
  testApp.use("/api", rfqRouter);
});

afterAll(() => {
  // The base URL is process-wide; leaving it set would leak into other suites.
  delete process.env.BASE_URL;
});

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue = [];
  updateSets.length = 0;
  insertCalls.length = 0;
  auditRows.length = 0;
});

const RFQ = {
  id: 5,
  internalRfqNo: "CRQ-2026-000005",
  status: "DRAFT",
  expiresAt: null,
  closeDate: null,
};

function supplierRow(over: Record<string, any> = {}) {
  return {
    id: 7,
    name: "شركة النور للتوريدات",
    contactPerson: "أحمد محمد",
    phone: "201000000000",
    email: "nour@example.com",
    commercialRegister: "123456",
    taxRegistration: "432972587",
    bankName: "البنك التجاري الدولي",
    bankAccountHolder: "شركة النور للتوريدات",
    bankAccountNumber: "1234567890",
    iban: null,
    swiftCode: "CIBEGCXX",
    bankBranch: "مرسي مطروح",
    greetedPhone: null,
    greetedEmail: null,
    greetedAt: null,
    ...over,
  };
}

/** Queue: [rfq], [items], [suppliers], [employee], [sentLog] then the write path. */
function queueSend(supplier: any, existingSentLog: any = null) {
  selectQueue = [
    [RFQ], // rfq lookup
    [{ id: 1, lineItem: "1", partNo: "P1", description: "Widget", qty: "2", uom: "pcs" }], // items
    [supplier], // suppliers
    [{ id: 1, name: "Sara", phone: "201222222222" }], // employee
    existingSentLog ? [existingSentLog] : [], // sent-log duplicate check
  ];
}

const body = { supplierIds: [7], force: true };

describe("POST /api/rfq/:id/send — الترحيب بالمورد", () => {
  it("welcomes a supplier we have never addressed, on both channels, with the guide", async () => {
    queueSend(supplierRow());
    const res = await request(testApp).post("/api/rfq/5/send").send(body);

    expect(res.status).toBe(200);
    const detail = res.body.details[0];
    expect(detail.greeting).toMatchObject({
      sent: true,
      tier: "registered",
      reason: "new_supplier",
      whatsapp: "sent",
      email: "sent",
    });

    // The guide really travels: the WhatsApp document header is built from the
    // loaded bytes and the email carries them as an attachment.
    expect(sendGreetingWhatsAppMock).toHaveBeenCalledTimes(1);
    expect(sendGreetingWhatsAppMock.mock.calls[0][0]).toMatchObject({
      tier: "registered",
      guideAttached: true,
      name: "أحمد محمد",
    });
    expect(sendGreetingEmailMock).toHaveBeenCalledTimes(1);
    expect(sendGreetingEmailMock.mock.calls[0][0]).toMatchObject({
      tier: "registered",
      tierLabel: "مورد مسجَّل",
      guideUrl: "https://cortoba-rfq.onrender.com/supplier-pricing-guide.pdf",
    });
    expect(Buffer.isBuffer(sendGreetingEmailMock.mock.calls[0][0].guide)).toBe(true);

    // The RFQ itself still goes out — the greeting must not replace it.
    expect(sendRfqEmailMock).toHaveBeenCalledTimes(1);
    expect(sendRfqWhatsAppMock).toHaveBeenCalledTimes(1);
  });

  it("stamps the contact we used, so the next send does not welcome again", async () => {
    queueSend(supplierRow());
    await request(testApp).post("/api/rfq/5/send").send(body);

    const stamp = updateSets.find((s) => "greetedAt" in s);
    expect(stamp).toBeTruthy();
    expect(stamp.greetedPhone).toBe("201000000000");
    expect(stamp.greetedEmail).toBe("nour@example.com");
  });

  it("does NOT welcome again when neither phone nor email changed", async () => {
    queueSend(
      supplierRow({
        greetedPhone: "201000000000",
        greetedEmail: "nour@example.com",
        greetedAt: new Date("2026-01-01"),
      }),
    );
    const res = await request(testApp).post("/api/rfq/5/send").send(body);

    expect(res.body.details[0].greeting).toBeNull();
    expect(sendGreetingWhatsAppMock).not.toHaveBeenCalled();
    expect(sendGreetingEmailMock).not.toHaveBeenCalled();
    expect(updateSets.some((s) => "greetedAt" in s)).toBe(false);
  });

  it("welcomes again after a phone change, naming the reason", async () => {
    queueSend(
      supplierRow({
        phone: "201111111111",
        greetedPhone: "201000000000",
        greetedEmail: "nour@example.com",
        greetedAt: new Date("2026-01-01"),
      }),
    );
    const res = await request(testApp).post("/api/rfq/5/send").send(body);

    expect(res.body.details[0].greeting).toMatchObject({
      sent: true,
      reason: "phone_changed",
    });
    // Only the changed channel is re-stamped; the email is unchanged.
    const stamp = updateSets.find((s) => "greetedAt" in s);
    expect(stamp.greetedPhone).toBe("201111111111");
    expect("greetedEmail" in stamp).toBe(false);
  });

  it("welcomes again after an email change", async () => {
    queueSend(
      supplierRow({
        email: "new@example.com",
        greetedPhone: "201000000000",
        greetedEmail: "nour@example.com",
        greetedAt: new Date("2026-01-01"),
      }),
    );
    const res = await request(testApp).post("/api/rfq/5/send").send(body);
    expect(res.body.details[0].greeting).toMatchObject({ reason: "email_changed" });
  });

  it("treats a supplier with missing registration data as preliminary", async () => {
    queueSend(supplierRow({ bankAccountNumber: null, iban: null }));
    const res = await request(testApp).post("/api/rfq/5/send").send(body);

    expect(res.body.details[0].greeting.tier).toBe("preliminary");
    expect(sendGreetingWhatsAppMock.mock.calls[0][0].tier).toBe("preliminary");
    expect(sendGreetingEmailMock.mock.calls[0][0].tierLabel).toBe("مورد مبدئي");
  });

  it("records an audit row naming the reason and the tier", async () => {
    queueSend(supplierRow());
    await request(testApp).post("/api/rfq/5/send").send(body);

    const row = auditRows.find((r) => r.action === "supplier.greeted");
    expect(row).toBeTruthy();
    expect(row.description).toContain("أول تعامل مع المورد");
    expect(row.description).toContain("مورد مسجَّل");
  });

  it("does not stamp a channel whose greeting FAILED, so it retries next time", async () => {
    // A failed WhatsApp must leave greetedPhone unset, or the supplier is never
    // welcomed on the channel that never worked.
    sendGreetingWhatsAppMock.mockRejectedValueOnce(new Error("wa down"));
    queueSend(supplierRow());
    const res = await request(testApp).post("/api/rfq/5/send").send(body);

    const detail = res.body.details[0];
    expect(detail.greeting).toMatchObject({ sent: true, whatsapp: "failed", email: "sent" });
    expect(detail.greeting.error).toContain("wa down");
    const stamp = updateSets.find((s) => "greetedAt" in s);
    expect("greetedPhone" in stamp).toBe(false);
    expect(stamp.greetedEmail).toBe("nour@example.com");
  });

  it("never fails the RFQ send when the greeting throws on BOTH channels", async () => {
    sendGreetingWhatsAppMock.mockRejectedValueOnce(new Error("wa down"));
    sendGreetingEmailMock.mockRejectedValueOnce(new Error("smtp down"));
    queueSend(supplierRow());
    const res = await request(testApp).post("/api/rfq/5/send").send(body);

    // The supplier still counts as sent, and the failure is REPORTED rather than
    // swallowed — a "✓ أُرسل" that hides a failed greeting is the defect class
    // this repository keeps recording.
    expect(res.status).toBe(200);
    expect(res.body.details[0].status).toBe("sent");
    expect(res.body.details[0].greeting).toMatchObject({
      sent: false,
      whatsapp: "failed",
      email: "failed",
    });
    expect(updateSets.some((s) => "greetedAt" in s)).toBe(false);
  });

  it("does not greet a skipped supplier", async () => {
    queueSend(supplierRow(), { id: 99 });
    const res = await request(testApp)
      .post("/api/rfq/5/send")
      .send({ supplierIds: [7] });

    expect(res.body.details[0].status).toBe("skipped");
    expect(sendGreetingWhatsAppMock).not.toHaveBeenCalled();
    expect(sendGreetingEmailMock).not.toHaveBeenCalled();
  });

  it("records nothing when the supplier has no reachable channel", async () => {
    // A greeting we cannot deliver is not an event: no audit row, no send, and
    // no contact stamp — so the first send that CAN reach him still welcomes him.
    queueSend(supplierRow({ phone: null, email: null }));
    const res = await request(testApp).post("/api/rfq/5/send").send(body);

    expect(res.body.details[0].greeting).toBeNull();
    expect(sendGreetingWhatsAppMock).not.toHaveBeenCalled();
    expect(sendGreetingEmailMock).not.toHaveBeenCalled();
    expect(auditRows.some((r) => r.action === "supplier.greeted")).toBe(false);
    expect(updateSets.some((s) => "greetedAt" in s)).toBe(false);
  });
});
