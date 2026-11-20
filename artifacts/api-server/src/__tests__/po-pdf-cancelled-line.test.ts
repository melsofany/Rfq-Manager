import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import PDFDocument from "pdfkit";
import { isCancelledLine, activePoLines } from "../modules/po/line-status";
import { generatePoPdf } from "../modules/po/po-pdf";

// ── Route-level mocks (only what the PDF route touches) ────────────────────
vi.mock("../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

// Queue of result-sets returned by successive db.select(...).where() calls.
let selectQueue: any[] = [];

function thenable(value: any): any {
  return { then: (resolve: any) => Promise.resolve(value).then(resolve) };
}

function chainable(rows: any): any {
  const api: any = {
    from: vi.fn(() => api),
    leftJoin: vi.fn(() => api),
    innerJoin: vi.fn(() => api),
    where: vi.fn(() => chainable(rows)),
    limit: vi.fn(() => chainable(rows)),
    orderBy: vi.fn(() => chainable(rows)),
    groupBy: vi.fn(() => chainable(rows)),
    then: (resolve: any) => Promise.resolve(rows).then(resolve),
  };
  return api;
}

const tables = {
  purchaseOrdersTable: { _: "po" },
  purchaseOrderItemsTable: { _: "poItems" },
  suppliersTable: { _: "suppliers" },
  employeesTable: { _: "employees" },
  auditLogTable: { _: "audit" },
  offersTable: { _: "offers" },
  offerItemsTable: { _: "offerItems" },
  rfqItemsTable: { _: "rfqItems" },
  whatsappChatsTable: { _: "wa" },
  rfqTable: { _: "rfq" },
  workOrderAssignmentsTable: { _: "woa", poItemId: "poItemId" },
  poItemReceiptsTable: { _: "receipts", poItemId: "poItemId" },
  customerPosTable: { _: "cpos" },
  customerPoItemsTable: { _: "cpoItems" },
  customerRfqsTable: { _: "crfqs" },
  hrEmployeesTable: { _: "hrEmployees" },
  hrFieldAssignmentsTable: { _: "hrField" },
  mobileNotificationsTable: { _: "mobileNotifs" },
  hrSettingsTable: { _: "hrSettings" },
};

const dbMock: any = {
  select: vi.fn(() => chainable(selectQueue.shift() ?? [])),
  update: vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn(() => thenable(undefined)) })),
  })),
  insert: vi.fn(() => ({ values: vi.fn(() => thenable(undefined)) })),
  transaction: vi.fn(async (cb: any) => cb(dbMock)),
};

vi.mock("@workspace/db", () => ({
  ...tables,
  db: dbMock,
  WORK_ORDER_KIND: { RECEIPT: "receipt", DELIVERY: "delivery" },
}));

vi.mock("../shared/email", () => ({
  verifyEmailConnection: vi.fn().mockResolvedValue({ ok: true }),
  sendRfqEmail: vi.fn().mockResolvedValue({ ok: true }),
  sendOfferConfirmation: vi.fn().mockResolvedValue({ ok: true }),
  sendPoEmail: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../shared/google-sheets", () => ({
  lookupPoFromSheet: vi.fn().mockResolvedValue([]),
  listSheetPoNumbers: vi.fn().mockResolvedValue([]),
}));

vi.mock("../modules/communications/routes", () => ({
  applyReceiptSideEffects: vi.fn().mockResolvedValue(undefined),
  applyDeliverySideEffects: vi.fn().mockResolvedValue(undefined),
  broadcastWaEvent: vi.fn(),
}));

vi.mock("../modules/communications/service", () => ({
  sendPoWhatsApp: vi.fn().mockResolvedValue("supplier-wa-id"),
  isWhatsAppConfigured: true,
  sendRepresentativeWorkOrderWhatsApp: vi.fn().mockResolvedValue({ ok: true }),
  sendRepresentativeItemReceiptWhatsApp: vi.fn().mockResolvedValue("rep-wa-id"),
  sendRepPoDispatchWhatsApp: vi.fn().mockResolvedValue("rep-wa-id"),
  sendPoCancelWhatsApp: vi.fn().mockResolvedValue("cancel-wa-id"),
  sendPoCancelItemWhatsApp: vi.fn().mockResolvedValue("cancel-item-wa-id"),
  recordOutboundMessage: vi.fn(async () => undefined),
  formatQty: (q: any) => (q == null ? null : String(q)),
}));

