/**
 * Security: the send-email confirmation gate (P7).
 *
 * Sending mail is an irreversible external action. The gate lives in CODE, not in
 * the prompt, because a prompt rule is not a permission boundary — a model that
 * misreads the instruction would still be able to send. These tests assert both
 * halves: an un-confirmed call sends NOTHING and returns the draft, and a
 * confirmed call actually sends.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendAssistantEmail = vi.fn();

vi.mock("@workspace/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) },
}));

vi.mock("drizzle-orm", () => ({
  sql: Object.assign((..._a: unknown[]) => ({ sql: true }), { join: () => ({}) }),
  eq: (...a: unknown[]) => ({ eq: a }),
  and: (...a: unknown[]) => ({ and: a }),
  or: (...a: unknown[]) => ({ or: a }),
  ilike: (...a: unknown[]) => ({ ilike: a }),
  desc: (...a: unknown[]) => ({ desc: a }),
  inArray: (...a: unknown[]) => ({ inArray: a }),
  isNotNull: (...a: unknown[]) => ({ isNotNull: a }),
  ne: (...a: unknown[]) => ({ ne: a }),
}));

vi.mock("../../modules/ai-assistant/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../modules/ai-assistant/email")>();
  return { ...actual, sendAssistantEmail };
});

vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { executeTool } = await import("../../modules/ai-assistant/tools");

const settings = {
  id: 1,
  key: "default",
  model: "gemini-3.6-flash",
  enabled: true,
  language: "ar",
  systemPrompt: null,
  allowDatabase: true,
  allowEmail: true,
  allowPdf: true,
  allowMemory: true,
} as never;

const ctx = { settings, phone: "2010", outbox: [] } as never;

describe("send_email confirmation gate", () => {
  beforeEach(() => {
    sendAssistantEmail.mockReset();
  });

  it("does NOT send when confirmation is missing, and returns the draft", async () => {
    const r = await executeTool(
      "send_email",
      { to: "x@y.com", subject: "عرض سعر", body: "الأسعار بالمرفق" },
      ctx,
    );
    expect(sendAssistantEmail).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    const data = r.data as any;
    expect(data.sent).toBe(false);
    expect(data.needsConfirmation).toBe(true);
    expect(data.draft.to).toBe("x@y.com");
    expect(data.draft.subject).toBe("عرض سعر");
  });

  it("treats an explicit confirmed:false the same as missing", async () => {
    const r = await executeTool(
      "send_email",
      { to: "x@y.com", subject: "s", body: "b", confirmed: false },
      ctx,
    );
    expect(sendAssistantEmail).not.toHaveBeenCalled();
    expect((r.data as any).sent).toBe(false);
  });

  it("sends only once confirmation is explicit", async () => {
    sendAssistantEmail.mockResolvedValue(undefined);
    const r = await executeTool(
      "send_email",
      { to: "x@y.com", subject: "s", body: "b", confirmed: true },
      ctx,
    );
    expect(sendAssistantEmail).toHaveBeenCalledTimes(1);
    expect(sendAssistantEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "x@y.com", subject: "s", body: "b" }),
    );
    expect((r.data as any).sent).toBe(true);
  });
});
