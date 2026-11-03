/**
 * Website module tests.
 *
 * Two layers:
 *  - pure helpers (`sanitizeContent`, `mergeContent`) tested against the real
 *    implementation — these are where a hostile payload or a partial save would
 *    otherwise corrupt the site's content;
 *  - the public + admin routes over supertest with the store and db stubbed, so
 *    the auth boundary and the response shape are exercised end to end.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Pure helpers: sanitizeContent (routes) ─────────────────────────────────
import { sanitizeContent } from "../../modules/website/routes";
import { mergeContent } from "../../modules/website/store";
import { DEFAULT_WEBSITE_CONTENT } from "@workspace/db";

describe("sanitizeContent", () => {
  it("drops unknown sections and unknown keys", () => {
    const out = sanitizeContent({
      hero: { headline: "x", ctaUrl: "y", evil: "z" },
      rogue: { a: 1 },
    } as any);
    expect(out.rogue).toBeUndefined();
    expect((out.hero as any).evil).toBeUndefined();
    expect(out.hero).toEqual({ headline: "x", subheadline: "", ctaLabel: "", ctaUrl: "y" });
  });

  it("coerces a non-string value to a string instead of storing the raw type", () => {
    const out = sanitizeContent({ contact: { phone1: 12345, email: null } } as any);
    expect(out.contact?.phone1).toBe("");
    expect(out.contact?.email).toBe("");
  });

  it("keeps only well-formed service items and trims empties", () => {
    const out = sanitizeContent({
      services: { items: [{ ar: "أ", en: "A" }, { ar: "", en: "" }, "nope", null] },
    } as any);
    expect(out.services?.items).toEqual([{ ar: "أ", en: "A" }]);
  });

  it("rejects a non-object payload entirely", () => {
    expect(sanitizeContent("nope" as any)).toEqual({});
    expect(sanitizeContent([1, 2] as any)).toEqual({});
    expect(sanitizeContent(null)).toEqual({});
  });

  it("caps a very long string so one field cannot blow up the row", () => {
    const huge = "a".repeat(9000);
    const out = sanitizeContent({ seo: { title: huge } } as any);
    expect(out.seo?.title.length).toBe(5000);
  });
});

// ── Pure helpers: mergeContent (store) ─────────────────────────────────────
describe("mergeContent", () => {
  it("returns the defaults when nothing is persisted", () => {
    expect(mergeContent({})).toEqual(DEFAULT_WEBSITE_CONTENT);
  });

  it("overlays a partial patch on the defaults without dropping siblings", () => {
    const merged = mergeContent({ hero: { headline: "جديد" } });
    expect(merged.hero.headline).toBe("جديد");
    // untouched sibling fields fall back to the default, not to ""
    expect(merged.hero.ctaLabel).toBe(DEFAULT_WEBSITE_CONTENT.hero.ctaLabel);
    expect(merged.about.paragraphs.length).toBe(DEFAULT_WEBSITE_CONTENT.about.paragraphs.length);
  });

  it("replaces arrays wholesale (a shorter services list is a valid edit)", () => {
    const merged = mergeContent({ services: { items: [{ ar: "واحد", en: "One" }] } });
    expect(merged.services.items).toEqual([{ ar: "واحد", en: "One" }]);
  });

  it("tolerates garbage persisted content", () => {
    expect(mergeContent("nope" as any)).toEqual(DEFAULT_WEBSITE_CONTENT);
    expect(mergeContent(null as any)).toEqual(DEFAULT_WEBSITE_CONTENT);
  });
});

// ── Routes ─────────────────────────────────────────────────────────────────
const store = vi.hoisted(() => {
  const state = {
    enabled: true,
    maintenanceMode: false,
    maintenanceMessage: null as string | null,
    content: {} as Record<string, unknown>,
    updatedBy: null as number | null,
    updatedAt: null as Date | null,
  };
  return {
    state,
    loadWebsiteSettings: vi.fn(async () => ({ ...state })),
    updateWebsiteSettings: vi.fn(async (patch: any) => {
      if (patch.enabled !== undefined) state.enabled = patch.enabled;
      if (patch.maintenanceMode !== undefined) state.maintenanceMode = patch.maintenanceMode;
      if (patch.maintenanceMessage !== undefined) state.maintenanceMessage = patch.maintenanceMessage;
      if (patch.content) state.content = { ...state.content, ...patch.content };
    }),
  };
});

vi.mock("../../modules/website/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../modules/website/store")>();
  return {
    ...actual,
    loadWebsiteSettings: store.loadWebsiteSettings,
    updateWebsiteSettings: store.updateWebsiteSettings,
  };
});

const renderClient = vi.hoisted(() => ({
  getWebsiteDeployStatus: vi.fn(async () => ({
    configured: true,
    serviceId: "srv-test",
    status: "live",
    commitSha: "abc123",
    commitMessage: "msg",
    createdAt: null,
    finishedAt: null,
    url: "https://dashboard.render.com/static/srv-test",
  })),
  triggerWebsiteDeploy: vi.fn(async () => ({ ok: true, deployId: "dep-1" })),
  isWebsiteDeployConfigured: vi.fn(() => true),
  websiteDeployConfigProblems: vi.fn(() => []),
}));

vi.mock("../../modules/website/render-client", () => renderClient);

let sessionState: any = { employeeId: 7, role: "admin" };
vi.mock("../../middlewares/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!sessionState.employeeId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req.session = { ...sessionState };
    next();
  },
}));

const auditInsert = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const chain = () => {
    const p: any = Promise.resolve([]);
    p.orderBy = () => p;
    p.limit = () => p;
    return p;
  };
  return {
    ...actual,
    db: {
      select: () => chain(),
      insert: () => ({ values: auditInsert }),
    },
  };
});

// The router-level guard is applied in routes/index.ts; here we mount the
// module directly and assert the routes themselves.
import websiteRouter from "../../modules/website/routes";
import websitePublicRouter from "../../modules/website/public";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(websitePublicRouter);
  app.use(websiteRouter);
  return app;
}

describe("website routes", () => {
  beforeEach(() => {
    sessionState = { employeeId: 7, role: "admin" };
    store.state.enabled = true;
    store.state.maintenanceMode = false;
    store.state.maintenanceMessage = null;
    store.state.content = {};
    vi.clearAllMocks();
  });

  it("serves the public content without a session", async () => {
    sessionState = {};
    const res = await request(buildApp()).get("/public/website");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("content");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    // never leaks the author or the settings row
    expect(res.body).not.toHaveProperty("updatedBy");
  });

  it("requires auth for the admin settings endpoint", async () => {
    sessionState = {};
    const res = await request(buildApp()).get("/website/settings");
    expect(res.status).toBe(401);
  });

  it("returns settings with deploy configuration for an admin", async () => {
    const res = await request(buildApp()).get("/website/settings");
    expect(res.status).toBe(200);
    expect(res.body.deployConfigured).toBe(true);
    expect(res.body.deployConfigProblems).toEqual([]);
  });

  it("persists a partial content save and audits it", async () => {
    const res = await request(buildApp())
      .put("/website/settings")
      .send({ content: { hero: { headline: "مرحبًا" } } });
    expect(res.status).toBe(200);
    expect(store.updateWebsiteSettings).toHaveBeenCalled();
    const patch = store.updateWebsiteSettings.mock.calls[0][0];
    expect(patch.updatedBy).toBe(7);
    expect(patch.content.hero.headline).toBe("مرحبًا");
    expect(auditInsert).toHaveBeenCalled();
  });

  it("refuses an oversized content payload", async () => {
    // Each field is capped at 5000 chars, so exceed the 256 KB budget with many
    // service items.
    const items = Array.from({ length: 40 }, () => ({
      ar: "أ".repeat(5000),
      en: "a".repeat(5000),
    }));
    const res = await request(buildApp())
      .put("/website/settings")
      .send({ content: { services: { items } } });
    expect(res.status).toBe(413);
    expect(store.updateWebsiteSettings).not.toHaveBeenCalled();
  });

  it("triggers a deploy and records it", async () => {
    const res = await request(buildApp()).post("/website/deploy").send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(renderClient.triggerWebsiteDeploy).toHaveBeenCalled();
  });

  it("reports a failed deploy as a 502", async () => {
    renderClient.triggerWebsiteDeploy.mockResolvedValueOnce({
      ok: false,
      deployId: null,
      error: "quota",
    });
    const res = await request(buildApp()).post("/website/deploy").send({});
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("quota");
  });
});
