import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * The console proxy must not be an open door.
 *
 * It was: the mount forwarded every request to the console, so anyone who knew
 * the URL reached Chatwoot's own login form — a second credential surface for a
 * product our operators have no account on, on a service that was made private
 * precisely to avoid that. The guard is the SAME permission rule as the
 * `/whatsapp` page it replaces, and these tests pin both halves: the refusal for
 * an anonymous visitor, and the redirect (not JSON) that a browser can act on.
 */

const loadAccess = vi.hoisted(() => vi.fn());
const allowsAny = vi.hoisted(() => vi.fn());
vi.mock("../../shared/permissions", () => ({
  loadAccess,
  allowsAny,
}));

vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** An app whose session is whatever the test sets, then the real guard. */
async function appWithSession(session: Record<string, unknown> | undefined) {
  const { chatwootConsoleGuard } = await import("../../modules/chatwoot/proxy");
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { session?: unknown }).session = session;
    next();
  });
  app.use("/whatsapp/console", chatwootConsoleGuard(), (_req, res) => {
    res.status(200).send("CONSOLE");
  });
  return app;
}

describe("the console proxy requires an authenticated, permitted employee", () => {
  beforeEach(() => {
    vi.resetModules();
    loadAccess.mockReset();
    allowsAny.mockReset();
  });

  it("redirects an anonymous document request to the login page", async () => {
    const app = await appWithSession(undefined);
    const res = await request(app)
      .get("/whatsapp/console/")
      .set("Accept", "text/html,application/xhtml+xml");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login");
    expect(res.text).not.toContain("CONSOLE");
  });

  it("answers an anonymous XHR with 401 rather than a redirect", async () => {
    // The console's own fetch calls cannot follow a redirect to an HTML login
    // page; they need a status they can branch on.
    const app = await appWithSession(undefined);
    const res = await request(app)
      .get("/whatsapp/console/api/v1/conversations")
      .set("Accept", "application/json");
    expect(res.status).toBe(401);
  });

  it("lets a permitted employee through", async () => {
    loadAccess.mockResolvedValue({ permissions: {} });
    allowsAny.mockReturnValue(true);
    const app = await appWithSession({ employeeId: 247 });
    const res = await request(app).get("/whatsapp/console/").set("Accept", "text/html");
    expect(res.status).toBe(200);
    expect(res.text).toContain("CONSOLE");
    expect(loadAccess).toHaveBeenCalledWith(247);
  });

  it("sends an authenticated employee WITHOUT the permission back to the app", async () => {
    loadAccess.mockResolvedValue({ permissions: {} });
    allowsAny.mockReturnValue(false);
    const app = await appWithSession({ employeeId: 99 });
    const res = await request(app).get("/whatsapp/console/").set("Accept", "text/html");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/");
  });

  it("refuses a session whose employee row cannot be read", async () => {
    // A deleted/deactivated employee must not be able to reach the console just
    // because a stale session cookie still names them.
    loadAccess.mockResolvedValue(null);
    const app = await appWithSession({ employeeId: 5 });
    const res = await request(app).get("/whatsapp/console/").set("Accept", "text/html");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login");
  });

  it("fails CLOSED when the permission lookup throws", async () => {
    // A guard that opens on its own error is not a guard: this is the surface
    // where a failed read exposes every supplier conversation at once.
    loadAccess.mockRejectedValue(new Error("db down"));
    const app = await appWithSession({ employeeId: 7 });
    const res = await request(app).get("/whatsapp/console/").set("Accept", "text/html");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login");
    expect(res.text).not.toContain("CONSOLE");
  });

  it("checks the SAME permission set as the /whatsapp page it replaces", async () => {
    loadAccess.mockResolvedValue({ permissions: {} });
    allowsAny.mockReturnValue(true);
    const app = await appWithSession({ employeeId: 1 });
    await request(app).get("/whatsapp/console/").set("Accept", "text/html");
    expect(allowsAny).toHaveBeenCalledWith(expect.anything(), ["whatsapp", "whatsapp:chats"]);
  });

  it("is actually MOUNTED on the console route in app.ts", async () => {
    // A guard that works but is not wired protects nothing, and a test that
    // builds its own app cannot tell the difference — that is exactly how the
    // open door survived review the first time. This reads the real mount.
    //
    // Asserted on BEHAVIOUR (the guard is constructed and invoked before the
    // proxy), not on one exact call shape: the mount gained an ownership filter
    // when the console moved to the root, and a regex pinned to the old shape
    // would fail while the guard was in fact still wired.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../../app.ts", import.meta.url), "utf8");
    const mountIndex = source.indexOf("app.use(chatwootConsoleBase");
    expect(mountIndex, "the console mount must exist in app.ts").toBeGreaterThan(-1);
    const before = source.slice(0, mountIndex);
    expect(before, "the guard must be constructed before the mount").toContain(
      "chatwootConsoleGuard()",
    );
    // The guard is invoked through the `gate` middleware (it also filters by
    // path ownership), so the assertion is that the gate is what the mount
    // uses AND that the gate calls the guard — not that `guard(` appears in the
    // mount call itself.
    const mountLine = source.slice(mountIndex, source.indexOf("\n", mountIndex));
    expect(mountLine, "the mount must use the gate middleware").toMatch(
      /app\.use\(chatwootConsoleBase,\s*gate\)/,
    );
    const gateIndex = source.indexOf("const gate = (req");
    expect(gateIndex, "the gate middleware must be defined").toBeGreaterThan(-1);
    const gateBlock = source.slice(gateIndex, gateIndex + 300);
    expect(gateBlock, "the gate must invoke the guard").toMatch(/guard\(req, res/);
    expect(gateBlock, "the gate must only claim Chatwoot's paths").toMatch(
      /chatwootOwnsPath\(req\.path\)/,
    );
  });
});
