import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The WhatsApp webhook must be acknowledged immediately. Meta redelivers a
 * webhook it has not seen a 2xx for within a few seconds, and an agent run
 * takes far longer than that — so awaiting it meant the same question was
 * processed twice (double quota, two replies).
 */

const chainable = (value: any, methods: Record<string, any> = {}): any => {
  const obj: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
  for (const [k, fn] of Object.entries(methods)) obj[k] = fn;
  return obj;
};

let userRows: any[] = [];

const usersTable = { _: "aiUsers", id: "id", phone: "phone", isActive: "isActive" };
const settingsTable = { _: "aiSettings", id: "id", key: "key" };
const employeesTbl = { _: "employees", id: "id", role: "role", isActive: "isActive" };

vi.mock("drizzle-orm", () => ({
  eq: (l: any, r: any) => ({ __op: "eq", left: l, right: r }),
  and: (...a: any[]) => ({ __op: "and", args: a }),
  or: (...a: any[]) => ({ __op: "or", args: a }),
  desc: (c: any) => ({ __op: "desc", col: c }),
  asc: (c: any) => ({ __op: "asc", col: c }),
  count: () => ({ __op: "count" }),
  ilike: (l: any, r: any) => ({ __op: "ilike", left: l, right: r }),
  gte: (l: any, r: any) => ({ __op: "gte", left: l, right: r }),
}));

const dbMock: any = {
  select: vi.fn(() => ({
    from: vi.fn((table: any) => {
      if (table === usersTable)
        return chainable([...userRows], { where: () => chainable([...userRows]) });
      if (table === employeesTbl)
        return chainable([], { where: () => chainable([], { limit: () => chainable([]) }) });
      return chainable([], { where: () => chainable([]) });
    }),
  })),
  insert: vi.fn(() => ({ values: vi.fn(() => chainable({ id: 1 })) })),
};

vi.mock("@workspace/db", () => ({
  db: dbMock,
  aiAssistantUsersTable: usersTable,
  aiAssistantSettingsTable: settingsTable,
  aiAssistantMessagesTable: { _: "aiMessages", id: "id", phone: "phone", role: "role" },
  employeesTable: employeesTbl,
  auditLogTable: { _: "audit" },
}));

// The agent is slow by design; the handler must not wait for it.
const runAgent = vi.fn(async () => ({ reply: "الإجابة", attachments: [] }));
vi.mock("../../modules/ai-assistant/agent", () => ({
  runAgent: (...args: any[]) => (runAgent as any)(...args),
  resetHistory: vi.fn(),
}));

const sendWhatsAppText = vi.fn(async (_phone: string, _body: string) => ({}));
vi.mock("../../modules/communications/service", () => ({
  downloadInboundMedia: vi.fn(async () => null),
  sendWhatsAppText: (...a: any[]) => (sendWhatsAppText as any)(...a),
  sendWhatsAppDocument: vi.fn(async () => ({})),
}));

const settingsRow = {
  enabled: true,
  model: "gemini-3.8-flash",
  baseUrl: null,
  systemPrompt: null,
  language: "ar",
  allowEmail: true,
  allowDatabase: true,
  allowPdf: true,
};
vi.mock("../../modules/ai-assistant/config", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    isAiConfigured: true,
    findAuthorizedUser: async (phone: string) => userRows.find((u) => u.phone === phone) ?? null,
    loadSettings: async () => settingsRow,
  };
});

describe("AI assistant webhook acknowledgement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userRows = [{ id: 1, phone: "201000000000", isActive: true }];
  });

  it("returns before the agent finishes so Meta is not made to redeliver", async () => {
    // A slow answer that is still running when the handler returns.
    let release!: () => void;
    runAgent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ reply: "الإجابة", attachments: [] });
        }),
    );

    const { handleAiAssistantMessage } = await import("../../modules/ai-assistant/handler");
    const owned = await handleAiAssistantMessage("201000000000", {
      type: "text",
      text: { body: "كم عدد أوامر الشراء؟" },
    });

    // Owned immediately, while the agent is still working.
    expect(owned).toBe(true);
    expect(sendWhatsAppText).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() => expect(sendWhatsAppText).toHaveBeenCalledTimes(1));
    expect(sendWhatsAppText.mock.calls[0]?.[1]).toBe("الإجابة");
  });

  it("does not claim a message from a number that is not allowlisted", async () => {
    const { handleAiAssistantMessage } = await import("../../modules/ai-assistant/handler");
    const owned = await handleAiAssistantMessage("201999999999", {
      type: "text",
      text: { body: "مرحبا" },
    });
    expect(owned).toBe(false);
    expect(runAgent).not.toHaveBeenCalled();
  });
});
