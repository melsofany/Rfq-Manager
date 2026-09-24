/**
 * Tool-level wiring for the DB aggregate report.
 *
 * `ai-sql-aggregate.test.ts` pins the aggregation itself. This file pins the
 * three things around it that the live incident exposed:
 *
 *  1. The tool result carries the completeness signal (`isComplete`) and the
 *     real row counts, so the model cannot present a cut list as the whole set.
 *  2. `start_census_job` refuses BEFORE creating an `email_census` row when mail
 *     reading is not configured — the operator asked a DATABASE question, was
 *     told an email census had run, and received «0 messages».
 *  3. The data tool reports its figures on the run trace, so a summary claiming
 *     «كل الأصناف» can be checked against what the tool actually returned.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
const { fixtures } = vi.hoisted(() => ({ fixtures: {} as Record<string, unknown[]> }));

function builder(table: { _: string }) {
  const b: any = {
    where: () => b,
    orderBy: () => b,
    limit: () => Promise.resolve(fixtures[table._] ?? []),
  };
  return b;
}

vi.mock("@workspace/db", () => {
  const db = { select: () => ({ from: (t: { _: string }) => builder(t) }) };
  const cache: Record<string, any> = { db, getPool: () => ({ query: queryMock }) };
  return new Proxy(cache, {
    get(t, prop: string) {
      if (prop === "then") return undefined;
      if (prop === "default") return t;
      if (!t[prop]) t[prop] = prop === "db" ? db : { _: prop };
      return t[prop];
    },
  });
});

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  or: (...a: unknown[]) => ({ or: a }),
  eq: (...a: unknown[]) => ({ eq: a }),
  ne: (...a: unknown[]) => ({ ne: a }),
  ilike: (...a: unknown[]) => ({ ilike: a }),
  inArray: (...a: unknown[]) => ({ inArray: a }),
  isNotNull: (...a: unknown[]) => ({ isNotNull: a }),
  isNull: (...a: unknown[]) => ({ isNull: a }),
  desc: (...a: unknown[]) => ({ desc: a }),
  sql: Object.assign((..._a: unknown[]) => ({ sql: true }), { join: () => ({}) }),
}));

vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Email reading is deliberately left UNCONFIGURED here (no IMAP vars), which is
// the condition the census guard must detect.
vi.mock("../../modules/ai-assistant/email", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, isEmailReadConfigured: () => false, normalizeText: (s: string) => s };
});

beforeEach(() => {
  queryMock.mockReset();
  for (const k of Object.keys(fixtures)) delete fixtures[k];
});

function ctxWithTrace(settings: Record<string, unknown> = {}) {
  const traced: Array<Record<string, unknown>> = [];
  return {
    traced,
    ctx: {
      settings: { allowDatabase: true, allowEmail: true, allowPdf: true, ...settings },
      outbox: [],
      phone: "x",
      trace: (s: Record<string, unknown>) => traced.push(s),
    } as any,
  };
}

describe("aggregate_customer_po_items tool", () => {
  it("returns every product with an explicit completeness signal", async () => {
    queryMock.mockResolvedValue({
      rows: Array.from({ length: 300 }, (_, i) => ({
        description: `PUMP ${i}`,
        part_no: `P${i}`,
        uom: "PC",
        total_qty: i + 1,
        occurrences: 1,
      })),
    });
    const { executeTool } = await import("../../modules/ai-assistant/tools");
    const { ctx } = ctxWithTrace();

    const res = (await executeTool("aggregate_customer_po_items", {}, ctx)) as any;

    expect(res.ok).toBe(true);
    // The COUNT is the real total — this is what the reply must quote. The rows
    // in the payload are only a display window, because 300 rows cannot survive
    // a model's own output limit (the live truncation).
    expect(res.data.count).toBe(300);
    expect(res.data.sourceRows).toBe(300);
    expect(res.data.isComplete).toBe(true);
    expect(res.data.rows.length).toBeLessThanOrEqual(50);
  });

  it("warns the model the payload rows are only a window", async () => {
    queryMock.mockResolvedValue({
      rows: Array.from({ length: 120 }, (_, i) => ({
        description: `ITEM ${i}`,
        part_no: `${i}`,
        uom: "PC",
        total_qty: 1,
        occurrences: 1,
      })),
    });
    const { executeTool } = await import("../../modules/ai-assistant/tools");
    const { ctx } = ctxWithTrace();

    const res = (await executeTool("aggregate_customer_po_items", {}, ctx)) as any;

    expect(res.data.count).toBe(120);
    expect(res.data.rowsReturned).toBe(50);
    // Without this the model would describe 50 of 120 and call it complete.
    expect(res.data.note).toContain("أول 50");
  });

  it("records its real figures on the run trace", async () => {
    queryMock.mockResolvedValue({
      rows: [
        { description: "A", part_no: "1", uom: "PC", total_qty: 5, occurrences: 7 },
        { description: "B", part_no: "2", uom: "PC", total_qty: 3, occurrences: 2 },
      ],
    });
    const { executeTool } = await import("../../modules/ai-assistant/tools");
    const { ctx, traced } = ctxWithTrace();

    await executeTool("aggregate_customer_po_items", {}, ctx);

    expect(traced).toHaveLength(1);
    expect(traced[0]).toMatchObject({
      tool: "aggregate_customer_po_items",
      sourceRows: 9,
      products: 2,
      truncated: false,
    });
  });

  it("builds the CSV file on the server from every row, not a sample", async () => {
    queryMock.mockResolvedValue({
      rows: Array.from({ length: 260 }, (_, i) => ({
        description: `ITEM ${i}`,
        part_no: `P${i}`,
        uom: "PC",
        total_qty: i + 1,
        occurrences: 1,
      })),
    });
    const { executeTool } = await import("../../modules/ai-assistant/tools");
    const { ctx } = ctxWithTrace();

    const res = (await executeTool("aggregate_customer_po_items", { exportCsv: true }, ctx)) as any;

    expect(res.data.csvSent).toBe(true);
    expect(ctx.outbox).toHaveLength(1);
    // Every product is in the FILE even though the model only saw 50.
    const csv = ctx.outbox[0].buffer.toString("utf8");
    expect(csv).toContain("ITEM 259");
    expect(csv.trim().split("\n")).toHaveLength(261); // header + 260 items
  });

  it("builds a PDF from every row and prints the operator's prompt", async () => {
    queryMock.mockResolvedValue({
      rows: Array.from({ length: 200 }, (_, i) => ({
        description: `ITEM ${i}`,
        part_no: `P${i}`,
        uom: "PC",
        total_qty: i + 1,
        occurrences: 1,
      })),
    });
    const generate = vi.fn().mockResolvedValue(Buffer.from("pdf"));
    vi.doMock("../../modules/ai-assistant/pdf", () => ({
      generateAssistantPdf: generate,
      pdfSectionColumns: () => [],
      generateMissingNumbersPdf: vi.fn(),
    }));
    vi.resetModules();

    const { executeTool } = await import("../../modules/ai-assistant/tools");
    const { ctx } = ctxWithTrace();

    const prompt = "تقرير بكل الأصناف المورَّدة 2025 و2026 بدون أسعار وبدون أرقام أوامر";
    const res = (await executeTool(
      "aggregate_customer_po_items",
      { exportPdf: true, source: prompt },
      ctx,
    )) as any;

    expect(res.data.pdfSent).toBe(true);
    const opts = generate.mock.calls[0][0];
    // The full 200 rows reached the PDF — not the 50-row model window.
    expect(opts.sections[1].table.rows).toHaveLength(200);
    expect(opts.source).toBe(prompt);
    expect(ctx.outbox[0].mimeType).toBe("application/pdf");
    vi.doUnmock("../../modules/ai-assistant/pdf");
  });
  it("is refused when database access is disabled", async () => {
    const { executeTool } = await import("../../modules/ai-assistant/tools");
    const { ctx } = ctxWithTrace({ allowDatabase: false });
    const res = (await executeTool("aggregate_customer_po_items", {}, ctx)) as any;
    expect(res.ok).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("start_census_job — never a misleading email census", () => {
  it("refuses before creating a job when mail reading is unconfigured", async () => {
    const { executeTool } = await import("../../modules/ai-assistant/tools");
    const { ctx } = ctxWithTrace();

    const res = (await executeTool("start_census_job", { question: "حصر" }, ctx)) as any;

    expect(res.ok).toBe(false);
    // The error must point at the RIGHT source, because the operator's real
    // question was answerable from `customer_po_items` all along.
    expect(res.error).toContain("aggregate_customer_po_items");
    // No job row was created — no «انتهى الحصر» report for a scan that never ran.
    expect(fixtures["aiAssistantJobsTable"] ?? []).toEqual([]);
  });
});
