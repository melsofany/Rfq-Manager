import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * The operator read `business_verification_status: rejected` on the business
 * portfolio and concluded that WhatsApp sending was blocked pending Meta
 * verification. It was not: verification gates only the AUTHENTICATION template
 * category, and this account defines none — all 15 templates are UTILITY or
 * MARKETING, all approved, with 2,291 outbound messages in the last 14 days.
 *
 * The facts that settle that question live on THREE different objects (phone,
 * WABA, business portfolio) and the diagnose route reported only the first, so
 * the conclusion was unfalsifiable from inside the app. These guards keep all
 * three visible, and — more importantly — keep the route from ever claiming a
 * definite answer it does not have.
 */

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../../shared/permissions", () => ({
  guardFor: () => (_req: any, _res: any, next: any) => next(),
  guardByMethod: () => (_req: any, _res: any, next: any) => next(),
}));

/** Graph API replies keyed by the `fields=` string the route asks for. */
const graphReplies: Array<{ match: string; body: unknown }> = [];

vi.mock("../../modules/communications/service", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isWhatsAppConfigured: true,
    Whatsapp: {
      on: {},
      sendMessage: vi.fn(async () => ({ messages: [{ id: "wamid.X" }] })),
      markAsRead: vi.fn(async () => ({})),
      $$apiFetch$$: vi.fn(async (url: string) => {
        const hit = graphReplies.find((r) => url.includes(r.match));
        return { ok: true, json: async () => hit?.body ?? { data: [] } };
      }),
    },
  };
});

vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = (rows: any[]): any => {
    const api: any = {
      from: vi.fn(() => api),
      where: vi.fn(() => api),
      leftJoin: vi.fn(() => api),
      innerJoin: vi.fn(() => api),
      groupBy: vi.fn(() => api),
      orderBy: vi.fn(() => Promise.resolve(rows)),
      limit: vi.fn(() => Promise.resolve(rows)),
      then: (r: any) => Promise.resolve(rows).then(r),
    };
    return api;
  };
  return {
    ...actual,
    db: {
      select: vi.fn(() => chain([])),
      insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
    },
  };
});

const { default: router } = await import("../../modules/communications/routes");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api", router);
  return a;
}

function seedLiveAccount(templates: Array<{ name: string; category: string; status: string }>) {
  graphReplies.length = 0;
  graphReplies.push({
    match: "fields=display_phone_number",
    body: {
      display_phone_number: "+20 11 13331703",
      verified_name: "Cortoba supplies",
      quality_rating: "GREEN",
      status: "CONNECTED",
      name_status: "AVAILABLE_WITHOUT_REVIEW",
      messaging_limit_tier: "TIER_250",
    },
  });
  graphReplies.push({
    match: "fields=id,name,account_review_status",
    body: {
      id: "1554291813077204",
      name: "Cortoba supplies",
      account_review_status: "APPROVED",
      business_verification_status: "rejected",
      ownership_type: "SELF",
    },
  });
  graphReplies.push({
    match: "fields=owner_business_info",
    body: { owner_business_info: { id: "1707247070286279", name: "شركة قرطبة" } },
  });
  graphReplies.push({
    match: "fields=id,name,verification_status",
    body: { id: "1707247070286279", name: "شركة قرطبة", verification_status: "rejected" },
  });
  graphReplies.push({
    match: "/message_templates",
    body: { data: templates },
  });
}

beforeEach(() => {
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "1554291813077204";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "1128867323641989";
});

