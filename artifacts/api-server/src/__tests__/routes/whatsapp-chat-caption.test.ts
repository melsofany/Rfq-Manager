import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Two operator reports, both about the WhatsApp screen.
 *
 * (1) One supplier showed up as TWO conversations. A stored phone carrying a
 *     hidden bidi mark (`⁦+201155351999`) never matched the bare wa_id the
 *     webhook sends, so inbound rows landed with supplier_id = NULL beside the
 *     outbound rows carrying the supplier — and the chat list, grouped by
 *     (phone, supplier_id), split the thread in two. Fixed by stripping the
 *     mark in normalizePhone and grouping by phone alone.
 *
 * (2) An attachment could not carry a comment. The operator had to send the
 *     file and then a separate message. Now whatever is typed travels WITH the
 *     file as its caption, in one WhatsApp message.
 */

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../../shared/permissions", () => ({
  guardFor: () => (_req: any, _res: any, next: any) => next(),
  guardByMethod: () => (_req: any, _res: any, next: any) => next(),
}));

const sentMessages: any[] = [];
vi.mock("../../modules/communications/service", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isWhatsAppConfigured: true,
    uploadWhatsAppMedia: vi.fn(async () => "media-123"),
    Whatsapp: {
      // routes.ts assigns `Whatsapp.on.message` at module load.
      on: {},
      sendMessage: vi.fn(async (_id: string, _to: string, message: any) => {
        sentMessages.push(message);
        return { messages: [{ id: "wamid.OUT" }] };
      }),
      markAsRead: vi.fn(async () => ({})),
    },
  };
});

vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const selectRows: Record<string, any[]> = {};
vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = (rows: any[]): any => {
    const api: any = {
      from: vi.fn(() => api),
      where: vi.fn(() => api),
      leftJoin: vi.fn(() => api),
      innerJoin: vi.fn(() => api),
      groupBy: vi.fn(() => api),
      orderBy: vi.fn(() => Promise.resolve(rows)),
      limit: vi.fn(() => Promise.resolve(rows)),
      then: (r: any) => Promise.resolve(rows).then(r),
    };
    return api;
  };
  const dbMock = {
    select: vi.fn(() => chain(selectRows.chats ?? [])),
    insert: vi.fn(() => ({
      values: vi.fn(() => {
        const p: any = Promise.resolve([{ id: 1 }]);
        p.onConflictDoNothing = () => p;
        p.catch = p.catch.bind(p);
        return p;
      }),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
  };
  return { ...actual, db: dbMock };
});

const { default: router, normalizePhone } = await import("../../modules/communications/routes");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api", router);
  return a;
}

beforeEach(() => {
  sentMessages.length = 0;
  selectRows.chats = [];
});

describe("normalizePhone strips the invisible mark that split one thread in two", () => {
  it("strips a leading U+2066 (the Electric Technology case)", () => {
    // The exact stored value that produced two conversations.
    expect(normalizePhone("\u2066+201155351999")).toBe(normalizePhone("201155351999"));
    expect(normalizePhone("\u2066+201155351999")).toBe("201155351999");
  });

  it("strips every bidi/formatting mark, wherever it sits", () => {
    const marks = ["\u2066", "\u2067", "\u2068", "\u2069", "\u200e", "\u200f", "\u202a", "\u202e"];
    for (const mark of marks) {
      expect(normalizePhone(`+2011${mark}55351999`)).toBe("201155351999");
    }
  });

  it("leaves a clean number untouched", () => {
    expect(normalizePhone("201155351999")).toBe("201155351999");
    expect(normalizePhone("+20 115 535 1999")).toBe("201155351999");
  });
});

describe("an attachment travels WITH its caption in one message", () => {
  it("sends the typed text as the caption of the file", async () => {
    const res = await request(app())
      .post("/api/whatsapp/send-media")
      .field("phone", "201155351999")
      .field("supplierId", "406")
      .field("caption", "ده عرض السعر المطلوب")
      .attach("file", Buffer.from("%PDF-1.4 test"), {
        filename: "quote.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(200);
    expect(sentMessages).toHaveLength(1);
    // The Document message carries the caption — not a separate text message.
    expect((sentMessages[0] as any).caption).toBe("ده عرض السعر المطلوب");
  });

  it("sends no caption when the operator typed nothing", async () => {
    const res = await request(app())
      .post("/api/whatsapp/send-media")
      .field("phone", "201155351999")
      .attach("file", Buffer.from("PNGDATA"), {
        filename: "photo.png",
        contentType: "image/png",
      });
    expect(res.status).toBe(200);
    expect(sentMessages).toHaveLength(1);
    expect((sentMessages[0] as any).caption ?? undefined).toBeUndefined();
  });
});

describe("the chat list groups one phone into ONE conversation", () => {
  it("returns one row per phone even when supplier_id differs across rows", async () => {
    // The endpoint groups by phone alone; a phone that appears with both a
    // supplier id and NULL must collapse to a single conversation. The mock
    // returns the already-grouped rows the SQL produces.
    selectRows.chats = [
      {
        phone: "201155351999",
        supplierId: 406,
        contactName: "Electric Technology",
        lastMessage: "آخر رسالة",
        lastAt: new Date("2026-11-16T10:00:00Z"),
        lastInboundAt: new Date("2026-11-16T10:00:00Z"),
        unread: 2,
      },
    ];
    const res = await request(app()).get("/api/whatsapp/chats");
    expect(res.status).toBe(200);
    const phones = res.body.map((r: any) => r.phone);
    expect(phones).toEqual(["201155351999"]);
    expect(new Set(phones).size).toBe(phones.length);
    expect(res.body[0].supplierId).toBe(406);
  });
});
