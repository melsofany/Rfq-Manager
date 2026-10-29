/**
 * Odoo rejects an unknown field in a domain with
 * "Invalid field <name> in leaf ...", which fails the whole report — and, when
 * it happens inside a `Promise.all`, the whole screen. Two such bugs already
 * reached production:
 *
 *   - account.payment.ref          → renamed to payment_reference in Odoo 18
 *   - account.move.line.state      → the model only has `parent_state`
 *
 * These tests drive the real reporting functions through a fake JSON-RPC
 * transport and assert every field named in a domain, and every field read,
 * exists on that model in Odoo 18. They fail the moment a report starts asking
 * a model for a field it does not have.
 */
import { describe, it, expect, vi } from "vitest";

// Fields the bridge is allowed to touch, per Odoo 18 model. Sourced from the
// model definitions in odoo/addons/account/models and base.
const MODEL_FIELDS: Record<string, Set<string>> = {
  "account.move.line": new Set([
    "id",
    "date",
    "move_name",
    "account_id",
    "partner_id",
    "name",
    "debit",
    "credit",
    "balance",
    "move_id",
    "display_type",
    "parent_state",
  ]),
  "account.move": new Set([
    "id",
    "name",
    "ref",
    "invoice_date",
    "invoice_date_due",
    "partner_id",
    "amount_untaxed",
    "amount_tax",
    "amount_total",
    "amount_residual",
    "state",
    "move_type",
    "payment_state",
  ]),
  "account.payment": new Set([
    "id",
    "name",
    "date",
    "partner_id",
    "amount",
    "payment_type",
    "partner_type",
    "state",
    "payment_reference",
    "memo",
  ]),
  "account.account": new Set(["id", "code", "name", "account_type", "reconcile"]),
  "account.tax": new Set(["id", "name", "amount", "amount_type", "type_tax_use"]),
  "res.company": new Set(["name", "currency_id", "country_id"]),
  "ir.module.module": new Set(["name", "state"]),
};

const calls = vi.hoisted(() => [] as any[]);

vi.mock("../../modules/accounts-bridge/odoo-client", async () => {
  const actual = await vi.importActual<any>("../../modules/accounts-bridge/odoo-client");
  const record = (model: string, method: string, args: unknown[]) => {
    calls.push({ model, method, args });
    return [];
  };
  return {
    ...actual,
    executeKw: async (_cfg: any, model: string, method: string, args: unknown[]) =>
      record(model, method, args),
    searchRead: async (_cfg: any, model: string, domain: unknown[], fields: string[]) =>
      record(model, "search_read", [domain, { fields }]),
    readGroup: async (_cfg: any, model: string, domain: unknown[], fields: string[]) =>
      record(model, "read_group", [domain, { fields }]),
  };
});

import { odooConfigFromEnv } from "../../modules/accounts-bridge/odoo-client";
import {
  listJournalLines,
  trialBalance,
  listInvoices,
  listPayments,
  listAccounts,
  listTaxes,
  companyInfo,
} from "../../modules/accounts-bridge/reporting";

const cfg = odooConfigFromEnv({
  ODOO_URL: "http://odoo:10000",
  ODOO_DB: "db",
  ODOO_USER: "u",
  ODOO_API_KEY: "k",
} as NodeJS.ProcessEnv)!;

/** Every field name mentioned in a domain, whatever its nesting shape. */
function domainFields(domain: unknown): string[] {
  if (!Array.isArray(domain)) return [];
  return domain.flatMap((leaf) => {
    if (Array.isArray(leaf) && typeof leaf[0] === "string" && leaf.length >= 3) {
      return [leaf[0]];
    }
    return domainFields(leaf);
  });
}

function assertKnown(model: string, names: string[]) {
  const known = MODEL_FIELDS[model];
  expect(known, `no field list recorded for ${model}`).toBeDefined();
  for (const name of names) {
    // read_group aggregates look like "debit:sum" — only the field matters.
    const field = name.split(":")[0];
    expect(known.has(field), `${model} has no field '${field}' in Odoo 18`).toBe(true);
  }
}

describe("Odoo field names used by the reporting layer", () => {
  it("every domain field exists on its model", async () => {
    calls.length = 0;
    await Promise.all([
      listJournalLines(cfg, { from: "2026-01-01", to: "2026-10-29" }),
      trialBalance(cfg, { from: "2026-01-01", to: "2026-10-29" }),
      listInvoices(cfg, "in_invoice"),
      listPayments(cfg, "outbound"),
      listAccounts(cfg),
      listTaxes(cfg),
      companyInfo(cfg),
    ]);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const domain = call.args?.[0];
      assertKnown(call.model, domainFields(domain));
      const fields = (call.args?.[1] as any)?.fields ?? [];
      if (Array.isArray(fields)) assertKnown(call.model, fields as string[]);
    }
  });

  it("filters account.move.line on parent_state, never on state", async () => {
    calls.length = 0;
    await Promise.all([listJournalLines(cfg, {}), trialBalance(cfg, {})]);

    const lineCalls = calls.filter((c) => c.model === "account.move.line");
    expect(lineCalls.length).toBeGreaterThan(0);
    for (const call of lineCalls) {
      const names = domainFields(call.args?.[0]);
      expect(names).not.toContain("state");
      expect(names).toContain("parent_state");
    }
  });

  it("reads payments from payment_reference, never from ref", async () => {
    calls.length = 0;
    await listPayments(cfg, "outbound");

    const payCalls = calls.filter((c) => c.model === "account.payment");
    expect(payCalls.length).toBe(1);
    const fields = (payCalls[0].args?.[1] as any).fields as string[];
    expect(fields).not.toContain("ref");
    expect(fields).toContain("payment_reference");
  });
});
