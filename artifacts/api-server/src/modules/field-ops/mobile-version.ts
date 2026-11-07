/**
 * Latest published app version — fetched from the public GitHub Releases feed.
 *
 * The mobile app checks `GET /api/mobile/version` and, when the returned
 * `versionCode` is higher than the one it is running, downloads the release APK
 * and installs it in place. This removes the manual APK hand-off to the field
 * representatives.
 */

export interface AppVersionInfo {
  versionCode: number;
  versionName: string;
  downloadUrl: string | null;
}

const RELEASES_URL = "https://api.github.com/repos/melsofany/Rfq-Manager/releases/latest";

/** Keep the unauthenticated GitHub API within its hourly rate limit. */
const CACHE_TTL_MS = 10 * 60 * 1000;

let cache: { info: AppVersionInfo; at: number } | null = null;

export function clearAppVersionCache(): void {
  cache = null;
}

/** Parse a GitHub release payload into the shape the app consumes. */
export function parseAppVersion(release: {
  tag_name?: string;
  name?: string;
  assets?: { name?: string; browser_download_url?: string }[];
}): AppVersionInfo {
  const tag = release.tag_name ?? "";
  // versionCode is encoded as the last number in the tag: `v11` for the new
  // automated releases, or the patch segment of legacy `field-ops-v1.0.11` tags.
  const numbers = tag.match(/\d+/g);
  const last = numbers?.[numbers.length - 1];
  const versionCode = last ? Number.parseInt(last, 10) : 0;
  const apkAsset = (release.assets ?? []).find((a) => (a.name ?? "").endsWith(".apk"));
  return {
    versionCode: Number.isFinite(versionCode) ? versionCode : 0,
    versionName: release.name ?? tag,
    downloadUrl: apkAsset?.browser_download_url ?? null,
  };
}

export async function fetchLatestAppVersion(): Promise<AppVersionInfo> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.info;
  }
  const res = await fetch(RELEASES_URL, {
    headers: { "User-Agent": "cortoba-rfq-api", Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`github releases responded ${res.status}`);
  const release = (await res.json()) as Parameters<typeof parseAppVersion>[0];
  const info = parseAppVersion(release);
  cache = { info, at: Date.now() };
  return info;
}
