/**
 * Guard: RFQ numbers (internal or customer) must never reach a supplier.
 * The supplier-facing PO routes (PDF download and dispatch to the supplier)
 * must not reference RFQ data. Source-level check so a future edit cannot add
 * an RFQ field to those responses without failing this test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const routesSrc = readFileSync(join(here, "../../modules/po/routes.ts"), "utf8");

function routeBlock(tag: string): string {
  const i = routesSrc.indexOf(tag);
  if (i < 0) throw new Error(`route not found: ${tag}`);
  const j = routesSrc.indexOf("\nrouter.", i + tag.length);
  return routesSrc.slice(i, j < 0 ? undefined : j);
}

describe("supplier-facing PO output contains no RFQ data", () => {
  it("supplier PDF route does not reference RFQ numbers or allocations", () => {
    expect(routeBlock('router.get("/po/:id/pdf/:supplierId"')).not.toMatch(/rfq/i);
  });

  it("dispatch-to-supplier route does not reference RFQ numbers or allocations", () => {
    expect(routeBlock('router.post("/po/:id/dispatch"')).not.toMatch(/rfq/i);
  });
});
