import { describe, it, expect, afterEach } from "vitest";
import { resolvePublicBaseUrl } from "../shared/base-url";

// Supplier pricing links are emailed/WhatsApped to external suppliers, so the
// resolved origin MUST point at the public host (not localhost). These tests
// lock in the priority order: BASE_URL > REPLIT_DOMAINS > req host > localhost.
describe("resolvePublicBaseUrl", () => {
  afterEach(() => {
    delete process.env.BASE_URL;
    delete process.env.REPLIT_DOMAINS;
  });

  it("prefers BASE_URL env var (trailing slash trimmed)", () => {
    process.env.BASE_URL = "https://cortoba-rfq.onrender.com/";
    expect(resolvePublicBaseUrl({ protocol: "https", get: () => "other.example" }))
      .toBe("https://cortoba-rfq.onrender.com");
  });

  it("uses REPLIT_DOMAINS when BASE_URL is absent", () => {
    process.env.REPLIT_DOMAINS = "a.repl.co,b.repl.co";
    expect(resolvePublicBaseUrl()).toBe("https://a.repl.co");
  });

  it("derives the origin from the incoming request host (Render proxy)", () => {
    const req = { protocol: "https", get: (n: string) => (n === "host" ? "cortoba-rfq.onrender.com" : undefined) };
    expect(resolvePublicBaseUrl(req)).toBe("https://cortoba-rfq.onrender.com");
  });

  it("falls back to localhost:PORT when nothing else is available", () => {
    process.env.PORT = "12000";
    expect(resolvePublicBaseUrl()).toBe("http://localhost:12000");
  });
});
