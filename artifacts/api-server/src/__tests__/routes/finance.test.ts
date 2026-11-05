import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

let sessionState: { employeeId: number | null; role: string; employeeName: string } = {
  employeeId: 7,
  role: "manager",
  employeeName: "Sara",
};
// Permission gate is mocked separately so the tests exercise the ROUTE logic
// rather than the permission resolver (which has its own suite).
let confirmAllowed = true;

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.session = { ...sessionState };
    next();
  },
}));

vi.mock("../../shared/permissions", () => ({
  requirePermission: () => (req: any, res: any, next: any) => {
    if (!H.state.confirmAllowed) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  },
}));

vi.mock("../../modules/accounts-bridge/events", () => ({
  syncSupplierPayment: (...args: any[]) => H.state.syncSupplierPayment(...args),
}));

// ── db mock ────────────────────────────────────────────────────────────────
const H = vi.hoisted(() => {
  const requestsTbl = "financeRequests";
  const paymentsTbl = "financePayments";
  const allocationsTbl = "financeAllocations";
  const bulkPaymentsTbl = "financeBulkPayments";
  const poTbl = "purchaseOrders";
  const poItemsTbl = "purchaseOrderItems";
  const suppliersTbl = "suppliers";
  const auditTbl = "auditLog";
  const statementsTbl = "financeStatements";
  const journalEntriesTbl = "journalEntries";
  const journalLinesTbl = "journalLines";
  const chartOfAccountsTbl = "chartOfAccounts";
  const salesInvoicesTbl = "salesInvoices";
  const supplierInvoicesTbl = "supplierInvoices";
  const supplierPaymentsTbl = "supplierPayments";

  const state: any = {
    poRows: [],
    poItemRows: [],
    supplierRows: [],
    existingRequestRows: [],
    paymentRows: [],
    allocationRows: [],
    bulkPaymentRows: [],
    requestRow: null as any,
    inserted: [] as any[],
    updated: [] as any[],
    deleted: [] as any[],
    syncSupplierPayment: null as any,
    confirmAllowed: true,
    nextId: 99,
  };

  function rowsFor(table: any): any[] {
    switch (table) {
      case poTbl:
        return state.poRows;
      case poItemsTbl:
        return state.poItemRows;
      case suppliersTbl:
        return state.supplierRows;
      case requestsTbl:
        return state.requestRow ? [state.requestRow] : state.existingRequestRows;
      case paymentsTbl:
        return state.paymentRows;
      case allocationsTbl:
        return state.allocationRows;
      case bulkPaymentsTbl:
        return state.bulkPaymentRows;
      default:
        return [];
    }
  }

  function chain(value: any): any {
    return { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  }

  const dbMock: any = {
    select: vi.fn((arg: any) => ({
      from: vi.fn((table: any) => {
        // `nextEntryNo` reads the series' own number column. The real drizzle
        // projection is mocked away here, so honour the `{ no: … }` shape
        // explicitly or every series would appear empty and restart at 1.
        const rows =
          "no" in (arg ?? {})
            ? rowsFor(table).map((r: any) => ({ no: r.paymentNo ?? r.statementNo }))
            : rowsFor(table);
        const cur: any = {
          innerJoin: vi.fn(() => cur),
          leftJoin: vi.fn(() => cur),
          where: vi.fn(() => cur),
          orderBy: vi.fn(() => cur),
          groupBy: vi.fn(() => cur),
          limit: vi.fn(() => chain(rows)),
          then: (resolve: any) => Promise.resolve(rows).then(resolve),
        };
        return cur;
      }),
    })),
    insert: vi.fn((table: any) => ({
      values: vi.fn((values: any) => {
        state.inserted.push({ table, values });
        const rows = Array.isArray(values) ? values : [values];
        // A GLOBAL counter, not a per-call index: ids must be unique across
        // inserts or a bulk payment's document row and its per-order rows would
        // all share id 100 and the allocation assertions would prove nothing.
        const result = rows.map((v: any) => ({
          id: ++state.nextId,
          paidAmount: "0",
          status: "unpaid",
          selectedAt: new Date(),
          ...v,
        }));
        const p: any = Promise.resolve(result);
        p.returning = () => Promise.resolve(result);
        return p;
      }),
    })),
    update: vi.fn((table: any) => ({
      set: vi.fn((values: any) => {
        state.updated.push({ table, values });
        return { where: vi.fn(() => Promise.resolve([])) };
      }),
    })),
    delete: vi.fn((table: any) => ({
      where: vi.fn(() => {
        state.deleted.push({ table });
        return Promise.resolve([]);
      }),
    })),
    transaction: vi.fn(async (fn: any) => fn({ ...dbMock, execute: vi.fn(async () => []) })),
  };

  return {
    requestsTbl,
    paymentsTbl,
    allocationsTbl,
    bulkPaymentsTbl,
    statementsTbl,
    poTbl,
    poItemsTbl,
    suppliersTbl,
    auditTbl,
    journalEntriesTbl,
    journalLinesTbl,
    chartOfAccountsTbl,
    salesInvoicesTbl,
    supplierInvoicesTbl,
    supplierPaymentsTbl,
    state,
    dbMock,
  };
});

const {
  requestsTbl,
  paymentsTbl,
  allocationsTbl,
  bulkPaymentsTbl,
  statementsTbl,
  poTbl,
  poItemsTbl,
  suppliersTbl,
  auditTbl,
  state,
  dbMock,
} = H;

vi.mock("@workspace/db", () => ({
  db: H.dbMock,
  financePaymentRequestsTable: H.requestsTbl,
  financePaymentsTable: H.paymentsTbl,
  financePaymentAllocationsTable: H.allocationsTbl,
  financeBulkPaymentsTable: H.bulkPaymentsTbl,
  financeSupplierStatementsTable: "financeStatements",
  purchaseOrdersTable: H.poTbl,
  purchaseOrderItemsTable: H.poItemsTbl,
  suppliersTable: H.suppliersTbl,
  auditLogTable: H.auditTbl,
  FINANCE_REQUEST_STATUS: ["unpaid", "partial", "paid"],
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: any, val: any) => ({ __eq: [col, val] }),
  and: (...a: any[]) => ({ __and: a }),
  inArray: (col: any, val: any) => ({ __inArray: [col, val] }),
  desc: (col: any) => ({ __desc: col }),
  sql: Object.assign((s: any) => s, {}),
}));