describe("diagnose reports the account-level verification facts", () => {
  it("surfaces the business portfolio status that was invisible before", async () => {
    seedLiveAccount([
      { name: "rfq_pdf_ar", category: "UTILITY", status: "APPROVED" },
      { name: "rfq_send_ar", category: "MARKETING", status: "APPROVED" },
    ]);

    const res = await request(app()).get("/api/whatsapp/diagnose");

    expect(res.status).toBe(200);
    expect(res.body.business.business_verification_status).toBe("rejected");
    expect(res.body.business.account_review_status).toBe("APPROVED");
    expect(res.body.business.portfolio.verification_status).toBe("rejected");
    expect(res.body.business.ownerBusiness.id).toBe("1707247070286279");
  });

  it("counts templates by category so the absence of AUTHENTICATION is provable", async () => {
    seedLiveAccount([
      { name: "a", category: "UTILITY", status: "APPROVED" },
      { name: "b", category: "UTILITY", status: "APPROVED" },
      { name: "c", category: "MARKETING", status: "APPROVED" },
    ]);

    const res = await request(app()).get("/api/whatsapp/diagnose");

    expect(res.body.templates.by_category).toEqual({ UTILITY: 2, MARKETING: 1 });
    expect(res.body.sendingImpact.authenticationTemplatesInUse).toBe(false);
    // The channel is NOT blocked: account review is approved, which is what
    // governs sending. Verification is a different signal.
    expect(res.body.sendingImpact.blocked).toBe(false);
  });

  it("does not report an unreadable status as blocked", async () => {
    // The WABA call returns nothing usable. Reporting `blocked: true` here would
    // be a definite claim built on no evidence — the same class of defect as
    // reporting an unread mailbox as empty.
    graphReplies.length = 0;
    graphReplies.push({ match: "fields=display_phone_number", body: { status: "CONNECTED" } });
    graphReplies.push({ match: "fields=id,name,account_review_status", body: {} });
    graphReplies.push({ match: "fields=owner_business_info", body: {} });
    graphReplies.push({ match: "/message_templates", body: { data: [] } });

    const res = await request(app()).get("/api/whatsapp/diagnose");

    expect(res.body.sendingImpact.blocked).toBeNull();
    expect(res.body.sendingImpact.accountReviewStatus).toBe("UNKNOWN");
  });

  it("flags AUTHENTICATION templates when the account really has them", async () => {
    seedLiveAccount([{ name: "otp_ar", category: "AUTHENTICATION", status: "APPROVED" }]);

    const res = await request(app()).get("/api/whatsapp/diagnose");

    expect(res.body.sendingImpact.authenticationTemplatesInUse).toBe(true);
    expect(res.body.sendingImpact.summary).toContain("AUTHENTICATION");
  });
  /**
   * The green tick. Measured live: business verification is `verified`, but the
   * display name is PENDING_REVIEW and the phone code is EXPIRED, and the badge
   * is false. The route must report those prerequisites individually — a bare
   * "no badge" leaves the operator guessing which condition to fix.
   */
  it("reports each green-badge prerequisite, not just the verdict", async () => {
    graphReplies.length = 0;
    graphReplies.push({
      match: "fields=display_phone_number",
      body: {
        display_phone_number: "+20 11 13331703",
        verified_name: "Cortoba supplies",
        name_status: "PENDING_REVIEW",
        code_verification_status: "EXPIRED",
        is_official_business_account: false,
        quality_rating: "GREEN",
        status: "CONNECTED",
      },
    });
    graphReplies.push({
      match: "fields=id,name,account_review_status",
      body: { account_review_status: "APPROVED", business_verification_status: "verified" },
    });
    graphReplies.push({ match: "fields=owner_business_info", body: {} });
    graphReplies.push({ match: "/message_templates", body: { data: [] } });

    const res = await request(app()).get("/api/whatsapp/diagnose");
    const oa = res.body.officialAccount;

    expect(oa.granted).toBe(false);
    expect(oa.grantedKnown).toBe(true);
    expect(oa.summary).toBe("missing_requirements");
    const byKey = Object.fromEntries(
      oa.requirements.map((r: { key: string; met: boolean }) => [r.key, r.met]),
    );
    // The two that really fail today, named rather than folded into one verdict.
    expect(byKey.business_verified).toBe(true);
    expect(byKey.display_name_approved).toBe(false);
    expect(byKey.phone_code_verified).toBe(false);
  });

  it("says the badge is Meta's to award once every prerequisite is met", async () => {
    graphReplies.length = 0;
    graphReplies.push({
      match: "fields=display_phone_number",
      body: {
        verified_name: "Cortoba supplies",
        name_status: "APPROVED",
        code_verification_status: "VERIFIED",
        is_official_business_account: false,
        status: "CONNECTED",
      },
    });
    graphReplies.push({
      match: "fields=id,name,account_review_status",
      body: { account_review_status: "APPROVED", business_verification_status: "verified" },
    });
    graphReplies.push({ match: "fields=owner_business_info", body: {} });
    graphReplies.push({ match: "/message_templates", body: { data: [] } });

    const res = await request(app()).get("/api/whatsapp/diagnose");

    expect(res.body.officialAccount.summary).toBe("eligible_pending_meta_review");
    expect(res.body.officialAccount.requirements.every((r: { met: boolean }) => r.met)).toBe(true);
  });

  it("never reports an unread badge as a definite no", async () => {
    graphReplies.length = 0;
    graphReplies.push({ match: "fields=display_phone_number", body: { status: "CONNECTED" } });
    graphReplies.push({ match: "fields=id,name,account_review_status", body: {} });
    graphReplies.push({ match: "fields=owner_business_info", body: {} });
    graphReplies.push({ match: "/message_templates", body: { data: [] } });

    const res = await request(app()).get("/api/whatsapp/diagnose");

    expect(res.body.officialAccount.grantedKnown).toBe(false);
    expect(res.body.officialAccount.summary).toBe("unknown");
  });
});
