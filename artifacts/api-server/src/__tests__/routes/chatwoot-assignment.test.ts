import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Conversation OWNERSHIP: assigning a supplier thread to the employee
 * responsible for the pricing request it answers.
 *
 * The defect this guards against is a console where every supplier thread sits
 * in one shared pile: the request number and the responsible employee are the
 * reason the console exists, and a thread nobody owns is a thread nobody
 * answers. The tests below cover the two ways that fails silently:
 *
 *   - an assignment that FAILED being cached as done (the thread then stays
 *     unassigned forever, because nothing retries it), and
 *   - a resolution failure being cached, which would make that employee
 *     permanently unassignable for the life of the process.
 */

const client = {
  isChatwootConfigured: true,
  findContactByPhone: vi.fn(),
  createContact: vi.fn(),
  createConversation: vi.fn(),
  createMessage: vi.fn(),
  getConversationContactPhone: vi.fn(),
  findAgentByEmail: vi.fn(),
  createAgent: vi.fn(),
  listAgents: vi.fn(),
  assignConversation: vi.fn(),
  setConversationCustomAttributes: vi.fn(),
  addConversationLabels: vi.fn(),
};

vi.mock("../../modules/chatwoot/client", () => client);

/** Rows the employee/request lookups resolve to, per test. */
const rows = {
  employee: [] as Array<{ email: string }>,
  rfq: [] as Array<{ internalRfqNo: string }>,
};

vi.mock("@workspace/db", () => {
  // Both lookups use select().from().where().limit(); the table passed to from()
  // decides which fixture answers.
  const employeesTable = { id: "id", email: "email" };
  const rfqTable = { id: "id", internalRfqNo: "internal_rfq_no" };
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () => Promise.resolve(table === employeesTable ? rows.employee : rows.rfq),
          }),
        }),
      }),
    },
    chatwootLinksTable: { phone: "phone", rfqId: "rfq_id", conversationId: "conversation_id" },
    suppliersTable: { id: "id", name: "name", phone: "phone" },
    sentLogTable: { rfqId: "rfq_id", supplierId: "supplier_id", employeeId: "employee_id" },
    rfqTable,
    employeesTable,
  };
});

const {
  ensureAgentForEmail,
  applyConversationOwnership,
  pickAssignee,
  resetAgentCache,
  resetOwnershipCache,
  ROUTE_LABEL_OWNER,
  ROUTE_LABEL_ONLINE,
  ROUTE_LABEL_SUPERVISOR,
  ROUTE_LABEL_UNASSIGNED,
} = await import("../../modules/chatwoot/bridge");

beforeEach(() => {
  vi.clearAllMocks();
  rows.employee = [];
  rows.rfq = [];
  resetAgentCache();
  resetOwnershipCache();
  client.setConversationCustomAttributes.mockResolvedValue(true);
  client.assignConversation.mockResolvedValue(true);
  client.addConversationLabels.mockResolvedValue(true);
  client.findAgentByEmail.mockResolvedValue(undefined);
  client.createAgent.mockResolvedValue({ id: 99 });
  // Default roster: the owner resolves and takes the thread.
  client.listAgents.mockResolvedValue([{ id: 99, role: "agent", availability_status: "offline" }]);
});

describe("ensureAgentForEmail", () => {
  it("resolves an existing agent by email, case-insensitively", async () => {
    client.findAgentByEmail.mockResolvedValue({ id: 42, email: "ahmed@cortoba.com" });
    expect(await ensureAgentForEmail("Ahmed@Cortoba.com")).toBe(42);
    // The lookup normalises; it must not create a duplicate agent.
    expect(client.findAgentByEmail).toHaveBeenCalledWith("ahmed@cortoba.com");
    expect(client.createAgent).not.toHaveBeenCalled();
  });

  it("creates the agent on first use when none exists", async () => {
    expect(await ensureAgentForEmail("mona@cortoba.com", "منى")).toBe(99);
    expect(client.createAgent).toHaveBeenCalledWith("منى", "mona@cortoba.com");
  });

  it("caches a SUCCESSFUL resolution so a busy thread does not re-list agents", async () => {
    client.findAgentByEmail.mockResolvedValue({ id: 42 });
    await ensureAgentForEmail("ahmed@cortoba.com");
    await ensureAgentForEmail("ahmed@cortoba.com");
    expect(client.findAgentByEmail).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a failure, so the employee is retried rather than lost", async () => {
    client.findAgentByEmail.mockRejectedValue(new Error("chatwoot down"));
    expect(await ensureAgentForEmail("ahmed@cortoba.com")).toBeNull();
    // Chatwoot recovers.
    client.findAgentByEmail.mockResolvedValue({ id: 42 });
    expect(await ensureAgentForEmail("ahmed@cortoba.com")).toBe(42);
  });

  it("returns null for a blank email rather than calling Chatwoot", async () => {
    expect(await ensureAgentForEmail(null)).toBeNull();
    expect(await ensureAgentForEmail("   ")).toBeNull();
    expect(client.findAgentByEmail).not.toHaveBeenCalled();
  });
});

