/**
 * The assistant's conversation must not appear in the shared inbox.
 *
 * `/whatsapp` renders every row of `whatsapp_chats`, and the webhook records an
 * inbound message BEFORE any handler is consulted — so a message the operator
 * sends TO the assistant was written into the supplier inbox and read by every
 * employee. Measured live: four manager numbers, their private requests and
 * reports, visible to the whole team.
 *
 * The assistant is not a supplier channel. These tests pin the guard that keeps
 * its conversation out, and the direction of the failure (an unknown sender is
 * still recorded, so a real supplier is never dropped).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const selectRows = vi.fn();
const insertValues = vi.fn();
const insert = vi.fn(() => ({ values: insertValues }));

vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve(selectRows()) }) }),
    insert,
  },
  whatsappChatsTable: { id: "id", waMessageId: "waMessageId", phone: "phone" },
  suppliersTable: { id: "id", phone: "phone" },
  aiAssistantUsersTable: { phone: "phone", isActive: "isActive", employeeId: "employeeId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (...a: unknown[]) => ({ eq: a }),
  desc: (...a: unknown[]) => ({ desc: a }),
  sql: Object.assign(() => ({ sql: true }), { join: () => ({}) }),
  and: (...a: unknown[]) => ({ and: a }),
  inArray: (...a: unknown[]) => ({ inArray: a }),
  ne: (...a: unknown[]) => ({ ne: a }),
  isNotNull: (...a: unknown[]) => ({ isNotNull: a }),
}));

const { isAiAssistantPhone, resetAiPhoneCache } = await import("../../modules/ai-assistant/config");

const MANAGER = "201005520442";
const SUPPLIER = "201000000000";

beforeEach(() => {
  vi.clearAllMocks();
  resetAiPhoneCache();
  selectRows.mockReturnValue([{ phone: MANAGER, isActive: true, employeeId: null }]);
});

describe("isAiAssistantPhone", () => {
  it("recognises an allowlisted manager", async () => {
    expect(await isAiAssistantPhone(MANAGER)).toBe(true);
  });

  it("does not recognise a supplier", async () => {
    expect(await isAiAssistantPhone(SUPPLIER)).toBe(false);
  });

  it("matches across phone formats (+ and bare digits)", async () => {
    expect(await isAiAssistantPhone(`+${MANAGER}`)).toBe(true);
    expect(await isAiAssistantPhone(`0${MANAGER.slice(2)}`)).toBe(true);
  });

  it("answers false when the allowlist read fails", async () => {
    // The safe direction: an unreadable allowlist must not stop a real
    // supplier's message from being recorded.
    selectRows.mockImplementation(() => {
      throw new Error("db down");
    });
    resetAiPhoneCache();
    expect(await isAiAssistantPhone(MANAGER)).toBe(false);
  });

  it("caches the allowlist instead of querying per message", async () => {
    await isAiAssistantPhone(MANAGER);
    await isAiAssistantPhone(MANAGER);
    await isAiAssistantPhone(SUPPLIER);
    // One read for three checks — this runs on the inbound path of every message.
    expect(selectRows).toHaveBeenCalledTimes(1);
  });
});
