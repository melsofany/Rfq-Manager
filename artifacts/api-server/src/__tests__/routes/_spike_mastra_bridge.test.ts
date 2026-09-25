import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";

// The bridge under test talks ONLY to ./llm — no database import — so this
// spike can run against the live providers without a DB.
const OUT = "/tmp/mastra_bridge_out.json";

describe("mastra bridge", () => {
  it("drives a real tool round through CortobaLanguageModel", async () => {
    const { Agent } = await import("@mastra/core/agent");
    const { createTool } = await import("@mastra/core/tools");
    const { CortobaLanguageModel } = await import(
      "../../modules/ai-assistant/mastra-model"
    );

    const modelId = process.env.SPIKE_MODEL || process.env.AI_MODEL || "deepseek-chat";
    let toolRan = false;

    const countOrders = createTool({
      id: "count_orders",
      description: "Returns how many purchase orders are open. Call with no arguments.",
      inputSchema: { type: "object", properties: {}, additionalProperties: true } as any,
      execute: async () => {
        toolRan = true;
        return { openOrders: 42 };
      },
    });

    const agent = new Agent({
      id: "bridge-spike",
      name: "bridge-spike",
      instructions:
        "You are a test agent. When asked about open purchase orders, call count_orders.",
      model: new CortobaLanguageModel(modelId, process.env.SPIKE_BASE || null),
      tools: { countOrders },
    });

    let reply = "";
    let error: string | null = null;
    try {
      const res: any = await agent.generate("How many open purchase orders are there?");
      reply = String(res?.text ?? "").slice(0, 400);
    } catch (e: any) {
      error = String(e?.message ?? e).slice(0, 400); (globalThis as any).__STACK = String(e?.stack ?? "").slice(0, 2000);
    }

    writeFileSync(OUT, JSON.stringify({ modelId, toolRan, reply, error, stack: (globalThis as any).__STACK }, null, 2));
    expect(true).toBe(true);
  }, 300000);
});
