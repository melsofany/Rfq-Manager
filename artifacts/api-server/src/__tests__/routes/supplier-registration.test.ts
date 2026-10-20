import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock auth + side-effectful modules ─────────────────────────────────────
vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

const sendRegistrationWhatsApp = vi.fn().mockResolvedValue("wa-reg-1");
const sendMismatchWhatsApp = vi.fn().mockResolvedValue("wa-mis-1");
let _whatsappConfigured = true;
vi.mock("../../modules/communications/service", () => ({
  get isWhatsAppConfigured() {
    return _whatsappConfigured;
  },
  sendSupplierRegistrationWhatsApp: (...a: any[]) => sendRegistrationWhatsApp(...a),
  sendSupplierRegistrationMismatchWhatsApp: (...a: any[]) => sendMismatchWhatsApp(...a),
}));

const sendRegistrationEmail = vi.fn().mockResolvedValue(undefined);
const sendMismatchEmail = vi.fn().mockResolvedValue(undefined);
vi.mock("../../shared/email", () => ({
  sendSupplierRegistrationEmail: (...a: any[]) => sendRegistrationEmail(...a),
  sendRegistrationMismatchEmail: (...a: any[]) => sendMismatchEmail(...a),
}));

// ── DB mock ────────────────────────────────────────────────────────────────
const updateSets: any[] = [];
const insertCalls: any[] = [];
let supplierRow: any = null;
let requestRow: any = null;

function thenable(value: any, extra: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, v] of Object.entries(extra)) obj[k] = v;
  return obj;
}

function chainable(rows: any): any {
  const api: any = {
    from: () => api,
    innerJoin: () => api,
    leftJoin: () => api,
    where: () => api,
    orderBy: () => api,
    limit: () => api,
    then: (resolve: any) => Promise.resolve(rows).then(resolve),
  };
  return api;
}

const tables = {
  suppliersTable: { _: "suppliers" },
  supplierRegistrationRequestsTable: { _: "reg" },
  auditLogTable: { _: "audit" },
  whatsappChatsTable: { _: "wa" },
};

vi.mock("@workspace/db", () => ({
  ...tables,
  SUPPLIER_REGISTRATION_STATUS: {
    PENDING: "pending",
    COMPLETED: "completed",
    EXPIRED: "expired",
    CANCELLED: "cancelled",
  },
  db: {
    select: vi.fn(() => {
      // The select target decides which staged row to serve: the registration
      // request lookup vs the supplier lookup vs the operator-side history.
      const api: any = chainable([]);
      api.from = (table: any) => {
        if (table?._ === "reg") return chainable(requestRow ? [requestRow] : []);
        if (table?._ === "suppliers") return chainable(supplierRow ? [supplierRow] : []);
        return chainable([]);
      };
      return api;
    }),
    update: vi.fn(() => ({
      set: vi.fn((vals: any) => {
        updateSets.push(vals);
        return { where: vi.fn(() => thenable(undefined)) };
      }),
    })),
    insert: vi.fn((table?: any) => ({
      values: vi.fn((vals: any) => {
        insertCalls.push({ table: table?._, vals });
        if (table?._ === "reg") {
          return thenable(undefined, {
            returning: () =>
              Promise.resolve([
                { id: 99, token: "newtok", expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000) },
              ]),
          });
        }
        return thenable(undefined);
      }),
    })),
  },
}));

let testApp: express.Express;

beforeAll(async () => {
  const { default: router } = await import("../../modules/users/supplier-registration");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = { employeeId: 1 };
    next();
  });
  testApp.use("/api", router);
});

beforeEach(() => {
  vi.clearAllMocks();
  updateSets.length = 0;
  insertCalls.length = 0;
  _whatsappConfigured = true;
  supplierRow = null;
  requestRow = null;
});

const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000);

