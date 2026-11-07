import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseAppVersion,
  clearAppVersionCache,
  fetchLatestAppVersion,
} from "../../modules/field-ops/mobile-version";

describe("parseAppVersion", () => {
  it("reads versionCode from the v-prefixed tag and prefers the .apk asset", () => {
    const info = parseAppVersion({
      tag_name: "v11",
      name: "1.0.11",
      assets: [
        { name: "cortoba-field-ops-release.aab", browser_download_url: "https://x/aab" },
        { name: "cortoba-field-ops-release.apk", browser_download_url: "https://x/apk" },
      ],
    });
    expect(info.versionCode).toBe(11);
    expect(info.versionName).toBe("1.0.11");
    expect(info.downloadUrl).toBe("https://x/apk");
  });

  it("reads versionCode from legacy field-ops-vX.Y.Z tags via the patch", () => {
    const info = parseAppVersion({
      tag_name: "field-ops-v1.0.10",
      name: "Cortoba Field Ops v1.0.10",
      assets: [
        { name: "cortoba-field-ops-v1.0.10.apk", browser_download_url: "https://x/legacy.apk" },
      ],
    });
    expect(info.versionCode).toBe(10);
    expect(info.downloadUrl).toBe("https://x/legacy.apk");
  });

  it("falls back to 0 and null when the release has no usable tag or APK", () => {
    const info = parseAppVersion({ tag_name: "not-a-version", assets: [] });
    expect(info.versionCode).toBe(0);
    expect(info.downloadUrl).toBeNull();
  });
});

describe("fetchLatestAppVersion", () => {
  beforeEach(() => {
    clearAppVersionCache();
    vi.restoreAllMocks();
  });

  it("returns the parsed release and caches it across calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: "v12",
        name: "1.0.12",
        assets: [{ name: "app.apk", browser_download_url: "https://x/app.apk" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchLatestAppVersion();
    const second = await fetchLatestAppVersion();

    expect(first.versionCode).toBe(12);
    expect(first.downloadUrl).toBe("https://x/app.apk");
    expect(second.versionCode).toBe(12);
    // Cached: the GitHub API is hit only once for the whole TTL window.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchLatestAppVersion()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
