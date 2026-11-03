/**
 * Render client tests.
 *
 * The client talks to Render's REST API and has to normalise its two response
 * shapes (a bare deploy array, and the `[{ deploy: … }]` envelope). These tests
 * pin that parsing and the "not configured" path, with `fetch` stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getWebsiteDeployStatus,
  triggerWebsiteDeploy,
  isWebsiteDeployConfigured,
  websiteDeployConfigProblems,
} from "../modules/website/render-client";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  process.env.RENDER_API_KEY = "rnd_test";
  process.env.WEBSITE_RENDER_SERVICE_ID = "srv-test";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RENDER_API_KEY;
  delete process.env.WEBSITE_RENDER_SERVICE_ID;
});

describe("configuration", () => {
  it("is unconfigured when either value is missing", () => {
    delete process.env.RENDER_API_KEY;
    expect(isWebsiteDeployConfigured()).toBe(false);
    expect(websiteDeployConfigProblems().length).toBeGreaterThan(0);
    delete process.env.WEBSITE_RENDER_SERVICE_ID;
    expect(websiteDeployConfigProblems().length).toBe(2);
  });

  it("reports configured when both are present", () => {
    expect(isWebsiteDeployConfigured()).toBe(true);
    expect(websiteDeployConfigProblems()).toEqual([]);
  });
});

describe("getWebsiteDeployStatus", () => {
  it("does not call Render when unconfigured", async () => {
    delete process.env.RENDER_API_KEY;
    const s = await getWebsiteDeployStatus();
    expect(s.configured).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses the bare array shape", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: "dep-1",
          status: "live",
          commit: { id: "sha123", message: "hello" },
          createdAt: "2026-01-01T00:00:00Z",
          finishedAt: "2026-01-01T00:05:00Z",
        },
      ],
    });
    const s = await getWebsiteDeployStatus();
    expect(s.status).toBe("live");
    expect(s.commitSha).toBe("sha123");
    expect(s.commitMessage).toBe("hello");
  });

  it("parses the {deploy: …} envelope shape", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ deploy: { id: "dep-2", status: "build_failed" } }],
    });
    const s = await getWebsiteDeployStatus();
    expect(s.status).toBe("build_failed");
  });

  it("reports an API error without throwing", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    const s = await getWebsiteDeployStatus();
    expect(s.configured).toBe(true);
    expect(s.error).toContain("401");
  });
});

describe("triggerWebsiteDeploy", () => {
  it("sends a clearCache flag when asked", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ id: "dep-9" }) });
    const r = await triggerWebsiteDeploy(true);
    expect(r).toEqual({ ok: true, deployId: "dep-9" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ clearCache: "clear" });
  });

  it("surfaces a Render error message", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ message: "rate limited" }),
    });
    const r = await triggerWebsiteDeploy();
    expect(r.ok).toBe(false);
    expect(r.error).toBe("rate limited");
  });
});