const openRequest = (over: Record<string, any> = {}) => ({
  id: 5,
  supplierId: 7,
  token: "tok-abc",
  status: "pending",
  heldData: { bankName: null, bankAccountHolder: null },
  requestedFields: ["bankName", "bankAccountHolder", "iban"],
  submittedData: null,
  attempts: 0,
  expiresAt: FUTURE,
  poId: null,
  ...over,
});

describe("GET /api/supplier-registration/:token", () => {
  it("returns the held data and the fields to fill for an open link", async () => {
    requestRow = openRequest();
    supplierRow = { id: 7, name: "Acme", contactPerson: "Hassan" };
    const res = await request(testApp).get("/api/supplier-registration/tok-abc");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("open");
    expect(res.body.canSubmit).toBe(true);
    expect(res.body.supplierName).toBe("Acme");
    expect(res.body.requestedFields).toEqual(["bankName", "bankAccountHolder", "iban"]);
  });

  it("returns 404 for an unknown token", async () => {
    requestRow = null;
    const res = await request(testApp).get("/api/supplier-registration/nope");
    expect(res.status).toBe(404);
  });

  it("marks a completed link as no longer usable", async () => {
    requestRow = openRequest({ status: "completed" });
    const res = await request(testApp).get("/api/supplier-registration/tok-abc");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(res.body.canSubmit).toBe(false);
  });

  it("derives expiry from the clock, not the stored status", async () => {
    requestRow = openRequest({ expiresAt: new Date(Date.now() - 1000) });
    const res = await request(testApp).get("/api/supplier-registration/tok-abc");
    expect(res.body.status).toBe("expired");
    expect(res.body.canSubmit).toBe(false);
  });
});

