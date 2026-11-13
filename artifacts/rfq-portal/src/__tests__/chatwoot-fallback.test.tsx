/**
 * Drives the REAL console page, so the fallback is proven by behaviour rather
 * than by grepping the source.
 *
 * The first cut of this test read the file as text and asserted a
 * `setUseLegacy(true)` string was present. It passed against the FIXED code and
 * — worse — it also passed after the fix was reverted, because the string still
 * appeared in the file. A test that cannot fail is not a guard, so it now
 * renders the component with a stubbed fetch and asserts what the agent
 * actually sees.
 *
 * The behaviour that matters: the built-in chat must be reachable whenever the
 * console is unusable, whether it is unconfigured OR unreachable. Before the
 * fix, an unreachable console rendered an error screen and the built-in chat
 * was never reached — a Chatwoot outage took down /whatsapp entirely.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import ChatwootInboxPage from "../modules/communications/pages/chatwoot";

// The built-in chat is a large module with its own data needs; it is stubbed to
// a marker so the assertion is "did we fall back", not "how does it render".
vi.mock("../modules/communications/pages/index", () => ({
  default: () => <div data-testid="builtin-chat">BUILTIN_CHAT</div>,
}));
vi.mock("@/components/Layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/contexts/LanguageContext", () => ({
  useLanguage: () => ({ t: (k: string) => k, dir: "rtl" }),
}));

// A real Response, so the stub matches the DOM signature the page expects
// rather than a hand-rolled object that happens to have `json()`.
const jsonResponse = (body: unknown, ok = true) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status: ok ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    }),
  );

describe("Chatwoot console page — fallback", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("shows the built-in chat when the console is configured but UNREACHABLE", async () => {
    // The regression under guard: status says configured, then the SSO call
    // fails (an outage). The agent must still get somewhere to work.
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/chatwoot/status")) return jsonResponse({ configured: true });
      if (url.includes("/api/chatwoot/sso")) return jsonResponse({ error: "boom" }, false);
      return jsonResponse({});
    });

    render(<ChatwootInboxPage />);

    await waitFor(() => {
      expect(screen.getByTestId("builtin-chat")).toBeDefined();
    });
  });

  it("shows the built-in chat when the console is not configured", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => jsonResponse({ configured: false }));

    render(<ChatwootInboxPage />);

    await waitFor(() => {
      expect(screen.getByTestId("builtin-chat")).toBeDefined();
    });
  });

  it("embeds the console when it IS reachable", async () => {
    // The other half: the fallback must not swallow the working case.
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/chatwoot/status")) return jsonResponse({ configured: true });
      if (url.includes("/api/chatwoot/sso"))
        return jsonResponse({ url: "https://cortoba-chatwoot.onrender.com/app/login" });
      return jsonResponse({});
    });

    render(<ChatwootInboxPage />);

    await waitFor(() => {
      const frame = document.querySelector("iframe");
      expect(frame).not.toBeNull();
      expect(frame?.getAttribute("src")).toContain("cortoba-chatwoot.onrender.com");
    });
    expect(screen.queryByTestId("builtin-chat")).toBeNull();
  });
});
