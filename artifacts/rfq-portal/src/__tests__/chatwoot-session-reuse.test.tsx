/**
 * The console answered "Active session limit reached" instead of loading.
 *
 * Every visit to /whatsapp minted a FRESH Chatwoot SSO link, and each mint
 * creates a Chatwoot session. Chatwoot caps them (`MAX_USER_SESSIONS`, 25 by
 * default), so the cap was reached by one employee's own browser and the
 * console refused to sign in.
 *
 * These tests drive the REAL page, so they assert what the agent sees — the
 * "session reuse" behaviour is only real if the page actually reuses one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import ChatwootInboxPage, { hasConsoleSession } from "../modules/communications/pages/chatwoot";

vi.mock("../modules/communications/pages/index", () => ({
  default: () => <div data-testid="builtin-chat">BUILTIN_CHAT</div>,
}));
vi.mock("@/components/Layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/contexts/LanguageContext", () => ({
  useLanguage: () => ({ t: (k: string) => k, dir: "rtl" }),
}));

const jsonResponse = (body: unknown, ok = true) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status: ok ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    }),
  );

const CREDS = { "access-token": "tok", client: "cli", uid: "u@x.test" };

/** Write the console's own cookie the way Chatwoot's dashboard does. */
function setConsoleCookie(value: unknown): void {
  document.cookie = `cw_d_session_info=${encodeURIComponent(JSON.stringify(value))}`;
}

function clearCookies(): void {
  document.cookie.split("; ").forEach((c) => {
    const name = c.split("=")[0];
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  });
}

describe("hasConsoleSession", () => {
  beforeEach(clearCookies);
  afterEach(clearCookies);

  it("is true for a real credential", () => {
    setConsoleCookie(CREDS);
    expect(hasConsoleSession()).toBe(true);
  });

  it("is false without the cookie — a mint is still correct", () => {
    expect(hasConsoleSession()).toBe(false);
  });

  it("is false for a truncated credential", () => {
    // A partial cookie must NOT count: framing a console that can never sign in
    // is worse than spending one extra mint.
    setConsoleCookie({ "access-token": "tok" });
    expect(hasConsoleSession()).toBe(false);
  });

  it("is false for unparseable junk rather than throwing", () => {
    document.cookie = "cw_d_session_info=not-json";
    expect(hasConsoleSession()).toBe(false);
  });
});

describe("the console page reuses a session instead of minting on every load", () => {
  beforeEach(() => {
    clearCookies();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    clearCookies();
    vi.restoreAllMocks();
  });

  it("does NOT mint when a session already exists", async () => {
    setConsoleCookie(CREDS);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/chatwoot/status")) return jsonResponse({ configured: true });
      if (url.includes("/api/chatwoot/sso")) return jsonResponse({ url: "https://x/app/login" });
      return jsonResponse({});
    });

    render(<ChatwootInboxPage />);

    await waitFor(() => {
      const frame = document.querySelector("iframe");
      expect(frame?.getAttribute("src")).toBe("/whatsapp/console/");
    });
    // The mint is the thing that exhausts the cap — it must not be called.
    const minted = fetchMock.mock.calls.some((c) => String(c[0]).includes("/api/chatwoot/sso"));
    expect(minted).toBe(false);
  });

  it("still mints when there is no session", async () => {
    // The first visit must sign in; reuse is an optimisation, not a substitute.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/chatwoot/status")) return jsonResponse({ configured: true });
      if (url.includes("/api/chatwoot/sso"))
        return jsonResponse({ url: "https://x.test/app/login?t=1" });
      return jsonResponse({});
    });

    render(<ChatwootInboxPage />);

    await waitFor(() => {
      const frame = document.querySelector("iframe");
      expect(frame?.getAttribute("src")).toContain("/app/login");
    });
    const minted = fetchMock.mock.calls.some((c) => String(c[0]).includes("/api/chatwoot/sso"));
    expect(minted).toBe(true);
  });
});
