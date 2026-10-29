/**
 * A bill must land on the partner the RFQ actually refers to. Two Odoo
 * partners can share a name, so a name lookup must never override a stable
 * reference, and an ambiguous name must stop the sync instead of guessing.
 *
 * Only the Odoo network client and the database module are doubled; the
 * partner-resolution code under test is the real one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const odoo = vi.hoisted(() => ({
  findOneId: vi.fn(),
  searchRead: vi.fn(),
  createRecord: vi.fn(),
}));

vi.mock("../../modules/accounts-bridge/odoo-client", () => ({
  odooConfigFromEnv: vi.fn(),
  executeKw: vi.fn(),
  findOneId: odoo.findOneId,
  searchRead: odoo.searchRead,
  createRecord: odoo.createRecord,
}));

vi.mock("@workspace/db", () => ({
  db: {},
  taxSettingsTable: {},
}));

import { resolvePartner } from "../../modules/accounts-bridge/service";

const cfg = { url: "http://odoo", db: "odoo_db", user: "rfq-bridge", apiKey: "x" } as any;

describe("resolvePartner: identity", () => {
  beforeEach(() => {
    odoo.findOneId.mockReset();
    odoo.searchRead.mockReset();
    odoo.createRecord.mockReset();
  });

  it("uses the RFQ reference when it exists, without a name lookup", async () => {
    odoo.findOneId.mockResolvedValueOnce(42);

    const id = await resolvePartner(cfg, {
      kind: "supplier",
      rfqId: 7,
      name: "Same Name Co",
    });

    expect(id).toBe(42);
    expect(odoo.findOneId).toHaveBeenCalledTimes(1);
    expect(odoo.findOneId).toHaveBeenCalledWith(cfg, "res.partner", [["ref", "=", "RFQ-SUP-7"]]);
    expect(odoo.searchRead).not.toHaveBeenCalled();
  });

  it("never picks a partner by name when the reference is unknown to Odoo", async () => {
    // The reference search finds nothing, so a new partner is created.
    // A same-named partner must NOT be reused just because the name matches.
    odoo.findOneId.mockResolvedValueOnce(null);
    odoo.createRecord.mockResolvedValueOnce(99);

    const id = await resolvePartner(cfg, {
      kind: "customer",
      rfqId: 3,
      name: "Same Name Co",
    });

    expect(id).toBe(99);
    expect(odoo.searchRead).not.toHaveBeenCalled();
    expect(odoo.createRecord).toHaveBeenCalledWith(
      cfg,
      "res.partner",
      expect.objectContaining({ ref: "RFQ-CUS-3", customer_rank: 1 }),
    );
  });

  it("reuses a single name match when there is no reference", async () => {
    odoo.searchRead.mockResolvedValueOnce([{ id: 55 }]);

    const id = await resolvePartner(cfg, {
      kind: "supplier",
      rfqId: null,
      name: "Only One Co",
    });

    expect(id).toBe(55);
    expect(odoo.createRecord).not.toHaveBeenCalled();
  });

  it("refuses to guess between duplicate names when there is no reference", async () => {
    odoo.searchRead.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);

    await expect(
      resolvePartner(cfg, { kind: "supplier", rfqId: null, name: "Dup Co" }),
    ).rejects.toThrow(/refusing to guess/);

    expect(odoo.createRecord).not.toHaveBeenCalled();
  });
});
