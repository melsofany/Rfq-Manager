import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The free Chatwoot SUSPENDS after ~15 minutes idle. Its first request waits
 * 30-50 seconds while it boots and answers 502/503 meanwhile, so a single
 * attempt failed EVERY cold upload.
 *
 * Measured live: a supplier's image reached the console as «[صورة مرسلة]» text
 * while the reply right after it — Chatwoot awake by then — arrived normally.
 * That reads as a random defect; it is a race with the wake-up.
 *
 * These tests drive the REAL client against a stubbed `fetch`, so they prove
 * the retry rather than the presence of a constant.
 */

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, "../../modules/chatwoot/client.ts"), "utf8");

const ok = (body: unknown = { id: 9 }) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
const status = (code: number) => Promise.resolve(new Response("", { status: code }));

describe("a cold Chatwoot must not lose the upload", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("CHATWOOT_URL", "https://console.test");
    vi.stubEnv("CHATWOOT_API_TOKEN", "t");
    vi.stubEnv("CHATWOOT_ACCOUNT_ID", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("retries a 503 from the booting console and succeeds", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      calls += 1;
      // Two 503s (booting) then the real answer — exactly the cold-start shape.
      if (calls <= 2) return status(503);
      return ok({ id: 42 });
    });

    const { createMessage } = await import("../../modules/chatwoot/client");
    const msg = await createMessage(1, "مرحبا", "incoming");

    expect(calls, "the console was woken with more than one attempt").toBeGreaterThan(2);
    expect(msg?.id, "the retried call returns the real message").toBe(42);
  });

  it("does NOT retry a 4xx — that is the console's real answer", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      calls += 1;
      return status(404);
    });

    const { createMessage } = await import("../../modules/chatwoot/client");
    await createMessage(1, "مرحبا", "incoming");

    expect(calls, "a 4xx is final and must not burn retries").toBe(1);
  });

  it("allows a cold boot: the timeout is longer than one attempt", () => {
    // The wake-up itself takes 30-50s. A 15s attempt aborts mid-boot, which is
    // what made the upload fail no matter how many times it was tried.
    const timeout = Number(/CW_TIMEOUT_MS = ([\d_]+)/.exec(clientSource)?.[1]?.replace(/_/g, ""));
    expect(timeout, "one attempt must outlast a cold boot").toBeGreaterThanOrEqual(20_000);
  });
});
