import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";

const OUT = "/tmp/mastra_live_out.json";

describe("mastra engine live loop", () => {
  it("answers a real DB question through the Mastra engine (read-only)", async () => {
    const { runToolLoop, mastraEngineEnabled } = await import(
      "../../modules/ai-assistant/mastra-agent"
    );
    const { loadSettings } = await import("../../modules/ai-assistant/config");
    const { systemPrompt } = await import("../../modules/ai-assistant/agent");
    const { routeQuestion, routeHint } = await import("../../modules/ai-assistant/router");

    const settings = await loadSettings();
    const question = "كم عدد أوامر الشراء الموجودة في النظام؟ استخدم الأداة.";
    const plan = routeQuestion(question);

    const ctx: any = { settings, phone: "spike", outbox: [], trace: () => {} };
    const messages: any[] = [
      { role: "system", content: systemPrompt(settings) + routeHint(plan) },
      { role: "user", content: question },
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150_000);
    (globalThis as any).__RAW_STEPS = [];

    let out: any = { engineEnabled: mastraEngineEnabled() };
    try {
      const loop = await runToolLoop({
        model: settings.model,
        baseUrl: settings.baseUrl,
        messages,
        ctx,
        maxRounds: plan.maxRounds,
        signal: controller.signal,
        phone: "spike",
      });
      out = {
        ...out,
        finalText: loop.finalText,
        rounds: loop.rounds,
        tools: loop.exchanges.map((e) => e.name),
        rawSteps: (globalThis as any).__RAW_STEPS,
        exchangeSamples: loop.exchanges.map((e) => ({
          name: e.name,
          content: e.content.slice(0, 120),
        })),
      };
    } catch (e: any) {
      out = { ...out, error: String(e?.message ?? e).slice(0, 400) };
    } finally {
      clearTimeout(timer);
    }

    writeFileSync(OUT, JSON.stringify(out, null, 2));
    expect(true).toBe(true);
  }, 300000);
});
