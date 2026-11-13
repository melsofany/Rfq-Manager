import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Guards the Chatwoot SSO bridge. Four defects were found by probing the LIVE
 * console, and each one alone made the console unreachable. They are pinned here
 * because all four fail SILENTLY: the agent sees only a generic Arabic error, and
 * nothing in the logs says which of Chatwoot's rules was broken.
 *
 *   1. The generated password had no special character, so
 *      `POST /platform/api/v1/users` answered
 *      422 "Password must contain at least 1 special character".
 *   2. The email lookup read `u.email` off `GET /accounts/:id/account_users`,
 *      which renders raw account_users rows carrying `user_id` and no email — so
 *      it was ALWAYS undefined.
 *   3. Users that already existed never got a `platform_app_permissibles` row, so
 *      `GET /users/:id/login` answered 401 "Non permissible resource".
 *   4. `POST /accounts/:id/account_users` is `find_or_initialize_by` + `update!`
 *      with `role` permitted, so calling it for an existing member REWRITES their
 *      role — measured live, an `administrator` became `agent`.
 *
 * The tests drive the real route with `fetch` stubbed, so they assert the
 * requests the bridge actually makes rather than the shape of its source.
 */

const employeeRow = vi.hoisted(() => ({
  id: 7,
  name: "Ahmed Youssef",
  email: "info@cortoba-supplies.com",
  role: "admin",
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(async () => [employeeRow]) })),
    })),
  },
  employeesTable: { id: "id" },
  whatsappChatsTable: { id: "id" },
}));

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.session = { employeeId: employeeRow.id };
    next();
  },
  // The module under test mounts routes with `requireRole` too; a mock that
  // omits it fails at import with "requireRole is not a function" and every
  // case in the file goes red for a reason unrelated to what it asserts.
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../../shared/permissions", () => ({
  guardFor: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../../modules/communications/service", () => ({
  sendWhatsAppText: vi.fn(),
}));

vi.mock("../../modules/chatwoot/bridge", () => ({
  isChatwootConfigured: true,
  phoneForConversation: vi.fn(),
}));

interface Call {
  url: string;
  method: string;
  body: any;
}

const calls: Call[] = [];

/** A scripted Chatwoot that records every request the bridge makes. */
function stubFetch(handlers: {
  ensureUser?: (body: any) => { status: number; json?: any };
  accountUsers?: () => { status: number; json?: any };
  login?: () => { status: number; json?: any };
}) {
  return vi.fn(async (url: string, init: any = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });

    const respond = (status: number, json?: any) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => json,
        text: async () => JSON.stringify(json ?? {}),
      }) as any;

    if (url.endsWith("/platform/api/v1/users") && method === "POST") {
      const h = handlers.ensureUser?.(body) ?? { status: 200, json: { id: 42 } };
      return respond(h.status, h.json);
    }
    if (url.includes("/account_users") && method === "GET") {
      const h = handlers.accountUsers?.() ?? { status: 200, json: [] };
      return respond(h.status, h.json);
    }
    if (url.includes("/account_users") && method === "POST") {
      return respond(200, {});
    }
    if (url.endsWith("/login")) {
      const h = handlers.login?.() ?? { status: 200, json: { url: "https://cw/app/login?t=1" } };
      return respond(h.status, h.json);
    }
    return respond(404, { error: "unexpected" });
  });
}

const env = process.env;
beforeEach(() => {
  calls.length = 0;
  vi.resetModules();
  process.env = { ...env };
  process.env.CHATWOOT_URL = "https://cortoba-chatwoot.onrender.com";
  process.env.CHATWOOT_ACCOUNT_ID = "3";
  process.env.CHATWOOT_PLATFORM_TOKEN = "cwplat_test";
});

afterEach(() => {
  process.env = env;
  vi.unstubAllGlobals();
});

async function callSso() {
  const { default: router } = await import("../../modules/chatwoot/index");
  const express = (await import("express")).default;
  const request = (await import("supertest")).default;
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  return request(app).get("/api/chatwoot/sso");
}

