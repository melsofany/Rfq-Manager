import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * The app registered `https://cortoba-rfq.onrender.com/privacy` as its privacy
 * policy URL, and Meta crawls that URL when reviewing the business. It resolved
 * to the SPA catch-all, so the crawler received an empty `<div id="root">` and
 * no policy text at all — an app URL that yields no privacy policy is a review
 * liability, and the failure is invisible from a browser (the JS renders it).
 *
 * These guards pin the two things that make it work: a real static file with
 * the business identity, and a route that serves it BEFORE the SPA catch-all.
 */

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("repo root not found");
}

const repoRoot = findRepoRoot();
const privacyFile = path.join(repoRoot, "artifacts/rfq-portal/public/privacy.html");
const appSource = readFileSync(path.join(repoRoot, "artifacts/api-server/src/app.ts"), "utf8");

describe("the privacy policy URL Meta crawls serves real policy text", () => {
  it("ships a static privacy page", () => {
    expect(existsSync(privacyFile)).toBe(true);
  });

  it("carries the business identity a reviewer can match to the documents", () => {
    const html = readFileSync(privacyFile, "utf8");
    // The trade name and the natural person behind this sole-proprietorship are
    // the two identifiers the verification review compares against the tax card
    // and commercial register.
    expect(html).toContain("قرطبة للتوريدات");
    expect(html).toContain("إيمان كمال ابوزيد عطية");
    expect(html).toContain("432-972-587");
    expect(html).toContain("21618");
    expect(html).toContain("مرسى مطروح");
    expect(html).toContain("info@cortoba-supplies.com");
  });

  it("is self-contained, so a crawler with no JS still reads the policy", () => {
    const html = readFileSync(privacyFile, "utf8");
    // A crawler does not execute the SPA bundle. Inline styles keep the page
    // readable without any external asset, and there must be no root div that
    // implies the text arrives later.
    expect(html).not.toContain('id="root"');
    expect(html).not.toContain("<script");
    expect(html).toMatch(/<style>/);
    // Real prose, not a placeholder.
    expect(html.length).toBeGreaterThan(2000);
    expect(html).toContain("سياسة الخصوصية");
    expect(html).toContain("واتساب");
  });

  it("routes /privacy and /privacy-policy to the static file before the SPA catch-all", () => {
    const routeIdx = appSource.indexOf('app.get(["/privacy", "/privacy-policy"]');
    const catchAllIdx = appSource.indexOf("app.get(/.*/");
    expect(routeIdx).toBeGreaterThan(-1);
    expect(catchAllIdx).toBeGreaterThan(-1);
    // Order is the whole fix: registered after the catch-all it would never run.
    expect(routeIdx).toBeLessThan(catchAllIdx);
    expect(appSource).toContain('"privacy.html"');
  });
});
