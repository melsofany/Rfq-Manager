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
    requestRow: null as any,
    inserted: [] as any[],
    updated: [] as any[],
    deleted: [] as any[],
    syncSupplierPayment: null as any,
    confirmAllowed: true,
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
        const result = rows.map((v: any, i: number) => ({
          id: 100 + i,
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
  state.requestRow = null;
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
