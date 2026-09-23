/**
 * `scan_emails` as the model sees it.
 *
 * `ai-email-census.test.ts` covers the scan itself. This file covers the layer
 * above — the argument wiring, the system-of-record reconciliation, and the CSV
 * handoff — because those are where a census answer silently goes wrong: a
 * comparison that reports nothing missing, or a "file" request that produces no
 * file, both read as a plausible answer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/test";

const scanEmails = vi.fn();
const searchEmails = vi.fn();

vi.mock("../../modules/ai-assistant/email", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanEmails,
  searchEmails,
  isEmailReadConfigured: () => true,
}));

/**
 * The PDF generator is spied, not run: its Arabic font is bundled into `dist/`
 * by the build, so it cannot be loaded from the source tree. Spying is also what
 * makes the assertion exact — it captures the comparison the report was built
 * from, which is the property under test.
 */
const generateMissingNumbersPdf = vi.fn(
  async (_comparison: {
    table: string;
    column: string;
    found: number;
    missing: Array<{ number: string; subject: string; date: string; mailbox: string }>;
  }) => Buffer.from("%PDF-fake"),
);
vi.mock("../../modules/ai-assistant/pdf", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  generateMissingNumbersPdf,
  generateAssistantPdf: vi.fn(async () => Buffer.from("%PDF-fake")),
}));

// The comparison reads a real table handle through the registry, so the db mock
// only needs `select().from().where().limit()` to resolve to the fixture rows.
let dbRows: Array<{ value: string }> = [];
const selectChain: any = {
  from: () => selectChain,
  where: () => selectChain,
  limit: () => Promise.resolve(dbRows),
};
vi.mock("@workspace/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  db: { select: () => selectChain },
}));

const { executeTool, toolDefinitions } = await import("../../modules/ai-assistant/tools");

/** A census result shaped like the real one, with two numbers missing. */
function census(overrides: Record<string, unknown> = {}) {
  return {
    matched: 1582,
    returned: 3,
    emails: [
      {
        uid: 1,
        mailbox: "info@cortoba-supplies.com",
        folder: "inbox",
        from: "noreply@egyptian-drilling.com",
        to: "info@cortoba-supplies.com",
        subject: "EDC RFQ No 26R011936",
        date: "2026-09-22T10:00:00Z",
        numbers: ["26R011936"],
      },
    ],
    byMailbox: { "info@cortoba-supplies.com": 1582 },
    byMonth: { "2026-04": 100, "2026-09": 1482 },
    bySender: [{ from: "noreply@egyptian-drilling.com", count: 1582 }],
    numbers: [
      {
        number: "26R011936",
        count: 1,
        sample: {
          uid: 1,
          mailbox: "info@cortoba-supplies.com",
          folder: "inbox",
          subject: "EDC RFQ No 26R011936",
          date: "2026-09-22T10:00:00Z",
        },
      },
    ],
    distinctNumbers: 1581,
    numbersTruncated: false,
    scope: {
      folder: "inbox",
      sinceDate: "2026-01-01T00:00:00.000Z",
      beforeDate: null,
      mailboxes: [{ mailbox: "info@cortoba-supplies.com", scanned: 3875, truncated: false }],
      scanned: 3875,
      truncated: false,
      elapsedMs: 4200,
    },
    note: "حصر كامل … العدد أعلاه إجمالي وليس عيّنة.",
    ...overrides,
  };
}

const ctx = {
  settings: { allowDatabase: true, allowEmail: true, allowPdf: true },
  outbox: [] as { filename: string; mimeType: string; buffer: Buffer }[],
} as never as {
  settings: Record<string, boolean>;
  outbox: { filename: string; mimeType: string; buffer: Buffer }[];
};

beforeEach(() => {
  vi.clearAllMocks();
  ctx.outbox.length = 0;
  dbRows = [];
  scanEmails.mockResolvedValue(census());
});