describe("POST /api/supplier-registration/:token/submit", () => {
  it("stores the first entry without touching the supplier record", async () => {
    requestRow = openRequest();
    const res = await request(testApp)
      .post("/api/supplier-registration/tok-abc/submit")
      .send({
        data: {
          bankName: "NBE",
          bankAccountHolder: "Acme Co",
          iban: "EG380019000500000000263180002",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.step).toBe("confirm");
    // Nothing was written to the supplier yet — only the request row.
    const supplierUpdates = updateSets.filter((s) => s.registrationVerifiedAt);
    expect(supplierUpdates).toHaveLength(0);
    const requestUpdate = updateSets.find((s) => "submittedData" in s);
    expect(requestUpdate.submittedData).toMatchObject({ bankName: "NBE" });
  });

  it("rejects an invalid field with a per-field error", async () => {
    requestRow = openRequest();
    const res = await request(testApp)
      .post("/api/supplier-registration/tok-abc/submit")
      .send({ data: { bankName: "NBE", bankAccountHolder: "Acme", iban: "BAD" } });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.iban).toMatch(/IBAN/);
  });

  it("refuses a second submit once completed", async () => {
    requestRow = openRequest({ status: "completed" });
    const res = await request(testApp)
      .post("/api/supplier-registration/tok-abc/submit")
      .send({ data: { bankName: "NBE" } });
    expect(res.status).toBe(409);
  });
});

describe("POST /api/supplier-registration/:token/confirm", () => {
  const first = {
    bankName: "NBE",
    bankAccountHolder: "Acme Co",
    iban: "EG380019000500000000263180002",
  };

  it("commits the data and closes the link when the two entries match", async () => {
    requestRow = openRequest({ submittedData: first });
    supplierRow = {
      id: 7,
      name: "Acme",
      phone: "201111111111",
      email: "a@b.com",
      contactPerson: null,
    };
    const res = await request(testApp)
      .post("/api/supplier-registration/tok-abc/confirm")
      .send({ data: first });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");

    // The supplier record received the values + the verification stamp.
    const supplierUpdate = updateSets.find((s) => s.registrationVerifiedAt);
    expect(supplierUpdate).toMatchObject({ bankName: "NBE", iban: first.iban });
    // The request row was closed.
    const closeUpdate = updateSets.find((s) => s.status === "completed");
    expect(closeUpdate.confirmedData).toMatchObject(first);
    expect(insertCalls.some((c) => c.table === "audit")).toBe(true);
  });

  it("refuses a mismatch, writes nothing to the supplier and tells the supplier", async () => {
    requestRow = openRequest({ submittedData: first, attempts: 0 });
    supplierRow = {
      id: 7,
      name: "Acme",
      phone: "201111111111",
      email: "a@b.com",
      contactPerson: null,
    };
    const res = await request(testApp)
      .post("/api/supplier-registration/tok-abc/confirm")
      .send({ data: { ...first, iban: "EG380019000500000000263180003" } });

    expect(res.status).toBe(409);
    expect(res.body.mismatchFields).toEqual(["iban"]);
    // NO supplier write — the refusal must leave the record untouched.
    expect(updateSets.some((s) => s.registrationVerifiedAt)).toBe(false);
    // The request resets to step one and counts the attempt.
    const reset = updateSets.find((s) => "submittedData" in s && s.submittedData === null);
    expect(reset.attempts).toBe(1);
    // The supplier is told, on both channels.
    expect(sendMismatchWhatsApp).toHaveBeenCalledTimes(1);
    expect(sendMismatchEmail).toHaveBeenCalledTimes(1);
  });

  it("refuses a confirm when no first entry was recorded", async () => {
    requestRow = openRequest({ submittedData: null });
    const res = await request(testApp)
      .post("/api/supplier-registration/tok-abc/confirm")
      .send({ data: first });
    expect(res.status).toBe(400);
    expect(res.body.step).toBe("submit");
  });
});

describe("POST /api/suppliers/:id/registration-request", () => {
  it("creates a link, sends it on both channels and reports what was sent", async () => {
    supplierRow = {
      id: 7,
      name: "Acme",
      phone: "201111111111",
      email: "a@b.com",
      contactPerson: "Hassan",
    };
    requestRow = null; // no live link → a new one is minted
    const res = await request(testApp).post("/api/suppliers/7/registration-request");

    expect(res.status).toBe(200);
    expect(res.body.whatsappSent).toBe(true);
    expect(res.body.emailSent).toBe(true);
    expect(res.body.missingFields).toContain("bankName");
    expect(res.body.url).toMatch(/\/s\//);
    // The link went out naming the missing fields.
    expect(sendRegistrationWhatsApp).toHaveBeenCalledTimes(1);
    expect(sendRegistrationEmail).toHaveBeenCalledTimes(1);
    // And the chat record was saved so the operator sees it in the inbox.
    expect(insertCalls.some((c) => c.table === "wa")).toBe(true);
  });

  it("404s for a missing supplier", async () => {
    supplierRow = null;
    const res = await request(testApp).post("/api/suppliers/7/registration-request");
    expect(res.status).toBe(404);
  });

  it("reports the WhatsApp failure rather than claiming it was sent", async () => {
    supplierRow = { id: 7, name: "Acme", phone: "201111111111", email: "", contactPerson: null };
    requestRow = null;
    sendRegistrationWhatsApp.mockRejectedValueOnce(new Error("template not approved"));
    const res = await request(testApp).post("/api/suppliers/7/registration-request");
    expect(res.status).toBe(200);
    expect(res.body.whatsappSent).toBe(false);
    expect(res.body.whatsappError).toMatch(/template not approved/);
  });
});

describe("POST /api/supplier-registration-requests/:id/cancel", () => {
  it("cancels a live link", async () => {
    requestRow = openRequest();
    const res = await request(testApp).post("/api/supplier-registration-requests/5/cancel");
    expect(res.status).toBe(200);
    expect(updateSets.some((s) => s.status === "cancelled")).toBe(true);
  });

  it("refuses to cancel a completed request", async () => {
    requestRow = openRequest({ status: "completed" });
    const res = await request(testApp).post("/api/supplier-registration-requests/5/cancel");
    expect(res.status).toBe(400);
  });
});
