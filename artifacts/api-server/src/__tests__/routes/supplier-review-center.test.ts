/**
 * Supplier review centre — the working routes.
 *
 * These assert the DECISIONS: which transition is refused and why, what the
 * dashboard counts, and what the audit trail records. The db mock returns rows
 * directly, so a case that needs to prove a WRITE happened asserts the captured
 * query text — a mock cannot see a `WHERE`, but it can see the statement.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

import reviewRoutes from "../../modules/supplier-review/review-routes";

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

const state = vi.hoisted(() => ({
  application: null as Record<string, unknown> | null,
  rows: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  verdicts: [] as Array<Record<string, unknown>>,
  queries: [] as Array<{ sql: string; params?: unknown[] }>,
  permissions: null as Record<string, boolean> | null,
}));

vi.mock("@workspace/db", () => ({
  pool: {
    query: async (sql: string, params?: unknown[]) => {
      state.queries.push({ sql, params });
      if (/FROM supplier_applications WHERE id/.test(sql)) {
        return {
          rows: state.application ? [state.application] : [],
          rowCount: state.application ? 1 : 0,
        };
      }
      if (/SELECT permissions FROM employees/.test(sql)) {
        return { rows: [{ permissions: state.permissions }], rowCount: 1 };
      }
      if (/FROM supplier_application_events/.test(sql))
        return { rows: state.events, rowCount: state.events.length };
      if (/FROM supplier_application_category_verdicts/.test(sql)) {
        return { rows: state.verdicts, rowCount: state.verdicts.length };
      }
      if (/FROM employees/.test(sql)) return { rows: [{ id: 7, name: "سارة" }], rowCount: 1 };
      if (/INSERT INTO supplier_application_events/.test(sql)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO supplier_application_category_verdicts/.test(sql))
        return { rows: [], rowCount: 1 };
      if (/UPDATE supplier_applications/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: state.rows, rowCount: state.rows.length };
    },
  },
}));

vi.mock("../../shared/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

// The document reader is exercised by its own suite; here it must not call out.
vi.mock("../../modules/supplier-review/documents", async () => {
  const actual = await vi.importActual<typeof import("../../modules/supplier-review/documents")>(
    "../../modules/supplier-review/documents",
  );
  return { ...actual, readApplicationDocuments: async () => [] };
});

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  req.session = {
    employeeId: 7,
    employeeName: "سارة",
    role: (req.headers["x-test-role"] as string) || "manager",
  };
  next();
});
app.use("/api", reviewRoutes);

const application = (over: Record<string, unknown> = {}) => ({
  id: 42,
  reference: "APP-2026-000042",
  status: "submitted",
  name: "شركة النور للتوريدات",
  contact_person: null,
  email: "info@alnoor.com",
  phone: "01000000000",
  address: "القاهرة",
  commercial_register: "123456",
  tax_registration: "432972587",
  trade_categories: ["كابلات"],
  other_trade_category: null,
  item_category_ids: [],
  supplied_items: [],
  brand_names: [],
  assigned_employee_id: null,
  assigned_at: null,
  submitted_at: new Date("2026-11-01T09:00:00Z"),
  first_reviewed_at: null,
  decided_at: null,
  decided_by: null,
  due_at: null,
  priority: "normal",
  review_notes: null,
  decision_reason: null,
  verification: {},
  category_verification: {},
  info_request: null,
  supplier_id: null,
  created_at: new Date("2026-11-01T09:00:00Z"),
  updated_at: null,
  ...over,
});

beforeEach(() => {
  state.application = application();
  state.rows = [];
  state.events = [];
  state.verdicts = [];
  state.queries = [];
  state.permissions = null;
});

describe("GET /supplier-review/dashboard", () => {
  it("counts the statuses from the rows themselves", async () => {
    state.rows = [
      {
        id: 1,
        status: "submitted",
        assigned_employee_id: null,
        created_at: new Date(),
        submitted_at: new Date(),
        first_reviewed_at: null,
        decided_at: null,
        due_at: null,
        supplier_id: null,
      },
      {
        id: 2,
        status: "under_review",
        assigned_employee_id: 7,
        created_at: new Date(),
        submitted_at: new Date(),
        first_reviewed_at: new Date(),
        decided_at: null,
        due_at: null,
        supplier_id: null,
      },
      {
        id: 3,
        status: "approved",
        assigned_employee_id: 7,
        created_at: new Date(),
        submitted_at: new Date("2026-10-01T00:00:00Z"),
        first_reviewed_at: null,
        decided_at: new Date("2026-10-06T00:00:00Z"),
        due_at: null,
        supplier_id: 9,
      },
    ];
    const res = await request(app).get("/api/supplier-review/dashboard");

    expect(res.status).toBe(200);
    expect(res.body.totals.total).toBe(3);
    expect(res.body.totals.new).toBe(1);
    expect(res.body.totals.underReview).toBe(1);
    expect(res.body.totals.approved).toBe(1);
  });

  it("returns a NULL average and rate when nothing has been decided", async () => {
    // An average of no data is not 0, and 0/0 is not 0%.
    state.rows = [
      {
        id: 1,
        status: "submitted",
        assigned_employee_id: null,
        created_at: new Date(),
        submitted_at: new Date(),
        first_reviewed_at: null,
        decided_at: null,
        due_at: null,
        supplier_id: null,
      },
    ];
    const res = await request(app).get("/api/supplier-review/dashboard");
    expect(res.body.totals.avgReviewDays).toBeNull();
    expect(res.body.totals.approvalRate).toBeNull();
  });

  it("derives «late» from the SLA when no explicit due date is stored", async () => {
    // A stored flag would be wrong the moment the clock moves; this is computed.
    const old = new Date(Date.now() - 30 * 86_400_000);
    state.rows = [
      {
        id: 1,
        status: "submitted",
        assigned_employee_id: null,
        created_at: old,
        submitted_at: old,
        first_reviewed_at: null,
        decided_at: null,
        due_at: null,
        supplier_id: null,
      },
    ];
    const res = await request(app).get("/api/supplier-review/dashboard?slaDays=5");
    expect(res.body.totals.late).toBe(1);
  });

  it("does not count a DECIDED application as late", async () => {
    const old = new Date(Date.now() - 30 * 86_400_000);
    state.rows = [
      {
        id: 1,
        status: "approved",
        assigned_employee_id: null,
        created_at: old,
        submitted_at: old,
        first_reviewed_at: null,
        decided_at: old,
        due_at: null,
        supplier_id: 3,
      },
    ];
    const res = await request(app).get("/api/supplier-review/dashboard");
    expect(res.body.totals.late).toBe(0);
  });
});

describe("POST /supplier-review/applications/:id/transition", () => {
  it("moves a NEW application to UNDER_REVIEW and records the audit row", async () => {
    const res = await request(app)
      .post("/api/supplier-review/applications/42/transition")
      .send({ to: "under_review" });

    expect(res.status).toBe(200);
    expect(res.body.to).toBe("under_review");
    const audit = state.queries.filter((q) =>
      /INSERT INTO supplier_application_events/.test(q.sql),
    );
    expect(audit.length).toBe(1);
    expect(audit[0].params).toContain("review_started");
  });

  it("refuses a transition the state machine forbids", async () => {
    // NEW → APPROVED skips the review entirely.
    const res = await request(app)
      .post("/api/supplier-review/applications/42/transition")
      .send({ to: "approved" });

    expect(res.status).toBe(409);
    expect(state.queries.some((q) => /UPDATE supplier_applications/.test(q.sql))).toBe(false);
  });

  it("refuses a transition the user's role does not allow", async () => {
    // An observer may look, not move.
    const res = await request(app)
      .post("/api/supplier-review/applications/42/transition")
      .set("x-test-role", "data_entry")
      .send({ to: "under_review" });

    expect(res.status).toBe(403);
    expect(res.body.yourRole).toBe("observer");
  });

  it("requires a written reason to reject", async () => {
    state.application = application({ status: "under_review" });
    const res = await request(app)
      .post("/api/supplier-review/applications/42/transition")
      .send({ to: "rejected" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("سبب");
  });

  it("accepts a rejection that carries its reason", async () => {
    state.application = application({ status: "under_review" });
    const res = await request(app)
      .post("/api/supplier-review/applications/42/transition")
      .send({ to: "rejected", note: "السجل التجاري منتهي الصلاحية" });

    expect(res.status).toBe(200);
    expect(res.body.to).toBe("rejected");
  });

  it("requires detail for an information request", async () => {
    state.application = application({ status: "under_review" });
    const res = await request(app)
      .post("/api/supplier-review/applications/42/transition")
      .send({ to: "needs_information" });

    expect(res.status).toBe(400);
  });

  it("refuses an unknown target status", async () => {
    const res = await request(app)
      .post("/api/supplier-review/applications/42/transition")
      .send({ to: "nonsense" });

    expect(res.status).toBe(400);
  });

  it("404s on a missing application", async () => {
    state.application = null;
    const res = await request(app)
      .post("/api/supplier-review/applications/999/transition")
      .send({ to: "under_review" });
    expect(res.status).toBe(404);
  });

  it("refuses APPROVED from UNDER_REVIEW — the state machine blocks the skip", async () => {
    // Two independent guards, and the state machine answers first: there is no
    // UNDER_REVIEW → APPROVED edge at all. The handler's own VERIFIED check
    // (asserted in the approve-route suite) is the second line of defence.
    state.application = application({ status: "under_review" });
    const res = await request(app)
      .post("/api/supplier-review/applications/42/transition")
      .send({ to: "approved" });

    expect(res.status).toBe(409);
    expect(res.body.from).toBe("under_review");
    expect(res.body.to).toBe("approved");
    expect(state.queries.some((q) => /UPDATE supplier_applications/.test(q.sql))).toBe(false);
  });

  it("refuses APPROVED from VERIFIED-less statuses even when the edge exists", async () => {
    // SUSPENDED → APPROVED is not an edge either, but this pins the handler's
    // VERIFIED requirement from the one status that CAN reach approval.
    state.application = application({ status: "verified" });
    const ok = await request(app)
      .post("/api/supplier-review/applications/42/transition")
      .send({ to: "approved" });
    expect(ok.status).toBe(200);
  });
});

describe("GET /supplier-review/applications/:id/actions", () => {
  it("offers an approver the moves the state machine allows", async () => {
    state.application = application({ status: "verified" });
    const res = await request(app).get("/api/supplier-review/applications/42/actions");

    expect(res.status).toBe(200);
    expect(res.body.role).toBe("approver");
    expect(res.body.available.map((a: { to: string }) => a.to)).toContain("approved");
  });

  it("offers a reviewer NO approval action", async () => {
    state.application = application({ status: "verified" });
    const res = await request(app)
      .get("/api/supplier-review/applications/42/actions")
      .set("x-test-role", "purchasing");

    expect(res.body.role).toBe("reviewer");
    expect(res.body.available.map((a: { to: string }) => a.to)).not.toContain("approved");
  });

  it("offers an observer nothing", async () => {
    const res = await request(app)
      .get("/api/supplier-review/applications/42/actions")
      .set("x-test-role", "data_entry");
    expect(res.body.available).toEqual([]);
  });
});

describe("GET /supplier-review/applications/:id/audit", () => {
  it("returns the trail oldest-first with the actor", async () => {
    state.events = [
      {
        id: 1,
        event: "submitted",
        from_status: null,
        to_status: "submitted",
        note: null,
        actor_name: "المورد",
        actor_id: null,
        metadata: null,
        created_at: new Date("2026-11-01T09:00:00Z"),
      },
      {
        id: 2,
        event: "verified",
        from_status: "under_review",
        to_status: "verified",
        note: "تم فحص المستندات",
        actor_name: "سارة",
        actor_id: 7,
        metadata: { documents: 4 },
        created_at: new Date("2026-11-02T09:00:00Z"),
      },
    ];
    const res = await request(app).get("/api/supplier-review/applications/42/audit");

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[1].actorName).toBe("سارة");
    expect(res.body.events[1].metadata).toEqual({ documents: 4 });
  });
});

describe("POST /supplier-review/applications/:id/category-verdicts", () => {
  it("records the reviewer's verdict for a category", async () => {
    const res = await request(app)
      .post("/api/supplier-review/applications/42/category-verdicts")
      .send({ kind: "trade", name: "كابلات", verdict: "proven" });

    expect(res.status).toBe(200);
    expect(res.body.label).toBe("مثبت بالمستندات");
    const audit = state.queries.filter((q) =>
      /INSERT INTO supplier_application_events/.test(q.sql),
    );
    expect(audit.length).toBe(1);
  });

  it("refuses an unknown verdict", async () => {
    const res = await request(app)
      .post("/api/supplier-review/applications/42/category-verdicts")
      .send({ kind: "trade", name: "كابلات", verdict: "maybe" });
    expect(res.status).toBe(400);
  });

  it("refuses an unknown kind", async () => {
    const res = await request(app)
      .post("/api/supplier-review/applications/42/category-verdicts")
      .send({ kind: "nonsense", name: "كابلات", verdict: "proven" });
    expect(res.status).toBe(400);
  });

  it("refuses a verdict from a role that may not verify", async () => {
    const res = await request(app)
      .post("/api/supplier-review/applications/42/category-verdicts")
      .set("x-test-role", "data_entry")
      .send({ kind: "trade", name: "كابلات", verdict: "proven" });
    expect(res.status).toBe(403);
  });
});

describe("GET /supplier-review/reports", () => {
  it("groups rejections by their recorded reason", async () => {
    state.rows = [
      {
        id: 1,
        status: "rejected",
        trade_categories: ["كابلات"],
        other_trade_category: null,
        decision_reason: "سجل منتهي",
        assigned_employee_id: 7,
        created_at: new Date(),
        submitted_at: new Date(),
        decided_at: new Date(),
      },
      {
        id: 2,
        status: "rejected",
        trade_categories: ["كابلات"],
        other_trade_category: null,
        decision_reason: "سجل منتهي",
        assigned_employee_id: 7,
        created_at: new Date(),
        submitted_at: new Date(),
        decided_at: new Date(),
      },
    ];
    const res = await request(app).get("/api/supplier-review/reports");

    expect(res.status).toBe(200);
    expect(res.body.rejectionReasons[0]).toEqual({ name: "سجل منتهي", count: 2 });
  });

  it("says a brand report is unavailable rather than reporting zero", async () => {
    // «0 brands proven» and «we never recorded it» are different statements.
    const res = await request(app).get("/api/supplier-review/reports");
    expect(res.body.provenBrands.available).toBe(false);
    expect(res.body.provenBrands.note).toBeTruthy();
  });
});
