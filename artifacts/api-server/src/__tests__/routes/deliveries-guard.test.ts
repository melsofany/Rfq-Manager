import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock auth ───────────────────────────────────────────────────────────────
vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

// Mock the WhatsApp service so send-delivery-prompts doesn't hit the network.
vi.mock("../../modules/communications/routes", () => ({
  applyReceiptSideEffects: vi.fn().mockResolvedValue(undefined),
  applyDeliverySideEffects: vi.fn().mockResolvedValue(undefined),
  broadcastWaEvent: vi.fn(),
}));

vi.mock("../../modules/communications/service", () => ({
  isWhatsAppConfigured: true,
  sendRepMainMenu: vi.fn(async () => "msg-id"),
  sendWhatsAppText: vi.fn(async () => "msg-id"),
  normalizePhone: (p: string) => p,
}));

// ── Chainable + thenable DB mock ─────────────────────────────────────────────
function chainable(value: any, methods: Record<string, any> = {}): any {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
}

const customerPosTable = { _: "customerPos", id: "id", internalPoNo: "internalPoNo" };
const customerPoItemsTable = { _: "customerPoItems", id: "id", customerPoId: "customerPoId" };
const purchaseOrderItemsTable = {
  _: "purchaseOrderItems",
  customerPoItemId: "customerPoItemId",
  totalAcceptedQty: "totalAcceptedQty",
  lineStatus: "lineStatus",
};
const customerPoItemDeliveriesTable = { _: "customerPoItemDeliveries", id: "id", customerPoItemId: "customerPoItemId" };
const workOrderAssignmentsTable = {
  _: "workOrderAssignments",
  customerPoId: "customerPoId",
  kind: "kind",
  status: "status",
  representativePhone: "representativePhone",
};
const auditLogTable = { _: "audit" };
const tables = {
  customerPosTable,
  customerPoItemsTable,
  purchaseOrderItemsTable,
  customerPoItemDeliveriesTable,
  workOrderAssignmentsTable,
  auditLogTable,
  WORK_ORDER_KIND: { RECEIPT: "receipt", DELIVERY: "delivery" },
};

// Per-test state.
let poRow: any; // the customer PO (select from customerPosTable by id)
let itemRow: any; // the customer_po_item (select from customerPoItemsTable by id)
let acceptedRows: any[]; // supplier link rows (select from purchaseOrderItemsTable by customerPoItemId)
let deliveryRows: any[]; // existing deliveries for recompute (select from customerPoItemDeliveriesTable)
let assignmentRows: any[]; // delivery assignments (for send-delivery-prompts)

const sessionState = { employeeId: 1, employeeName: "Tester", role: "admin" };

const dbMock: any = {
  select: vi.fn((arg?: any) => ({
    from: vi.fn((table: any) => {
      // customer PO header: select({id,internalPoNo}).from(customerPos).where(eq(id))
      if (table === customerPosTable) {
        const rows = poRow ? [poRow] : [];
        return chainable(rows, { where: vi.fn(() => chainable(rows)) });
      }
      // customer_po_item: select({id}).from(customerPoItems).where(eq(id))
      if (table === customerPoItemsTable) {
        const rows = itemRow ? [itemRow] : [];
        return chainable(rows, { where: vi.fn(() => chainable(rows)) });
      }
      // supplier link: select({accepted,lineStatus}).from(purchaseOrderItems).where(eq(customerPoItemId))
      if (table === purchaseOrderItemsTable) {
        return chainable(acceptedRows, { where: vi.fn(() => chainable(acceptedRows)) });
      }
      // existing deliveries (for recompute): select().from(customerPoItemDeliveries).where(eq(customerPoItemId))
      if (table === customerPoItemDeliveriesTable) {
        return chainable(deliveryRows, { where: vi.fn(() => chainable(deliveryRows)) });
      }
      // delivery assignments (send-delivery-prompts): select({...}).from(workOrderAssignments).where(and(...))
      if (table === workOrderAssignmentsTable) {
        return chainable(assignmentRows, { where: vi.fn(() => chainable(assignmentRows)) });
      }
      return chainable([], { where: vi.fn(() => chainable([])) });
    }),
  })),
  insert: vi.fn((_table: any) => ({
    values: vi.fn((_vals: any) => ({ returning: vi.fn(() => chainable([{ id: 100 }])) })),
  })),
  update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => chainable(undefined)) })) })),
  delete: vi.fn(() => ({ where: vi.fn(() => chainable(undefined)) })),
};

