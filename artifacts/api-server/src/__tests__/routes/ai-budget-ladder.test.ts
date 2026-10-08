import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { scanCallBudgetMs, toolTimeoutMs } from "../../modules/ai-assistant/tools";
import {
  ANSWER_RESERVE_MS,
  MIN_ANSWER_BUDGET_MS,
  SCAN_RETURN_MARGIN_MS,
} from "../../modules/ai-assistant/budgets";
import { AGENT_BUDGET_MS } from "../../modules/ai-assistant/agent";

/**
 * The ladder documented in budgets.ts must hold for the DEFAULTS, not only for
 * whatever the deployed environment happens to set.
 *
 * Live: the defaults were 160s (tool) and 120s (scan) inside a 150s run, so the
 * tool ceiling outlived the run and a scan could not return before its race
 * killed it. The documented ladder is 95s / 70s.
 */
describe("budget ladder defaults", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.AI_TOOL_TIMEOUT_MS;
    delete process.env.AI_SCAN_CALL_BUDGET_MS;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("descends: scan call budget < tool ceiling < run budget", () => {
    expect(scanCallBudgetMs()).toBeLessThan(toolTimeoutMs());
    expect(toolTimeoutMs()).toBeLessThan(AGENT_BUDGET_MS);
  });

  it("leaves the answer its reserve inside the run", () => {
    // A tool that uses everything past delivery and production leaves nothing to speak with.
    const reserve = ANSWER_RESERVE_MS + MIN_ANSWER_BUDGET_MS;
    expect(scanCallBudgetMs()).toBeLessThan(AGENT_BUDGET_MS - reserve);
  });

  it("returns the scan before the race that would kill it", () => {
    // The scan's own deadline must sit below the tool race by the return margin.
    const racedCeiling = AGENT_BUDGET_MS - ANSWER_RESERVE_MS - MIN_ANSWER_BUDGET_MS;
    expect(scanCallBudgetMs() + SCAN_RETURN_MARGIN_MS).toBeLessThanOrEqual(racedCeiling);
  });
});