import financeRouter from "../../modules/finance/routes";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(financeRouter);
  return app;
}

beforeEach(() => {
  sessionState = { employeeId: 7, role: "manager", employeeName: "Sara" };
  state.confirmAllowed = true;
  state.poRows = [];
  state.poItemRows = [];
  state.supplierRows = [];
  state.existingRequestRows = [];
  state.paymentRows = [];
  state.allocationRows = [];
  state.bulkPaymentRows = [];
  state.requestRow = null;
  state.nextId = 99;
  state.inserted.length = 0;
  state.updated.length = 0;
  state.deleted.length = 0;
  state.syncSupplierPayment = vi.fn(async () => ({ ok: true }));
  dbMock.select.mockClear();
});

describe("finance — add POs to الماليات", () => {
  it("expands one PO into one payable row per supplier with its own due amount", async () => {
    state.poRows = [{ id: 5, status: "sent", sheetPoNo: "P26E1", internalPoNo: "PO-2026-000005" }];
    state.poItemRows = [
      { poId: 5, supplierId: 1, qty: "2", referencePrice: "100", lineStatus: "pending" },
      { poId: 5, supplierId: 2, qty: "3", referencePrice: "50", lineStatus: "pending" },
    ];
    state.supplierRows = [
      { id: 1, name: "Alpha", bankName: "NBE", bankAccountNumber: "111", iban: null },
      { id: 2, name: "Beta", bankName: "CIB", bankAccountNumber: "222", iban: null },
    ];

    const res = await request(buildApp())
      .post("/finance/requests")
      .send({ poIds: [5] });

    expect(res.status).toBe(201);
    expect(res.body.createdCount).toBe(2);
    const due = state.inserted[0].values.map((v: any) => [v.supplierName, v.dueAmount]);
    expect(due).toEqual([
      ["Alpha", "200"],
      ["Beta", "150"],
    ]);
    expect(state.inserted[0].values[0].bankAccountNumber).toBe("111");
  });

  it("excludes cancelled lines from the due amount — a cancelled line is not a debt", async () => {
    state.poRows = [{ id: 5, status: "sent", sheetPoNo: "P26E1", internalPoNo: "PO-5" }];
    state.poItemRows = [
      { poId: 5, supplierId: 1, qty: "2", referencePrice: "100", lineStatus: "pending" },
      { poId: 5, supplierId: 1, qty: "9", referencePrice: "100", lineStatus: "cancelled" },
    ];
    state.supplierRows = [{ id: 1, name: "Alpha" }];

    const res = await request(buildApp())
      .post("/finance/requests")
      .send({ poIds: [5] });

    expect(res.status).toBe(201);
    expect(state.inserted[0].values[0].dueAmount).toBe("200");
  });

  it("skips a pair already queued instead of duplicating it", async () => {
    state.poRows = [{ id: 5, status: "sent", sheetPoNo: "P26E1", internalPoNo: "PO-5" }];
    state.poItemRows = [
      { poId: 5, supplierId: 1, qty: "1", referencePrice: "10", lineStatus: "pending" },
      { poId: 5, supplierId: 2, qty: "1", referencePrice: "10", lineStatus: "pending" },
    ];
    state.supplierRows = [
      { id: 1, name: "Alpha" },
      { id: 2, name: "Beta" },
    ];
    state.existingRequestRows = [{ poId: 5, supplierId: 1 }];

    const res = await request(buildApp())
      .post("/finance/requests")
      .send({ poIds: [5] });

    expect(res.status).toBe(201);
    expect(res.body.createdCount).toBe(1);
    expect(res.body.skippedCount).toBe(1);
    expect(state.inserted[0].values).toHaveLength(1);
    expect(state.inserted[0].values[0].supplierId).toBe(2);
    expect(res.body.skipped.some((s: any) => s.reason === "already_added")).toBe(true);
  });

  it("refuses a draft order — an un-dispatched order is not payable", async () => {
    state.poRows = [{ id: 5, status: "draft", sheetPoNo: null, internalPoNo: "PO-5" }];

    const res = await request(buildApp())
      .post("/finance/requests")
      .send({ poIds: [5] });

    expect(res.status).toBe(400);
    expect(res.body.skipped[0].reason).toBe("draft");
    expect(state.inserted).toHaveLength(0);
  });

  it("rejects an empty selection", async () => {
    const res = await request(buildApp()).post("/finance/requests").send({ poIds: [] });
    expect(res.status).toBe(400);
  });
});