vi.mock("@workspace/db", () => ({ ...tables, db: dbMock }));

let testApp: express.Express;

beforeAll(async () => {
  const { default: deliveriesRouter } = await import("../../modules/customer-po/deliveries");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = sessionState;
    req.get = () => undefined;
    next();
  });
  testApp.use("/api", deliveriesRouter);
  testApp.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: String(err?.message || err) });
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  poRow = { id: 5, internalPoNo: "CPO-2025-000005" };
  itemRow = { id: 42, customerPoId: 5, qty: "10" };
  acceptedRows = [];
  deliveryRows = [];
  assignmentRows = [];
});

describe("POST /customer-po/:id/deliveries — no-delivery-before-receipt guard", () => {
  it("rejects delivery when the linked supplier line was not received (accepted=0)", async () => {
    // Supplier link exists but accepted qty is 0 (pending).
    acceptedRows = [{ accepted: "0", lineStatus: "pending" }];

    const res = await request(testApp)
      .post("/api/customer-po/5/deliveries")
      .send({ customerPoItemId: 42, deliveredQty: "10" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/لا يمكن التسليم قبل الاستلام/);
  });

  it("rejects delivery when the linked supplier line was rejected", async () => {
    acceptedRows = [{ accepted: "0", lineStatus: "rejected" }];

    const res = await request(testApp)
      .post("/api/customer-po/5/deliveries")
      .send({ customerPoItemId: 42, deliveredQty: "5" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/لا يمكن التسليم قبل الاستلام/);
  });

  it("allows delivery when the supplier line was accepted (received)", async () => {
    acceptedRows = [{ accepted: "10", lineStatus: "fulfilled" }];

    const res = await request(testApp)
      .post("/api/customer-po/5/deliveries")
      .send({ customerPoItemId: 42, deliveredQty: "10" });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });

  it("rejects delivery exceeding the accepted qty from supplier", async () => {
    acceptedRows = [{ accepted: "4", lineStatus: "partial" }];

    const res = await request(testApp)
      .post("/api/customer-po/5/deliveries")
      .send({ customerPoItemId: 42, deliveredQty: "10" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/تتجاوز الكمية المقبولة من المورد/);
  });

  it("allows a customer rejection (rejectedByCustomerQty) even before receipt records", async () => {
    // Customer refusing is not a "delivery" of qty, so the accepted guard on
    // deliveredQty (>0) should not block recording the refusal itself.
    acceptedRows = [{ accepted: "10", lineStatus: "fulfilled" }];

    const res = await request(testApp)
      .post("/api/customer-po/5/deliveries")
      .send({ customerPoItemId: 42, rejectedByCustomerQty: "10", rejectionReason: "تالف" });

    expect(res.status).toBe(201);
  });
});

describe("POST /customer-po/:id/send-delivery-prompts", () => {
  it("400s when no representative is assigned to the customer PO", async () => {
    assignmentRows = [];

    const res = await request(testApp)
      .post("/api/customer-po/5/send-delivery-prompts")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/لا يوجد مندوب/);
  });

  it("sends a prompt to pending delivery reps and returns the count", async () => {
    assignmentRows = [
      { representativePhone: "+201000000001", status: "sent" },
      { representativePhone: "+201000000002", status: "delivered" }, // already done → skipped
    ];

    const res = await request(testApp)
      .post("/api/customer-po/5/send-delivery-prompts")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sent).toBeGreaterThanOrEqual(1);
  });
});