vi.mock("../modules/users/supplier-registration", () => ({
  createRegistrationRequest: vi.fn().mockResolvedValue({
    requestId: 1,
    token: "tok",
    url: "https://example.com/s/tok",
    reused: false,
    missingFields: [],
    whatsappSent: true,
    whatsappError: null,
    emailSent: true,
    emailError: null,
  }),
}));

vi.mock("../modules/field-ops/service", () => ({
  loadFieldOpsSettings: vi.fn().mockResolvedValue({
    autoAssignOnDispatch: false,
    notifyOnAssignment: false,
  }),
}));

vi.mock("../modules/field-ops/delivery-status", () => ({
  isOutstandingDeliveryLine: vi.fn(() => true),
}));

// A cancelled line is not an order. The supplier was told over WhatsApp that the
// line is cancelled, so a PO PDF that still prints it contradicts the
// cancellation and invites an invoice for goods nobody wants.
//
// Reported live on PO 93 (PO-2026-000079): line 198 «3M SCOTCH TAP 35 GREEN
// COLOUR» was cancelled per-item and the downloaded PDF still listed all 4
// lines. The route queried items by (poId, supplierId) with no lineStatus
// filter, and the generator printed whatever it was given.

/** Every string pdfkit was actually asked to draw. */
let drawn: string[] = [];
const originalText = (PDFDocument.prototype as unknown as { text: unknown }).text;

beforeEach(() => {
  drawn = [];
  (PDFDocument.prototype as unknown as Record<string, unknown>).text = function (
    this: unknown,
    text: unknown,
    ...rest: unknown[]
  ) {
    if (typeof text === "string") drawn.push(text);
    return (originalText as (...a: unknown[]) => unknown).call(this, text, ...rest);
  };
});

afterEach(() => {
  (PDFDocument.prototype as unknown as Record<string, unknown>).text = originalText;
});

const drew = (s: string) => drawn.some((d) => d.includes(s));

// The exact four lines of PO 93, one of them cancelled.
const po93Lines = [
  {
    lineItem: "5720.006.GENRAL.0883",
    partNo: "Scotch35",
    description: "3M SCOTCH TAP 35 YELOW COLOUR",
    qty: "10.0000",
    uom: "Each",
    unitPrice: "319.0000",
    taxIncluded: false,
    lineStatus: "pending",
  },
  {
    lineItem: "5720.006.GENRAL.0884",
    partNo: "Scotch35",
    description: "3M SCOTCH TAP 35 RED COLOUR",
    qty: "10.0000",
    uom: "Each",
    unitPrice: "319.0000",
    taxIncluded: false,
    lineStatus: "pending",
  },
  {
    lineItem: "5720.006.GENRAL.0885",
    partNo: "Scotch35",
    description: "3M SCOTCH TAP 35 BLUE COLOUR",
    qty: "10.0000",
    uom: "Each",
    unitPrice: "319.0000",
    taxIncluded: false,
    lineStatus: "pending",
  },
  {
    lineItem: "5720.006.GENRAL.0887",
    partNo: "Scotch35",
    description: "3M SCOTCH TAP 35 GREEN COLOUR",
    qty: "10.0000",
    uom: "Each",
    unitPrice: "319.0000",
    taxIncluded: false,
    lineStatus: "cancelled",
  },
];

