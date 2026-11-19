/**
 * The browser tab must show the Cortoba mark, not a broken icon.
 *
 * Three separate defects made it fail, and each one alone is enough:
 *
 *   1. `/favicon.ico` did not exist. Browsers request it even when the page
 *      declares no icon, and the SPA fallback answered it with `index.html`,
 *      so the tab received HTML where it expected an image.
 *   2. `index.html` pointed at `/logo.png` — the in-app 48x48 logo. A 48px
 *      bitmap is below every tab-icon size, so it rendered as a blur.
 *   3. `favicon.svg` was an empty rounded rectangle: a brand-coloured box with
 *      no path, i.e. a placeholder that looks like a deliberate design.
 *
 * These assertions read the SOURCE assets (`public/`), not the built `dist/`,
 * because `dist/` is gitignored and rebuilt — a guard on it would pass locally
 * and prove nothing about what the next build ships.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const publicDir = resolve(__dirname, "../../../../rfq-portal/public");
const indexHtml = readFileSync(resolve(__dirname, "../../../../rfq-portal/index.html"), "utf8");

function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(resolve(publicDir, file));
  // PNG IHDR: width/height are big-endian uint32 at offsets 16 and 20.
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("browser tab icon", () => {
  it("ships a real favicon.ico, so the default browser request is not HTML", () => {
    const file = resolve(publicDir, "favicon.ico");
    expect(existsSync(file)).toBe(true);
    const buf = readFileSync(file);
    // ICO header: reserved=0, type=1 (icon), count>=1.
    expect(buf.readUInt16LE(0)).toBe(0);
    expect(buf.readUInt16LE(2)).toBe(1);
    expect(buf.readUInt16LE(4)).toBeGreaterThanOrEqual(1);
    expect(statSync(file).size).toBeGreaterThan(1000);
  });

  it("draws the brand mark rather than an empty rectangle", () => {
    const svg = readFileSync(resolve(publicDir, "favicon.svg"), "utf8");
    const d = /<path[^>]*\sd="([^"]+)"/.exec(svg)?.[1] ?? "";
    // The real mark path is long; a placeholder has none at all.
    expect(d.length).toBeGreaterThan(1000);
    for (const stop of ["#EF4632", "#F57733", "#FBB12C", "#FCD845"]) {
      expect(svg).toContain(stop);
    }
  });

  it("links an icon at every size the browser may pick", () => {
    expect(indexHtml).toMatch(/rel="icon"[^>]*href="\/favicon\.ico"/);
    expect(indexHtml).toMatch(/rel="icon"[^>]*href="\/favicon\.svg"/);
    expect(indexHtml).toMatch(/rel="icon"[^>]*sizes="32x32"[^>]*href="\/icon-32\.png"/);
    expect(indexHtml).toMatch(/rel="apple-touch-icon"[^>]*href="\/icon-180\.png"/);
  });

  it("no longer points the tab icon at the 48px in-app logo", () => {
    // `logo.png` stays in use as an <img> in the app chrome; it must not be the
    // icon link, which is what made the tab blurry.
    expect(indexHtml).not.toMatch(/rel="icon"[^>]*href="\/logo\.png"/);
    expect(indexHtml).not.toMatch(/rel="apple-touch-icon"[^>]*href="\/logo\.png"/);
  });

  it("ships PNG icons at the sizes it declares", () => {
    expect(pngSize("icon-32.png")).toEqual({ width: 32, height: 32 });
    expect(pngSize("icon-180.png")).toEqual({ width: 180, height: 180 });
    expect(pngSize("icon-192.png")).toEqual({ width: 192, height: 192 });
    expect(pngSize("icon-512.png")).toEqual({ width: 512, height: 512 });
  });

  it("declares a manifest whose icons all exist", () => {
    const manifest = JSON.parse(readFileSync(resolve(publicDir, "site.webmanifest"), "utf8")) as {
      icons?: Array<{ src: string }>;
    };
    expect(indexHtml).toMatch(/rel="manifest"[^>]*href="\/site\.webmanifest"/);
    const icons = manifest.icons ?? [];
    expect(icons.length).toBeGreaterThanOrEqual(2);
    for (const icon of icons) {
      expect(existsSync(resolve(publicDir, icon.src.replace(/^\//, "")))).toBe(true);
    }
  });
});
