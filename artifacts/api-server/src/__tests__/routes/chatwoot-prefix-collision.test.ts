import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { chatwootOwnsPath, chatwootRequiresAuth } from "../../modules/chatwoot/proxy";

/**
 * The console is mounted at the ROOT, so every path it claims is taken away
 * from the app. Claiming one the app uses is not a subtle bug: the portal's own
 * CSS and JS were sent to Chatwoot, which answered HTML, so the page rendered
 * unstyled and its bundle 404'd.
 *
 * This reads the REAL route table out of the portal source and the REAL build
 * output directory rather than a hand-kept list, because a hand-kept list is
 * exactly what drifted.
 */

const repoRoot = path.resolve(__dirname, "../../../../..");
const appTsx = path.join(repoRoot, "artifacts/rfq-portal/src/App.tsx");
const viteConfig = path.join(repoRoot, "artifacts/rfq-portal/vite.config.ts");

/** Every top-level segment the portal's router can render. */
function portalRouteSegments(): string[] {
  const src = fs.readFileSync(appTsx, "utf8");
  const paths = [...src.matchAll(/path="([^"]+)"/g)].map((m) => m[1]);
  const segments = new Set<string>();
  for (const p of paths) {
    const first = p.split("/").filter(Boolean)[0];
    if (first) segments.add(first);
  }
  return [...segments];
}

/**
 * Where Vite writes the portal's bundles, as a URL segment.
 *
 * Read from the config's `assetsDir` when set, else Vite's default `assets`.
 * The default is the case that bit: nothing in the portal mentions `/assets`,
 * so a source-only check would have missed it.
 */
function portalAssetSegment(): string {
  const src = fs.readFileSync(viteConfig, "utf8");
  const m = /assetsDir:\s*["']([^"']+)["']/.exec(src);
  const dir = m ? m[1] : "assets";
  return dir.replace(/^\/+|\/+$/g, "");
}

describe("the console never claims a path the portal owns", () => {
  it("does not claim any portal route", () => {
    const collisions = portalRouteSegments().filter((seg) => chatwootOwnsPath(`/${seg}`));
    expect(
      collisions,
      `these portal routes are claimed by the Chatwoot proxy, so the console ` +
        `would answer for them instead of the SPA: ${collisions.join(", ")}`,
    ).toEqual([]);
  });

  it("does not claim the portal's built-asset directory", () => {
    // `/assets` is Vite's default. It is the one collision that is invisible in
    // the portal source, because the path only exists after a build.
    const seg = portalAssetSegment();
    expect(
      chatwootOwnsPath(`/${seg}/index-abc123.js`),
      `the portal serves its bundles from /${seg}; the console must not claim it`,
    ).toBe(false);
    expect(chatwootOwnsPath(`/${seg}/index-abc123.css`)).toBe(false);
  });

  it("still claims the console's own paths", () => {
    // The guard above must not be satisfied by claiming nothing at all.
    for (const p of [
      "/app",
      "/app/accounts/3/dashboard",
      "/api/v1/accounts/3/conversations",
      "/auth/sign_in",
      "/super_admin",
      "/vite/assets/dashboard.js",
      "/packs/js/app.js",
      "/manifest.json",
    ]) {
      expect(chatwootOwnsPath(p), p).toBe(true);
    }
  });

  it("keeps supplier data guarded while assets are not", () => {
    // The two halves of the split, asserted together so a change to one that
    // silently moves the other is caught.
    for (const p of ["/app/accounts/3", "/api/v1/profile", "/rails/active_storage/x"]) {
      expect(chatwootRequiresAuth(p), p).toBe(true);
    }
    for (const p of ["/vite/assets/x.js", "/packs/js/app.js", "/manifest.json"]) {
      expect(chatwootRequiresAuth(p), p).toBe(false);
    }
  });
});