describe("applyConversationOwnership", () => {
  it("writes the request + owner attributes and assigns the responsible agent", async () => {
    rows.employee = [{ email: "ahmed@cortoba.com" }];
    client.findAgentByEmail.mockResolvedValue({ id: 42 });

    const ok = await applyConversationOwnership(7, {
      internalRfqNo: "CRFQ-2026-000123",
      employeeId: 3,
      employeeName: "أحمد حمدي",
    });

    expect(ok).toBe(true);
    // The attribute keys must be the ones the Chatwoot overlay declares.
    expect(client.setConversationCustomAttributes).toHaveBeenCalledWith(7, {
      cortoba_rfq_no: "CRFQ-2026-000123",
      cortoba_owner_name: "أحمد حمدي",
    });
    expect(client.assignConversation).toHaveBeenCalledWith(7, 42);
  });

  it("reports failure when the assignment fails, so the caller retries", async () => {
    rows.employee = [{ email: "ahmed@cortoba.com" }];
    client.findAgentByEmail.mockResolvedValue({ id: 42 });
    client.assignConversation.mockResolvedValue(false);

    expect(await applyConversationOwnership(7, { internalRfqNo: "X", employeeId: 3 })).toBe(false);
  });

  it("falls back to an ONLINE agent when the owner has no console account", async () => {
    // Owner is unresolvable (no email), but somebody is at their desk.
    client.listAgents.mockResolvedValue([
      { id: 11, role: "agent", availability_status: "offline" },
      { id: 22, role: "agent", availability_status: "online" },
    ]);

    const ok = await applyConversationOwnership(7, { internalRfqNo: "X", employeeId: 3 });

    expect(ok).toBe(true);
    expect(client.assignConversation).toHaveBeenCalledWith(7, 22);
    expect(client.addConversationLabels).toHaveBeenCalledWith(7, [ROUTE_LABEL_ONLINE]);
  });

  it("escalates to an administrator when nobody is online", async () => {
    client.listAgents.mockResolvedValue([
      { id: 11, role: "agent", availability_status: "offline" },
      { id: 33, role: "administrator", availability_status: "offline" },
    ]);

    expect(await applyConversationOwnership(7, { internalRfqNo: "X", employeeId: 3 })).toBe(true);
    expect(client.assignConversation).toHaveBeenCalledWith(7, 33);
    expect(client.addConversationLabels).toHaveBeenCalledWith(7, [ROUTE_LABEL_SUPERVISOR]);
  });

  it("labels the thread UNASSIGNED when no agent can take it, and still succeeds", async () => {
    client.listAgents.mockResolvedValue([]);

    const ok = await applyConversationOwnership(7, { internalRfqNo: "X", employeeId: 3 });

    // Nobody to assign is a routing OUTCOME, not a failure: retrying forever
    // would never change it. The label is what makes it findable.
    expect(ok).toBe(true);
    expect(client.assignConversation).not.toHaveBeenCalled();
    expect(client.addConversationLabels).toHaveBeenCalledWith(7, [ROUTE_LABEL_UNASSIGNED]);
  });

  it("labels the thread as the OWNER's when the owner takes it", async () => {
    rows.employee = [{ email: "ahmed@cortoba.com" }];
    client.findAgentByEmail.mockResolvedValue({ id: 42 });
    client.listAgents.mockResolvedValue([
      { id: 42, role: "agent", availability_status: "offline" },
    ]);

    await applyConversationOwnership(7, { internalRfqNo: "X", employeeId: 3 });
    expect(client.addConversationLabels).toHaveBeenCalledWith(7, [ROUTE_LABEL_OWNER]);
  });

  it("succeeds with attributes alone when the request has no responsible employee", async () => {
    const ok = await applyConversationOwnership(7, {
      internalRfqNo: "CRFQ-2026-000999",
      employeeId: null,
      employeeName: null,
    });
    expect(ok).toBe(true);
    expect(client.setConversationCustomAttributes).toHaveBeenCalledWith(7, {
      cortoba_rfq_no: "CRFQ-2026-000999",
    });
    // Nothing to assign, and no reason to touch the agent roster.
    expect(client.assignConversation).not.toHaveBeenCalled();
  });

  it("never throws — a console fault must not break the WhatsApp pipeline", async () => {
    rows.employee = [{ email: "ahmed@cortoba.com" }];
    client.setConversationCustomAttributes.mockRejectedValue(new Error("boom"));
    await expect(
      applyConversationOwnership(7, { internalRfqNo: "X", employeeId: 3 }),
    ).resolves.toBe(false);
  });

  it("skips the attribute call when there is nothing to write", async () => {
    await applyConversationOwnership(7, {});
    expect(client.setConversationCustomAttributes).toHaveBeenCalledWith(7, {});
  });
});

