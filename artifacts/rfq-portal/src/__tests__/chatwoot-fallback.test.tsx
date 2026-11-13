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

  it("embeds the console on OUR OWN ORIGIN rather than the upstream address", async () => {
    // The other half: the fallback must not swallow the working case.
    //
    // The upstream address must NOT appear in the frame's src. `onrender.com` is
    // on the Public Suffix List, so a frame pointed at the Chatwoot service is a
    // third-party frame and the browser refuses its session cookie — the agent
    // would be logged out inside it forever. Same-origin hosting (served by the
    // gateway's own origin) is what makes the console usable.
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
      const src = frame?.getAttribute("src") ?? "";
      expect(src).toBe("/app/login");
      expect(src).not.toContain("onrender.com");
    });
    expect(screen.queryByTestId("builtin-chat")).toBeNull();
  });

  // The SSO token is consumed the moment the iframe loads it (measured against
  // the deployed console: a second POST /auth/sign_in with the same token → 401).
  // The "open in a new tab" control therefore MUST NOT reuse the iframe's href —
  // that link is already dead by the time the user can click it, and the agent
  // sees a console that "does not open". It has to mint a fresh one-time link.
  it("mints a FRESH SSO link when opening in a new tab", async () => {
    const ssoUrls = [
      "https://cortoba-chatwoot.onrender.com/app/login?sso_auth_token=FIRST",
      "https://cortoba-chatwoot.onrender.com/app/login?sso_auth_token=SECOND",
    ];
    let ssoCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/chatwoot/status")) return jsonResponse({ configured: true });
      if (url.includes("/api/chatwoot/sso")) {
        const next = ssoUrls[Math.min(ssoCalls, ssoUrls.length - 1)];
        ssoCalls += 1;
        return jsonResponse({ url: next });
      }
      return jsonResponse({});
    });

    const opened: string[] = [];
    vi.spyOn(window, "open").mockImplementation((url) => {
      opened.push(String(url));
      return null;
    });

    render(<ChatwootInboxPage />);

    // The iframe consumed the first token on load.
    await waitFor(() => {
      expect(document.querySelector("iframe")?.getAttribute("src")).toContain("FIRST");
    });

    const button = await screen.findByRole("button", { name: /نافذة/ });
    button.click();

    await waitFor(() => {
      expect(opened).toHaveLength(1);
    });
    // The point of the guard: the opened link is NOT the consumed iframe link,
    // and it stays on our own origin so the session cookie is first-party.
    expect(opened[0]).toContain("SECOND");
    expect(opened[0]).not.toContain("FIRST");
    expect(opened[0]).not.toContain("onrender.com");
    expect(opened[0]).toContain("/app/login");
  });
});
