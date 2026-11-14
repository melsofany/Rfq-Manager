import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Reported live: the employee never saw the supplier's messages.
 *
 * The number was registered as BOTH a supplier (#1 aHMED) and a representative
 * (#2 Ahmed yousef). `handleRepMessage` opens the bot menu on ANY text from a
 * rep and returns `true`, which consumes the message — so every reply the
 * supplier typed («دي المواصفات») was eaten by the bot and never reached the
 * shared inbox the employee reads.
 *
 * A number in a two-way business conversation cannot be bot-only. The bot still
 * owns explicit `rep_` taps, and a rep-ONLY number still opens on any text —
 * that entry point is how the bot is reached at all.
 *
 * These tests drive the REAL handler and fail against the swallowing version
 * (verified by reverting the supplier check).
 */

const sendTextCalls: Array<{ to: string; body: string }> = [];

vi.mock("@workspace/db", () => {
  const tables = new Proxy({}, { get: (_t, prop) => ({ __table: String(prop) }) });
  const dbMock: Record<string, unknown> = {
    select: () => ({ from: (t: unknown) => chainable(t) }),
    insert: () => ({ values: () => Promise.resolve([{ id: 1 }]) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  };
  return {
    ...tables,
    representativesTable: {
      __table: "representativesTable",
      phone: "r.phone",
      isActive: "r.active",
    },
    suppliersTable: { __table: "suppliersTable", id: "s.id", phone: "s.phone", name: "s.name" },
    workOrderAssignmentsTable: { __table: "workOrderAssignmentsTable" },
    db: dbMock,
    __isRep: true,
  };
});

// The representative row the real `findRepresentative` must find.
vi.mock("@workspace/db-rep-rows", () => ({}));

const rowsByTable: Record<string, unknown[]> = {};
function chainable(table: unknown) {
  const name = (table as { __table?: string })?.__table ?? "";
  const rows = rowsByTable[name] ?? [];
  const obj: Record<string, unknown> = {};
  const pass = () => obj;
  obj.from = pass;
  obj.where = pass;
  obj.innerJoin = pass;
  obj.leftJoin = pass;
  obj.orderBy = pass;
  obj.groupBy = pass;
  obj.limit = () => Promise.resolve(rows);
  obj.then = (r: (v: unknown) => unknown) => Promise.resolve(rows).then(r);
  return obj;
}

vi.mock("../../modules/communications/service", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const stub = async () => "wamid.stub";
  return {
    ...actual,
    sendRepMainMenu: stub,
    sendRepPoPicker: stub,
    sendRepItemPicker: stub,
    sendRepItemAction: stub,
    sendRepConfirm: stub,
    sendWhatsAppText: async (to: string, body: string) => {
      sendTextCalls.push({ to: String(to), body: String(body) });
      return "wamid.stub";
    },
  };
});

vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { handleRepMessage } = await import("../../modules/communications/routes");

const textMessage = (body: string) => ({
  id: "wamid.TXT",
  from: "201022282802",
  type: "text" as const,
  text: { body },
});

describe("a rep+supplier number's text must reach the employee", () => {
  beforeEach(() => {
    sendTextCalls.length = 0;
    for (const k of Object.keys(rowsByTable)) delete rowsByTable[k];
    // A registered, ACTIVE representative.
    rowsByTable.representativesTable = [{ id: 2, phone: "201022282802", isActive: true }];
    // The same number is ALSO a supplier.
    rowsByTable.suppliersTable = [{ id: 1, name: "aHMED", phone: "201022282802" }];
  });

  it("does NOT consume the text — it must fall through to the shared inbox", async () => {
    const handled = await handleRepMessage("201022282802", textMessage("دي المواصفات") as never);

    expect(handled, "the bot must release the message to the inbox").toBe(false);
    expect(
      sendTextCalls.some((c) => c.body.includes("استلام") || c.body.includes("تسليم")),
      "the rep menu must not be sent in place of the supplier's message",
    ).toBe(false);
  });

  it("still opens the menu for a rep-ONLY number", async () => {
    // No supplier row → the bot keeps its entry point, which is how a rep
    // reaches the menu in the first place.
    rowsByTable.suppliersTable = [];

    const handled = await handleRepMessage("201022282802", textMessage("ابدأ") as never);

    expect(handled, "a rep-only number keeps the menu").toBe(true);
  });
});