describe("Chatwoot SSO — user provisioning", () => {
  it("sends a password that satisfies the special-character policy", async () => {
    vi.stubGlobal("fetch", stubFetch({}));
    const res = await callSso();

    expect(res.status).toBe(200);
    const create = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/platform/api/v1/users"),
    );
    expect(create, "the bridge must provision the user through the platform API").toBeTruthy();
    // Chatwoot: `config.password_required_special_character_count = 1`. The old
    // `Math.random().toString(36)` generator produced `[a-z0-9]` only, which is
    // what caused the live 422.
    expect(create!.body.password).toMatch(/[!@#$%^&*()_+\-=[\]{}|.,:;?~]/);
    expect(create!.body.password.length).toBeGreaterThanOrEqual(8);
  });

  it("never posts a placeholder email — the real address is what resolves the user", async () => {
    vi.stubGlobal("fetch", stubFetch({}));
    await callSso();

    const create = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/platform/api/v1/users"),
    );
    // `User.from_email` matches on this value; a placeholder would grant the
    // permission to a different, nonexistent user and leave the 401 in place.
    expect(create!.body.email).toBe("info@cortoba-supplies.com");
  });

  it("does not create the user twice — one idempotent upsert call", async () => {
    vi.stubGlobal("fetch", stubFetch({}));
    await callSso();

    const creates = calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/platform/api/v1/users"),
    );
    expect(creates).toHaveLength(1);
  });

  it("surfaces a provisioning failure instead of minting a broken link", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({ ensureUser: () => ({ status: 422, json: { message: "password" } }) }),
    );
    const res = await callSso();

    expect(res.status).toBe(502);
    expect(calls.some((c) => c.url.endsWith("/login"))).toBe(false);
  });
});

describe("Chatwoot SSO — role safety", () => {
  it("does NOT rewrite the role of an existing account member", async () => {
    // The user is already a member (and an administrator) — the bridge must not
    // touch them. Measured live: this exact call demoted an admin to agent.
    vi.stubGlobal(
      "fetch",
      stubFetch({
        accountUsers: () => ({ status: 200, json: [{ user_id: 42, role: "administrator" }] }),
      }),
    );
    const res = await callSso();

    expect(res.status).toBe(200);
    const roleWrites = calls.filter((c) => c.method === "POST" && c.url.includes("/account_users"));
    expect(roleWrites, "an existing member's role must never be rewritten").toHaveLength(0);
  });

  it("adds a role only when the user is not yet a member", async () => {
    vi.stubGlobal("fetch", stubFetch({ accountUsers: () => ({ status: 200, json: [] }) }));
    const res = await callSso();

    expect(res.status).toBe(200);
    const attach = calls.find((c) => c.method === "POST" && c.url.includes("/account_users"));
    expect(attach, "a brand-new member still needs to be attached").toBeTruthy();
    expect(attach!.body.user_id).toBe(42);
    expect(attach!.body.role).toBe("administrator"); // employee role is "admin"
  });

  it("skips the attach when the member list cannot be read, rather than guessing a role", async () => {
    vi.stubGlobal("fetch", stubFetch({ accountUsers: () => ({ status: 500, json: {} }) }));
    const res = await callSso();

    // A failed list must not become a blind role write — the SSO link is still
    // minted, because the user may already be attached.
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/account_users"))).toBe(false);
  });
});

describe("Chatwoot SSO — link minting", () => {
  it("returns the one-time URL Chatwoot issued", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({ login: () => ({ status: 200, json: { url: "https://cw/app/login?t=abc" } }) }),
    );
    const res = await callSso();

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://cw/app/login?t=abc");
  });

  it("reports a login failure instead of returning an unusable URL", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({ login: () => ({ status: 401, json: { error: "Non permissible resource" } }) }),
    );
    const res = await callSso();

    expect(res.status).toBe(502);
    expect(res.body.url).toBeUndefined();
  });
});

/**
 * Source-level guards for the exact expressions that caused the live failures.
 *
 * The behavioural tests above cover the behaviour; these pin the two SHAPES that
 * broke it, because both are the kind of "reasonable-looking" line that a later
 * refactor reintroduces:
 *
 *   - `Math.random().toString(36)` reads like a fine random password but yields
 *     `[a-z0-9]`, which Chatwoot rejects (422).
 *   - reading `u.email`/`u.user` off `/account_users` reads like the natural way
 *     to match an address, but that endpoint returns neither, so it silently
 *     never matches and existing users never get the permission row (401).
 */
describe("Chatwoot SSO — source guards for the regressions that failed live", () => {
  it("never generates a password from Math.random().toString(36)", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../modules/chatwoot/index.ts", import.meta.url), "utf8"),
    );
    // Strip comments so the explanatory prose about the old bug is not a hit.
    const code = src
      .split("\n")
      .filter((l: string) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/Math\.random\(\)\.toString\(36\)/);
  });

  it("does not read an email off the account_users payload", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../modules/chatwoot/index.ts", import.meta.url), "utf8"),
    );
    const code = src
      .split("\n")
      .filter((l: string) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
      .join("\n");
    // The endpoint renders raw rows: `{id, account_id, user_id, role, ...}`.
    expect(code).not.toMatch(/u\.email\s*\?\?/);
    expect(code).not.toMatch(/u\.user\?\.email/);
  });
});
