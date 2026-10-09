import { describe, expect, it } from "vitest";
import { sqlColumnCatalogue } from "../modules/ai-assistant/db-tools";
import { toolDefinitions } from "../modules/ai-assistant/tool-definitions";

describe("SQL column catalogue", () => {
  const catalogue = sqlColumnCatalogue();

  it("lists the core tables with their real snake_case column names", () => {
    // Live: the model wrote `internalNo` into run_readonly_query; Postgres folded
    // it to `internalno` and the query failed.
    expect(catalogue).toContain("- customer_rfqs:");
    expect(catalogue).toContain("internal_no");
    expect(catalogue).not.toContain("internalNo");
    for (const t of ["customer_pos", "customer_po_items", "purchase_orders", "suppliers"]) {
      expect(catalogue).toContain(`- ${t}:`);
    }
  });

  it("leaves out sensitive columns", () => {
    expect(catalogue).not.toContain("password");
  });

  it("is attached to run_readonly_query so the model sees it before guessing", () => {
    const def = toolDefinitions({
      settings: { allowDatabase: true, allowEmail: false },
    } as never).find((d) => d.function.name === "run_readonly_query");
    expect(def?.function.description).toContain("snake_case");
    expect(def?.function.description).toContain("internal_no");
  });

  it("stays small enough to ride along on every request", () => {
    expect(catalogue.length).toBeLessThan(5_000);
  });
});