describe("finance — payments", () => {
  it("records a partial payment and leaves the request open", async () => {
    state.requestRow = {
      id: 9,
      poId: 5,
      supplierId: 1,
      supplierName: "Alpha",
      internalPoNo: "PO-5",
      dueAmount: "1000",
      paidAmount: "0",
      status: "unpaid",
    };

    const res = await request(buildApp())
      .post("/finance/requests/9/payments")
      .send({ amount: 400, paymentDate: "2026-11-03", method: "تحويل بنكي" });

    expect(res.status).toBe(201);
    expect(res.body.settled).toBe(false);
    const upd = state.updated.find((u: any) => u.table === requestsTbl);
    expect(upd.values.status).toBe("partial");
    expect(upd.values.paidAmount).toBe("400");
    expect(state.syncSupplierPayment).toHaveBeenCalledWith(100);
  });

  it("settles the request when the payment clears the due amount", async () => {
    state.requestRow = {
      id: 9,
      poId: 5,
      supplierId: 1,
      supplierName: "Alpha",
      internalPoNo: "PO-5",
      dueAmount: "1000",
      paidAmount: "600",
      status: "partial",
    };

    const res = await request(buildApp())
      .post("/finance/requests/9/payments")
      .send({ amount: 400, paymentDate: "2026-11-03", method: "شيك" });

    expect(res.body.settled).toBe(true);
    const upd = state.updated.find((u: any) => u.table === requestsTbl);
    expect(upd.values.status).toBe("paid");
    expect(upd.values.paidAt).toBeTruthy();
  });

  it("refuses to pay a settled order a second time", async () => {
    state.requestRow = {
      id: 9,
      poId: 5,
      supplierId: 1,
      supplierName: "Alpha",
      dueAmount: "1000",
      paidAmount: "1000",
      status: "paid",
    };

    const res = await request(buildApp())
      .post("/finance/requests/9/payments")
      .send({ amount: 100, paymentDate: "2026-11-03", method: "نقدية" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("لا يمكن السداد مرة أخرى");
    expect(state.inserted).toHaveLength(0);
  });

  it("refuses a payment larger than the remaining balance", async () => {
    state.requestRow = {
      id: 9,
      poId: 5,
      supplierId: 1,
      supplierName: "Alpha",
      dueAmount: "1000",
      paidAmount: "900",
      status: "partial",
    };

    const res = await request(buildApp())
      .post("/finance/requests/9/payments")
      .send({ amount: 500, paymentDate: "2026-11-03", method: "نقدية" });

    expect(res.status).toBe(400);
    expect(res.body.remainingAmount).toBe("100");
  });

  it("gates confirming a payment behind finance:confirm", async () => {
    state.confirmAllowed = false;
    state.requestRow = {
      id: 9,
      poId: 5,
      supplierId: 1,
      supplierName: "Alpha",
      dueAmount: "1000",
      paidAmount: "0",
      status: "unpaid",
    };

    const res = await request(buildApp())
      .post("/finance/requests/9/payments")
      .send({ amount: 100, paymentDate: "2026-11-03", method: "نقدية" });

    expect(res.status).toBe(403);
    expect(state.inserted).toHaveLength(0);
  });

  it("rejects a non-positive amount", async () => {
    const res = await request(buildApp())
      .post("/finance/requests/9/payments")
      .send({ amount: 0, paymentDate: "2026-11-03", method: "نقدية" });
    expect(res.status).toBe(400);
  });
});

describe("finance — payment order PDF (أمر دفع)", () => {
  it("streams a PDF for a recorded payment", async () => {
    state.paymentRows = [
      {
        id: 55,
        requestId: 9,
        paymentNo: "PAY-2026-000123",
        amount: "400",
        paymentDate: "2026-11-03",
        method: "تحويل بنكي",
        reference: null,
        notes: null,
        employeeName: "Sara",
      },
    ];
    state.requestRow = {
      id: 9,
      poId: 5,
      supplierId: 1,
      supplierName: "Alpha",
      internalPoNo: "PO-2026-000005",
      poNo: "P26E1",
      dueAmount: "1000",
      paidAmount: "400",
      status: "partial",
      bankName: "NBE",
      bankAccountNumber: "111",
      iban: null,
    };

    const res = await request(buildApp()).get("/finance/payments/55/pdf");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("404s an unknown payment", async () => {
    state.paymentRows = [];
    const res = await request(buildApp()).get("/finance/payments/999/pdf");
    expect(res.status).toBe(404);
  });
});

describe("finance — supplier statement (كشف حساب مورد)", () => {
  function seedStatement() {
    state.supplierRows = [{ id: 1, name: "Alpha", bankName: "NBE", bankAccountNumber: "111" }];
    state.existingRequestRows = [
      {
        id: 9,
        supplierId: 1,
        internalPoNo: "PO-2026-000005",
        poNo: "P26E1",
        selectedAt: "2026-10-01T00:00:00.000Z",
        dueAmount: "1000",
        paidAmount: "400",
        status: "partial",
      },
      {
        id: 10,
        supplierId: 1,
        internalPoNo: "PO-2026-000011",
        poNo: "P26E2",
        selectedAt: "2026-10-12T00:00:00.000Z",
        dueAmount: "500",
        paidAmount: "0",
        status: "unpaid",
      },
    ];
  }

  it("returns every open order with one grand total", async () => {
    seedStatement();
    const res = await request(buildApp()).get("/finance/suppliers/1/statement");
    expect(res.status).toBe(200);
    expect(res.body.poCount).toBe(2);
    expect(res.body.totals.due).toBe("1500");
    expect(res.body.totals.paid).toBe("400");
    expect(res.body.totals.remaining).toBe("1100");
    expect(res.body.supplier.hasBankDetails).toBe(true);
    // Per-row remaining is derived, not read from a stored column.
    expect(res.body.rows[0].remainingAmount).toBe("600");
  });

  it("reports a supplier with nothing outstanding without failing", async () => {
    state.supplierRows = [{ id: 1, name: "Alpha" }];
    state.existingRequestRows = [];
    const res = await request(buildApp()).get("/finance/suppliers/1/statement");
    expect(res.status).toBe(200);
    expect(res.body.poCount).toBe(0);
    expect(res.body.totals.remaining).toBe("0");
    expect(res.body.supplier.hasBankDetails).toBe(false);
  });

  it("404s an unknown supplier", async () => {
    state.supplierRows = [];
    const res = await request(buildApp()).get("/finance/suppliers/404/statement");
    expect(res.status).toBe(404);
  });

  it("streams the statement PDF and registers its number", async () => {
    seedStatement();
    const res = await request(buildApp()).get("/finance/suppliers/1/statement.pdf");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // The print run is recorded so the document handed to the supplier has a
    // reference number.
    const registered = state.inserted.find((i: any) => i.table === statementsTbl);
    expect(registered).toBeTruthy();
    expect(registered.values.statementNo).toMatch(/^STM-\d{4}-\d{6}$/);
    expect(registered.values.poCount).toBe(2);
  });

  it("still produces the PDF when the register write fails", async () => {
    seedStatement();
    // A derived document must not be withheld by a bookkeeping failure.
    const realInsert = dbMock.insert;
    dbMock.insert = vi.fn((table: any) => {
      if (table === statementsTbl) throw new Error("register unavailable");
      return realInsert(table);
    });
    try {
      const res = await request(buildApp()).get("/finance/suppliers/1/statement.pdf");
      expect(res.status).toBe(200);
      expect(res.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    } finally {
      dbMock.insert = realInsert;
    }
  });
});

describe("finance — payment numbering", () => {
  it("stamps a PAY number on a confirmed payment", async () => {
    state.requestRow = {
      id: 9,
      poId: 5,
      supplierId: 1,
      supplierName: "Alpha",
      internalPoNo: "PO-2026-000005",
      dueAmount: "1000",
      paidAmount: "0",
      status: "unpaid",
    };
    // An existing payment in the series forces the next number to advance.
    state.paymentRows = [{ id: 1, paymentNo: "PAY-2026-000041" }];

    const res = await request(buildApp())
      .post("/finance/requests/9/payments")
      .send({ amount: 400, paymentDate: "2026-11-03", method: "شيك" });

    expect(res.status).toBe(201);
    expect(res.body.paymentNo).toBe("PAY-2026-000042");
    const inserted = state.inserted.find((i: any) => i.table === paymentsTbl);
    expect(inserted.values.paymentNo).toBe("PAY-2026-000042");
    expect(res.body.payment.paymentNo).toBe("PAY-2026-000042");
  });
});

describe("finance — سداد إجمالي للمورد (bulk payment)", () => {
  // Three open orders for one supplier: 100 (oldest), 200, 300.
  function threeOpenOrders() {
    state.existingRequestRows = [
      {
        id: 11,
        poId: 1,
        supplierId: 7,
        supplierName: "Sinamix",
        internalPoNo: "PO-1",
        poNo: "P26E001",
        dueAmount: "100",
        paidAmount: "0",
        status: "unpaid",
        selectedAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: 12,
        poId: 2,
        supplierId: 7,
        supplierName: "Sinamix",
        internalPoNo: "PO-2",
        poNo: "P26E002",
        dueAmount: "200",
        paidAmount: "0",
        status: "unpaid",
        selectedAt: new Date("2026-01-02T00:00:00Z"),
      },
      {
        id: 13,
        poId: 3,
        supplierId: 7,
        supplierName: "Sinamix",
        internalPoNo: "PO-3",
        poNo: "P26E003",
        dueAmount: "300",
        paidAmount: "0",
        status: "unpaid",
        selectedAt: new Date("2026-01-03T00:00:00Z"),
      },
    ];
  }

  it("settles several orders with ONE document number", async () => {
    threeOpenOrders();

    const res = await request(buildApp())
      .post("/finance/suppliers/7/bulk-payment")
      .send({ amount: 250, paymentDate: "2026-11-03", method: "تحويل بنكي" });

    expect(res.status).toBe(201);
    // ONE number for the whole transfer — that is the point of the feature.
    expect(res.body.paymentNo).toMatch(/^PAY-2026-\d{6}$/);
    expect(res.body.orderCount).toBe(2);
    // FIFO: the oldest order cleared, the next took the remainder.
    expect(res.body.allocations).toEqual([
      { requestId: 11, internalPoNo: "PO-1", poNo: "P26E001", amount: "100" },
      { requestId: 12, internalPoNo: "PO-2", poNo: "P26E002", amount: "150" },
    ]);

    // The document row carries the number ONCE.
    const bulkInserts = state.inserted.filter((i: any) => i.table === bulkPaymentsTbl);
    expect(bulkInserts).toHaveLength(1);
    expect(bulkInserts[0].values.paymentNo).toBe(res.body.paymentNo);
    expect(bulkInserts[0].values.amount).toBe("250");
    expect(bulkInserts[0].values.orderCount).toBe(2);

    // The per-order rows must NOT reuse the number: `finance_payments` has a
    // UNIQUE index on payment_no, so writing it twice would fail the insert.
    const paymentInserts = state.inserted.filter((i: any) => i.table === paymentsTbl);
    expect(paymentInserts).toHaveLength(2);
    for (const p of paymentInserts) {
      expect(p.values.paymentNo).toBeNull();
    }
  });

  it("records one allocation per order and sums to the transfer", async () => {
    threeOpenOrders();

    await request(buildApp())
      .post("/finance/suppliers/7/bulk-payment")
      .send({ amount: 250, paymentDate: "2026-11-03", method: "شيك" });

    const allocs = state.inserted.filter((i: any) => i.table === allocationsTbl);
    expect(allocs).toHaveLength(2);
    const total = allocs.reduce((s: number, a: any) => s + Number(a.values.amount), 0);
    expect(total).toBe(250);
    // Each allocation points at the payment row it produced, so deleting that
    // payment also removes the line.
    for (const a of allocs) {
      expect(a.values.paymentId).toBeTruthy();
      expect(a.values.bulkPaymentId).toBeTruthy();
    }
  });

  it("settles the oldest order and leaves the newer ones open", async () => {
    threeOpenOrders();

    await request(buildApp())
      .post("/finance/suppliers/7/bulk-payment")
      .send({ amount: 100, paymentDate: "2026-11-03", method: "نقدية" });

    const updates = state.updated.filter((u: any) => u.table === requestsTbl);
    const byPaid = updates.map((u: any) => [u.values.paidAmount, u.values.status]);
    expect(byPaid).toContainEqual(["100", "paid"]);
    // Orders 12 and 13 were not touched at all — no phantom zero-payment rows.
    expect(updates).toHaveLength(1);
  });

  it("clears EVERY order when the total equals the outstanding balance", async () => {
    threeOpenOrders();

    const res = await request(buildApp())
      .post("/finance/suppliers/7/bulk-payment")
      .send({ amount: 600, paymentDate: "2026-11-03", method: "تحويل بنكي" });

    expect(res.status).toBe(201);
    expect(res.body.orderCount).toBe(3);
    const updates = state.updated.filter((u: any) => u.table === requestsTbl);
    expect(updates).toHaveLength(3);
    for (const u of updates) expect(u.values.status).toBe("paid");
  });

  it("refuses a total above what is outstanding instead of overpaying", async () => {
    threeOpenOrders();

    const res = await request(buildApp())
      .post("/finance/suppliers/7/bulk-payment")
      .send({ amount: 1000, paymentDate: "2026-11-03", method: "تحويل بنكي" });

    expect(res.status).toBe(400);
    expect(res.body.totalOutstanding).toBe("600");
    // Nothing was written — a refused payment must leave no trace.
    expect(state.inserted.filter((i: any) => i.table === bulkPaymentsTbl)).toHaveLength(0);
    expect(state.updated.filter((u: any) => u.table === requestsTbl)).toHaveLength(0);
  });

  it("refuses when the supplier has nothing outstanding", async () => {
    state.existingRequestRows = [
      {
        id: 11,
        supplierId: 7,
        supplierName: "Sinamix",
        dueAmount: "100",
        paidAmount: "100",
        status: "paid",
        selectedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ];

    const res = await request(buildApp())
      .post("/finance/suppliers/7/bulk-payment")
      .send({ amount: 50, paymentDate: "2026-11-03", method: "شيك" });

    expect(res.status).toBe(400);
  });

  it("refuses a non-positive amount", async () => {
    threeOpenOrders();

    const res = await request(buildApp())
      .post("/finance/suppliers/7/bulk-payment")
      .send({ amount: 0, paymentDate: "2026-11-03", method: "شيك" });

    expect(res.status).toBe(400);
  });

  it("requires the confirm permission, not just the select one", async () => {
    threeOpenOrders();
    state.confirmAllowed = false;

    const res = await request(buildApp())
      .post("/finance/suppliers/7/bulk-payment")
      .send({ amount: 100, paymentDate: "2026-11-03", method: "شيك" });

    expect(res.status).toBe(403);
    expect(state.inserted).toHaveLength(0);
  });

  it("syncs each per-order payment so the ledger bridge still sees them", async () => {
    threeOpenOrders();

    await request(buildApp())
      .post("/finance/suppliers/7/bulk-payment")
      .send({ amount: 600, paymentDate: "2026-11-03", method: "تحويل بنكي" });

    expect(state.syncSupplierPayment).toHaveBeenCalledTimes(3);
  });

  it("refuses to delete ONE line of a bulk document", async () => {
    // The transfer is one instruction: deleting a line would leave a printed
    // document claiming to have cleared an order it no longer did.
    state.paymentRows = [{ id: 55, requestId: 11, amount: "100", paymentDate: "2026-11-03" }];
    state.allocationRows = [
      { id: 1, bulkPaymentId: 77, paymentId: 55, requestId: 11, amount: "100" },
    ];

    const res = await request(buildApp()).delete("/finance/payments/55");

    expect(res.status).toBe(400);
    expect(res.body.bulkPaymentId).toBe(77);
    // Nothing was removed — the refusal must leave the document intact.
    expect(state.deleted.filter((d: any) => d.table === paymentsTbl)).toHaveLength(0);
  });

  it("still deletes a standalone payment", async () => {
    // The bulk guard must not block the ordinary path.
    state.paymentRows = [{ id: 56, requestId: 11, amount: "100", paymentDate: "2026-11-03" }];
    state.allocationRows = [];
    state.requestRow = {
      id: 11,
      supplierId: 7,
      supplierName: "Sinamix",
      dueAmount: "500",
      paidAmount: "100",
      status: "partial",
    };

    const res = await request(buildApp()).delete("/finance/payments/56");

    expect(res.status).toBe(200);
    expect(state.deleted.some((d: any) => d.table === paymentsTbl)).toBe(true);
  });

  it("reverses every order when the bulk document is deleted", async () => {
    state.bulkPaymentRows = [{ id: 77, paymentNo: "PAY-2026-000042", supplierName: "Sinamix" }];
    state.allocationRows = [
      { id: 1, bulkPaymentId: 77, paymentId: 55, requestId: 11, amount: "100" },
      { id: 2, bulkPaymentId: 77, paymentId: 56, requestId: 12, amount: "150" },
    ];
    state.requestRow = {
      id: 11,
      supplierId: 7,
      supplierName: "Sinamix",
      dueAmount: "100",
      paidAmount: "100",
      status: "paid",
    };

    const res = await request(buildApp()).delete("/finance/bulk-payments/77");

    expect(res.status).toBe(200);
    expect(res.body.ordersReversed).toBe(2);
    // Both per-order rows, the allocation lines and the document are removed.
    const deletedTables = state.deleted.map((d: any) => d.table);
    expect(deletedTables).toContain(paymentsTbl);
    expect(deletedTables).toContain(allocationsTbl);
    expect(deletedTables).toContain(bulkPaymentsTbl);
    // Both affected orders are recomputed back to unpaid.
    const updates = state.updated.filter((u: any) => u.table === requestsTbl);
    expect(updates.length).toBeGreaterThanOrEqual(2);
  });

  it("404s when the bulk document does not exist", async () => {
    state.bulkPaymentRows = [];
    const res = await request(buildApp()).delete("/finance/bulk-payments/999");
    expect(res.status).toBe(404);
  });

  it("previews the FIFO split before the operator commits", async () => {
    threeOpenOrders();

    const res = await request(buildApp()).get("/finance/suppliers/7/open-orders");

    expect(res.status).toBe(200);
    expect(res.body.totalOutstanding).toBe("600");
    // The preview must order by selection date and expose what each order owes,
    // so the dialog can show the split before any money is recorded.
    expect(res.body.orders.map((o: any) => o.requestId)).toEqual([11, 12, 13]);
    expect(res.body.orders[0].remainingAmount).toBe("100");
  });
});