describe("a cancelled PO line never reaches the printed purchase order", () => {
  it("the rule: only `cancelled` is excluded — receipt states stay on the document", () => {
    expect(isCancelledLine("cancelled")).toBe(true);
    expect(isCancelledLine("Cancelled")).toBe(false); // the column is a closed set
    expect(isCancelledLine(null)).toBe(false);
    expect(isCancelledLine(undefined)).toBe(false);
    // Ordered, received, rejected or postponed goods WERE ordered — they belong.
    for (const s of ["pending", "partial", "fulfilled", "rejected", "postponed"]) {
      expect(isCancelledLine(s)).toBe(false);
    }
    expect(activePoLines(po93Lines).map((l) => l.lineItem)).toEqual([
      "5720.006.GENRAL.0883",
      "5720.006.GENRAL.0884",
      "5720.006.GENRAL.0885",
    ]);
  });

  it("the generator does not draw the cancelled description", async () => {
    await generatePoPdf({
      poNo: "PO-2026-000079",
      poDate: "2026-11-02T19:34:00.000Z",
      supplierName: "هاي تك للادوات الكهربائية",
      employeeName: "Sara",
      items: po93Lines,
    });

    expect(drew("3M SCOTCH TAP 35 YELOW COLOUR")).toBe(true);
    expect(drew("3M SCOTCH TAP 35 RED COLOUR")).toBe(true);
    expect(drew("3M SCOTCH TAP 35 BLUE COLOUR")).toBe(true);
    // The reported defect: this line is cancelled and must not be printed.
    expect(drew("3M SCOTCH TAP 35 GREEN COLOUR")).toBe(false);
    expect(drew("0887")).toBe(false);
  });

  it("the totals count only the lines that are printed", async () => {
    await generatePoPdf({
      poNo: "PO-2026-000079",
      supplierName: "هاي تك للادوات الكهربائية",
      employeeName: "Sara",
      items: po93Lines,
    });
    // 3 live lines × 10 × 319 = 9,570 — not 4 × 3,190 = 12,760. A total that
    // includes a line the table does not show is the same defect wearing a
    // number: the supplier would invoice 12,760 against a 3-line document.
    expect(drew("9,570.00")).toBe(true);
    expect(drew("12,760.00")).toBe(false);
  });

  it("a supplier whose every line is cancelled yields no line items at all", async () => {
    const allCancelled = po93Lines.map((l) => ({ ...l, lineStatus: "cancelled" }));
    await generatePoPdf({
      poNo: "PO-2026-000079",
      supplierName: "هاي تك للادوات الكهربائية",
      employeeName: "Sara",
      items: allCancelled,
    });
    for (const l of allCancelled) {
      expect(drew(l.description)).toBe(false);
    }
    expect(drew("0.00")).toBe(true); // an empty order totals zero, honestly
  });
});

// ── The ROUTE, not just the generator ───────────────────────────────────────
// A generator-only guard leaves the route free to fetch cancelled lines and
// hand them over. The reported defect lived in the route's query (poId +
// supplierId, no lineStatus), so the route is what must be measured.
describe("GET /api/po/:id/pdf/:supplierId — the route drops cancelled lines", () => {
  it("prints only the live lines of PO 93 and refuses when none remain", async () => {
    const { default: poRouter } = await import("../modules/po/index");
    const express = (await import("express")).default;
    const request = (await import("supertest")).default;

    const app = express();
    app.use((req: any, _res: any, next: any) => {
      req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
      req.session = { employeeId: 1, role: "admin" };
      next();
    });
    app.use("/api", poRouter);

    // Route queries, in order: PO header, supplier, items.
    selectQueue = [
      [
        {
          po: {
            id: 93,
            internalPoNo: "PO-2026-000079",
            createdAt: new Date("2026-11-02T19:34:00.000Z"),
            notes: null,
            receiverName: null,
            receiverPhone: null,
          },
          employeeName: "Sara",
          employeePhone: null,
        },
      ],
      [{ id: 292, name: "هاي تك للادوات الكهربائية", contactPerson: null }],
      po93Lines.map((l, i) => ({ item: { ...l, id: 195 + i } })),
    ];

    drawn = [];
    const res = await request(app).get("/api/po/93/pdf/292");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");

    expect(drew("3M SCOTCH TAP 35 YELOW COLOUR")).toBe(true);
    expect(drew("3M SCOTCH TAP 35 RED COLOUR")).toBe(true);
    expect(drew("3M SCOTCH TAP 35 BLUE COLOUR")).toBe(true);
    expect(drew("3M SCOTCH TAP 35 GREEN COLOUR")).toBe(false);
    expect(drew("12,760.00")).toBe(false);
  });

  it("409s instead of emitting a document with no order lines", async () => {
    const { default: poRouter } = await import("../modules/po/index");
    const express = (await import("express")).default;
    const request = (await import("supertest")).default;

    const app = express();
    app.use((req: any, _res: any, next: any) => {
      req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
      req.session = { employeeId: 1, role: "admin" };
      next();
    });
    app.use("/api", poRouter);

    selectQueue = [
      [
        {
          po: {
            id: 93,
            internalPoNo: "PO-2026-000079",
            createdAt: new Date("2026-11-02T19:34:00.000Z"),
            notes: null,
            receiverName: null,
            receiverPhone: null,
          },
          employeeName: "Sara",
          employeePhone: null,
        },
      ],
      [{ id: 292, name: "هاي تك للادوات الكهربائية", contactPerson: null }],
      [{ item: { ...po93Lines[3], id: 198 } }],
    ];

    drawn = [];
    const res = await request(app).get("/api/po/93/pdf/292");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ملغاة/);
    // Nothing was rendered: a PDF with a header and no lines is not an order.
    expect(drawn.length).toBe(0);
  });
});
