/**
 * Organization learning, wired as the model sees it.
 *
 * The operator's live report was that the assistant did not know EDC: it did not
 * know the name, it did not know that their RFQ numbers are `26R…` and their PO
 * numbers are `P26E…`, and it did not learn any of it from the mail it reads or
 * from what the operator tells it. The inference itself is pinned in
 * `ai-org-profiles.test.ts`; THIS file pins the WIRING — that the teaching tool,
 * the classification tool and the analysis-from-mail path actually reach the
 * store, and that a repeated batch does not become a repeated write.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/test";

// ── In-memory profile store, standing in for `ai_assistant_org_profiles` ─────
interface Row {
  id: number;
  slug: string;
  aliases: string[];
  domains: string[];
  mailboxes: string[];
  documentFormats: Array<{
    kind: string;
    pattern: string;
    example: string;
    evidence: number;
    meaning?: string;
  }>;
  notes: string | null;
  confidence: number;
  evidenceCount: number;
  sources: string[];
  updatedAt: Date;
}

let rows: Row[] = [];
let nextId = 1;
const writes: Row[] = [];

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const table = { _: "aiOrgProfiles", slug: "slug", updatedAt: "updatedAt", id: "id" };
  return {
    ...actual,
    aiAssistantOrgProfilesTable: table,
    db: {
      select: () => ({
        from: () => ({
          orderBy: () => Promise.resolve(rows.map((r) => ({ ...r }))),
        }),
      }),
      insert: () => ({
        values: (v: Partial<Row>) => ({
          onConflictDoUpdate: ({ set }: { set: Partial<Row> }) => {
            const existing = rows.find((r) => r.slug === v.slug);
            const merged = {
              ...(existing ?? { id: nextId++, updatedAt: new Date() }),
              ...v,
              ...set,
            } as Row;
            if (existing) rows = rows.map((r) => (r.slug === v.slug ? merged : r));
            else rows.push(merged);
            writes.push({ ...merged });
            return Promise.resolve([merged]);
          },
        }),
      }),
    },
  };
});

vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  eq: (left: any, right: any) => ({ __op: "eq", left, right }),
}));

// The tool module imports the whole mail/PDF stack; none of it is exercised here.
vi.mock("../../modules/ai-assistant/email", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isEmailReadConfigured: () => true,
}));

import {
  executeTool,
  learnProfilesFromMail,
  resetMailLearning,
  type ToolContext,
} from "../../modules/ai-assistant/tools";
import {
  resetOrgProfilesCache,
  loadOrgProfiles,
  classifyByProfiles,
} from "../../modules/ai-assistant/org-profiles";

const settings = {
  enabled: true,
  model: "test",
  baseUrl: null,
  systemPrompt: null,
  language: "ar",
  allowDatabase: true,
  allowEmail: true,
  allowPdf: true,
  allowSendEmail: false,
  conversationState: true,
} as unknown as ToolContext["settings"];

const ctx: ToolContext = { settings, phone: "20100000000", outbox: [] };

beforeEach(() => {
  rows = [];
  writes.length = 0;
  nextId = 1;
  resetOrgProfilesCache();
});

describe("learn_organization (teaching from the user)", () => {
  it("derives the EDC PO format from two examples and stores it", async () => {
    const res = await executeTool(
      "learn_organization",
      {
        name: "EDC",
        aliases: ["Egyptian Drilling Company", "شركة الحفر المصرية"],
        domains: ["edc-egypt.com"],
        mailboxes: ["info"],
        examples: [
          { number: "P26E11407", kind: "po" },
          { number: "P26E14630", kind: "po" },
        ],
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    const data = res.data as { documentFormats: Array<{ pattern: string; kind: string }> };
    const poPattern = data.documentFormats.find((f) => f.kind === "po");
    expect(poPattern?.pattern).toMatch(/^\^P/);
    // The pattern must be a REAL generalisation, not the literal examples: a PO
    // number never shown to it has to match.
    expect(poPattern?.pattern?.replace(/^\^|\$$/g, "")).not.toContain("11407");
    expect(rows).toHaveLength(1);
    expect(rows[0].aliases).toContain("Egyptian Drilling Company");
    expect(rows[0].mailboxes).toContain("info");
  });

  it("learns a number it has never seen once the format is taught", async () => {
    await executeTool(
      "learn_organization",
      { name: "EDC", examples: [{ number: "26R011936", kind: "rfq" }] },
      ctx,
    );
    resetOrgProfilesCache();
    const profiles = await loadOrgProfiles(true);
    // 26R011936 was taught; 26R999999 is NEW and must still classify.
    const hit = classifyByProfiles("26R999999", profiles);
    expect(hit?.profile.slug).toBe("EDC");
    expect(hit?.rule.kind).toBe("rfq");
  });

  it("records the operator's explanation of the number's parts", async () => {
    // The operator's rule: «أوامر الشراء تبدأ بـ P ثم 26 ثم E». The shape alone
    // cannot tell you that 26 is the YEAR — that is knowledge only the user has,
    // and it must be stored WITH the pattern.
    const res = await executeTool(
      "learn_organization",
      {
        name: "EDC",
        examples: [
          { number: "P26E11407", kind: "po" },
          { number: "P26E14630", kind: "po" },
        ],
        meaning: "P = أمر شراء، 26 = السنة، E = EDC، والباقي رقم مسلسل",
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(rows[0].documentFormats[0].meaning).toContain("26 = السنة");
  });

  it("rejects a missing name instead of writing an unnamed profile", async () => {
    const res = await executeTool("learn_organization", { examples: [] }, ctx);
    expect(res.ok).toBe(false);
    expect(rows).toHaveLength(0);
  });
});

describe("classify_document_number", () => {
  it("reports no match honestly rather than forcing a near pattern", async () => {
    const res = await executeTool("classify_document_number", { number: "ZZZ99" }, ctx);
    expect(res.ok).toBe(true);
    expect((res.data as { matched: boolean }).matched).toBe(false);
    expect((res.data as { note: string }).note).toContain("لا نمط معروف");
  });

  it("classifies a PO number once EDC's format is known", async () => {
    await executeTool(
      "learn_organization",
      {
        name: "EDC",
        examples: [
          { number: "P26E11407", kind: "po" },
          { number: "P26E14630", kind: "po" },
        ],
      },
      ctx,
    );
    resetOrgProfilesCache();
    const res = await executeTool("classify_document_number", { number: "P26E77777" }, ctx);
    const data = res.data as { matched: boolean; organization: string; kind: string };
    expect(data.matched).toBe(true);
    expect(data.organization).toBe("EDC");
    expect(data.kind).toBe("po");
  });
});

describe("learning from mail (analysis, no model call)", () => {
  beforeEach(() => resetMailLearning());

  it("infers EDC's identity and formats from a batch of its mail", async () => {
    const res = await learnProfilesFromMail({
      from: "purchasing@edc-egypt.com",
      subject: "EDC PO No P26E11407",
      mailbox: "info",
      numbers: [
        { number: "P26E11407", kind: "po" },
        { number: "P26E14630", kind: "po" },
      ],
    });
    expect(res.learned).toBe(true);
    const saved = rows.find((r) => r.slug === res.slug);
    expect(saved?.slug).toBe("EDC");
    expect(saved?.domains).toContain("edc-egypt.com");
    expect(saved?.mailboxes).toContain("info");
    expect(saved?.sources).toContain("mail");
  });

  it("does not re-write the same batch on a repeated scan", async () => {
    const batch = {
      from: "purchasing@edc-egypt.com",
      subject: "EDC PO No P26E11407",
      mailbox: "info",
      numbers: [
        { number: "P26E11407" as const, kind: "po" as const },
        { number: "P26E14630" as const, kind: "po" as const },
      ],
    };
    const first = await learnProfilesFromMail(batch);
    expect(first.learned).toBe(true);
    const writesAfterFirst = writes.length;
    const second = await learnProfilesFromMail(batch);
    // The scan cache means the SAME batch is re-read on every follow-up
    // question; without the fingerprint guard this would write every time.
    expect(second.learned).toBe(false);
    expect(writes.length).toBe(writesAfterFirst);
  });

  it("learns nothing from a batch too thin to be evidence", async () => {
    const res = await learnProfilesFromMail({
      from: "someone@example.com",
      subject: "مرحبا",
      numbers: [{ number: "P26E11407", kind: "po" }],
    });
    // A single observation is a coincidence, not a pattern — the same "seen at
    // least twice" rule that guards identity guards the formats.
    expect(res.learned).toBe(false);
    expect(rows).toHaveLength(0);
  });
});