describe("scan_emails tool", () => {
  it("is offered to the model and documents itself as the census tool", () => {
    const defs = toolDefinitions(ctx as never);
    const def = defs.find((d) => d.function.name === "scan_emails");
    expect(def).toBeTruthy();
    // The model has to be able to tell it apart from search_emails, or it will
    // keep answering "how many" from a 30-row page.
    expect(def!.function.description).toContain("حصر");
    expect(def!.function.description).toContain("search_emails");
  });

  it("surfaces the exact total, coverage and a total-vs-lower-bound flag", async () => {
    const res = (await executeTool("scan_emails", { from: "egyptian-drilling" }, ctx as never)) as {
      ok: boolean;
      data: { matched: number; isTotal: boolean; distinctNumbers: number; note: string };
    };
    expect(res.ok).toBe(true);
    expect(res.data.matched).toBe(1582);
    expect(res.data.isTotal).toBe(true);
    expect(res.data.distinctNumbers).toBe(1581);
    expect(res.data.note).toContain("إجمالي");
  });

  it("marks a truncated scan as NOT a total so it cannot be reported as one", async () => {
    scanEmails.mockResolvedValue(
      census({
        scope: {
          folder: "inbox",
          sinceDate: null,
          beforeDate: null,
          mailboxes: [{ mailbox: "info@cortoba-supplies.com", scanned: 500, truncated: true }],
          scanned: 500,
          truncated: true,
          elapsedMs: 1000,
        },
        note: "… العدد أعلاه حدّ أدنى وليس الإجمالي …",
      }),
    );
    const res = (await executeTool("scan_emails", {}, ctx as never)) as {
      data: { isTotal: boolean; note: string };
    };
    expect(res.data.isTotal).toBe(false);
    expect(res.data.note).toContain("حدّ أدنى");
  });

  it("passes the date range and mailbox through to the scan", async () => {
    await executeTool(
      "scan_emails",
      {
        from: "egyptian-drilling",
        sinceDate: "2026-01-01",
        beforeDate: "2026-04-01",
        mailbox: "info@cortoba-supplies.com",
        limit: 50,
      },
      ctx as never,
    );
    expect(scanEmails).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "egyptian-drilling",
        sinceDate: "2026-01-01",
        beforeDate: "2026-04-01",
        mailbox: "info@cortoba-supplies.com",
        limit: 50,
      }),
    );
  });

  it("reconciles email numbers against the system and returns only the missing ones", async () => {
    // The system has one of the two numbers seen in email.
    dbRows = [{ value: "26R011936" }];
    let callbackResult: { found: number; missingNumbers: string[] } | undefined;
    scanEmails.mockImplementation(async (opts: any) => {
      callbackResult = await opts.compare(["26R011936", "26R011937"], opts.compareTarget);
      return census({
        compare: {
          table: opts.compareTarget.table,
          column: opts.compareTarget.column,
          found: callbackResult!.found,
          missing: callbackResult!.missingNumbers.map((n: string) => ({ number: n })),
          matchedSample: [],
        },
      });
    });

    const res = (await executeTool(
      "scan_emails",
      { compareTable: "customer_rfqs", compareColumn: "customerRfqNo" },
      ctx as never,
    )) as {
      data: {
        comparison: { found: number; missing: { number: string }[]; table: string; column: string };
      };
    };
    // The comparison is a set difference against the system of record.
    expect(callbackResult!.found).toBe(1);
    expect(callbackResult!.missingNumbers).toEqual(["26R011937"]);
    // …and it reaches the model as `comparison`.
    expect(res.data.comparison.table).toBe("customer_rfqs");
    expect(res.data.comparison.column).toBe("customerRfqNo");
    expect(res.data.comparison.missing.map((m) => m.number)).toEqual(["26R011937"]);
  });

  it("treats a number the system has in a different case as present", async () => {
    dbRows = [{ value: "26r011936" }];
    let callbackResult: { missingNumbers: string[] } | undefined;
    scanEmails.mockImplementation(async (opts: any) => {
      callbackResult = await opts.compare(["26R011936"], opts.compareTarget);
      return census();
    });
    await executeTool(
      "scan_emails",
      { compareTable: "customer_rfqs", compareColumn: "customerRfqNo" },
      ctx as never,
    );
    // A case/space difference must not be reported as a missing record.
    expect(callbackResult!.missingNumbers).toEqual([]);
  });

  it("rejects a comparison column that does not exist on the table", async () => {
    scanEmails.mockImplementation(async (opts: any) => {
      await opts.compare(["26R011936"], opts.compareTarget);
      return census();
    });
    const res = (await executeTool(
      "scan_emails",
      { compareTable: "customer_rfqs", compareColumn: "notAColumn" },
      ctx as never,
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("notAColumn");
  });

  it("chunks a very large comparison so one oversized IN cannot fail it", async () => {
    // A year-long census yields thousands of numbers; Postgres caps a statement
    // at 65,535 bind parameters, so the reconciliation must split the IN.
    const big = Array.from({ length: 12_000 }, (_, i) => `26R${String(i).padStart(6, "0")}`);
    let callbackResult: { found: number; missingNumbers: string[] } | undefined;
    scanEmails.mockImplementation(async (opts: any) => {
      callbackResult = await opts.compare(big, opts.compareTarget);
      return census();
    });
    dbRows = [];
    await executeTool(
      "scan_emails",
      { compareTable: "customer_rfqs", compareColumn: "customerRfqNo" },
      ctx as never,
    );
    // Every number is missing, and none was lost to a failed statement.
    expect(callbackResult!.missingNumbers).toHaveLength(12_000);
  });

  it("does not compare when no target table is given", async () => {
    await executeTool("scan_emails", {}, ctx as never);
    const passed = scanEmails.mock.calls[0][0];
    expect(passed.compare).toBeUndefined();
    expect(passed.compareTarget).toBeUndefined();
  });

  it("sends the full census as a CSV when the operator asks for a file", async () => {
    const res = (await executeTool("scan_emails", { exportCsv: true }, ctx as never)) as {
      data: { csvSent: boolean };
    };
    expect(res.data.csvSent).toBe(true);
    expect(ctx.outbox).toHaveLength(1);
    // WhatsApp rejects text/csv at upload (#100), losing the file silently.
    expect(ctx.outbox[0].mimeType).toBe("text/plain");
    expect(ctx.outbox[0].filename).toMatch(/^email-census-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(ctx.outbox[0].buffer.toString("utf8")).toContain("26R011936");
  });

  it("sends no file when none was requested", async () => {
    await executeTool("scan_emails", {}, ctx as never);
    expect(ctx.outbox).toHaveLength(0);
  });

  it("builds the missing-numbers PDF from the FULL comparison, not a model sample", async () => {
    // The regression this pins: `generate_pdf` receives whatever rows the model
    // passes it, and the model's payload is truncated by `asText` — the report
    // came out with only the first few numbers. Building it here means the PDF
    // carries every missing number however long the list is.
    const missing = Array.from({ length: 137 }, (_, i) => ({
      number: `26R0119${String(i).padStart(2, "0")}`,
      subject: `EDC RFQ No 26R0119${String(i).padStart(2, "0")}`,
      date: "2026-09-22T10:00:00Z",
      mailbox: "info@cortoba-supplies.com",
    }));
    scanEmails.mockResolvedValue(
      census({
        compare: {
          table: "customer_rfqs",
          column: "customerRfqNo",
          found: 1444,
          missing,
          matchedSample: [],
        },
      }),
    );

    const res = (await executeTool(
      "scan_emails",
      { compareTable: "customer_rfqs", compareColumn: "customerRfqNo", exportPdf: true },
      ctx as never,
    )) as { ok: boolean; data: { pdfSent: boolean; comparison: { missing: unknown[] } } };

    expect(res.ok).toBe(true);
    expect(res.data.pdfSent).toBe(true);
    expect(ctx.outbox).toHaveLength(1);
    expect(ctx.outbox[0].mimeType).toBe("application/pdf");
    expect(ctx.outbox[0].filename).toMatch(/^missing-numbers-\d{4}-\d{2}-\d{2}\.pdf$/);
    // The report was built from EVERY missing number, not a capped sample.
    expect(generateMissingNumbersPdf).toHaveBeenCalledTimes(1);
    expect(generateMissingNumbersPdf.mock.calls[0][0].missing).toHaveLength(137);
    expect(res.data.comparison.missing).toHaveLength(137);
  });

  it("refuses exportPdf without a comparison rather than emitting an empty report", async () => {
    const res = (await executeTool("scan_emails", { exportPdf: true }, ctx as never)) as {
      ok: boolean;
      error?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("compareTable");
    expect(ctx.outbox).toHaveLength(0);
  });

  it("passes includeAttachments through to the scan", async () => {
    await executeTool("scan_emails", { includeAttachments: true }, ctx as never);
    expect(scanEmails).toHaveBeenCalledWith(expect.objectContaining({ includeAttachments: true }));
  });

  it("refuses when email access is disabled", async () => {
    const off = {
      settings: { allowDatabase: true, allowEmail: false, allowPdf: true },
      outbox: [],
    } as never;
    const res = (await executeTool("scan_emails", {}, off)) as { ok: boolean };
    expect(res.ok).toBe(false);
  });
});