describe("pickAssignee", () => {
  it("prefers the request's responsible employee", async () => {
    client.listAgents.mockResolvedValue([
      { id: 42, role: "agent", availability_status: "online" },
      { id: 77, role: "agent", availability_status: "online" },
    ]);
    const d = await pickAssignee({ ownerAgentId: 42 });
    expect(d).toMatchObject({ agentId: 42, reason: "owner", label: ROUTE_LABEL_OWNER });
  });

  it("prefers the owner even when the owner is offline", async () => {
    // The owner knows the request; a faster stranger is not a better answer.
    client.listAgents.mockResolvedValue([
      { id: 42, role: "agent", availability_status: "offline" },
      { id: 77, role: "agent", availability_status: "online" },
    ]);
    const d = await pickAssignee({ ownerAgentId: 42 });
    expect(d.agentId).toBe(42);
    expect(d.reason).toBe("owner");
  });

  it("uses an online agent when the owner is explicitly unavailable", async () => {
    client.listAgents.mockResolvedValue([
      { id: 77, role: "agent", availability_status: "online" },
      { id: 88, role: "agent", availability_status: "busy" },
    ]);
    const d = await pickAssignee({ ownerAgentId: 42, ownerAvailable: false });
    expect(d).toMatchObject({ agentId: 77, reason: "online", label: ROUTE_LABEL_ONLINE });
  });

  it("does NOT pick a busy agent as the online fallback", async () => {
    client.listAgents.mockResolvedValue([
      { id: 88, role: "agent", availability_status: "busy" },
      { id: 33, role: "administrator", availability_status: "offline" },
    ]);
    const d = await pickAssignee({});
    expect(d).toMatchObject({ agentId: 33, reason: "supervisor" });
  });

  it("escalates to an administrator when nobody is online", async () => {
    client.listAgents.mockResolvedValue([
      { id: 11, role: "agent", availability_status: "offline" },
      { id: 33, role: "administrator", availability_status: "offline" },
    ]);
    const d = await pickAssignee({});
    expect(d).toMatchObject({ agentId: 33, reason: "supervisor", label: ROUTE_LABEL_SUPERVISOR });
  });

  it("returns unassigned when the roster is empty", async () => {
    client.listAgents.mockResolvedValue([]);
    const d = await pickAssignee({});
    expect(d).toMatchObject({ agentId: null, reason: "unassigned", label: ROUTE_LABEL_UNASSIGNED });
  });

  it("returns unassigned when only non-administrator agents are offline", async () => {
    client.listAgents.mockResolvedValue([
      { id: 11, role: "agent", availability_status: "offline" },
    ]);
    const d = await pickAssignee({});
    expect(d).toMatchObject({ agentId: null, reason: "unassigned" });
  });
});
