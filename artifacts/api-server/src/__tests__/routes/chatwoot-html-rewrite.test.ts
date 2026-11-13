import { describe, it, expect } from "vitest";
import { normalisePrefix, rewriteChatwootHtml } from "../../modules/chatwoot/html-rewrite";

/**
 * The console is served under a path prefix on the gateway's own origin.
 *
 * Two platform facts make a DOCUMENT rewrite sufficient, and both were measured
 * against the running release rather than assumed — if either changes, these
 * tests are where it should surface:
 *
 *   1. Chatwoot's chunks are imported with RELATIVE specifiers, so `<base>`
 *      governs them. Nothing has to be rehashed.
 *   2. `createWebHistory()` takes no argument, so it reads `<base href>`. The
 *      injected tag IS the routing fix.
 *
 * A rewrite that silently missed would produce a console that loads and then
 * navigates nowhere — the failure this file exists to catch.
 */

const OPTS = { prefix: "/whatsapp", host: "https://cortoba-rfq.onrender.com" };

describe("normalisePrefix", () => {
  it("normalises the shapes a caller may pass", () => {
    expect(normalisePrefix("/whatsapp")).toBe("/whatsapp");
    expect(normalisePrefix("whatsapp")).toBe("/whatsapp");
    expect(normalisePrefix("/whatsapp/")).toBe("/whatsapp");
    expect(normalisePrefix("/whatsapp///")).toBe("/whatsapp");
  });

  it("treats the root and an empty prefix as the empty prefix, not '/'", () => {
    // "" builds `<base href="/">`; a leading slash would build a `//` base,
    // which a browser reads as a PROTOCOL-RELATIVE URL (host = "whatsapp").
    expect(normalisePrefix("")).toBe("");
    expect(normalisePrefix("/")).toBe("");
  });
});

describe("rewriteChatwootHtml", () => {
  const doc = (body = "") =>
    `<html><head><title>Chatwoot</title></head><body>${body}</body></html>`;

  it("injects <base> as the FIRST element of <head>", () => {
    const out = rewriteChatwootHtml(doc(), OPTS);
    expect(out).toContain('<base href="/whatsapp/">');
    // Before the assets that depend on it.
    expect(out.indexOf("<base")).toBeLessThan(out.indexOf("<title"));
  });

  it("removes an existing <base>, so only ours can win", () => {
    // A browser honours the FIRST <base href>; a stale upstream tag would
    // silently send every relative chunk to the wrong place.
    const upstream = `<html><head><base href="/"><title>x</title></head></html>`;
    const out = rewriteChatwootHtml(upstream, OPTS);
    expect(out.match(/<base/g)?.length).toBe(1);
    expect(out).toContain('<base href="/whatsapp/">');
    expect(out).not.toContain('<base href="/">');
  });

  it("still produces a usable document when <head> is missing", () => {
    const out = rewriteChatwootHtml("<html><body>x</body></html>", OPTS);
    expect(out.startsWith('<base href="/whatsapp/">')).toBe(true);
  });

  it("does NOT rewrite /vite/assets — the proxy serves them under the prefix", () => {
    // Rewriting hashed references the browser already resolves would be the
    // fragile path. The proxy owns this one, and the test guards the choice so
    // a "helpful" future rewrite is caught.
    const withAsset = doc('<script src="/vite/assets/dashboard-Cffrt2c3.js"></script>');
    const out = rewriteChatwootHtml(withAsset, OPTS);
    expect(out).toContain('src="/vite/assets/dashboard-Cffrt2c3.js"');
  });

  it("points hostURL at the same-origin prefixed URL", () => {
    // Chatwoot builds absolute links from hostURL; leaving it pointing at the
    // private upstream address would hand the browser links it cannot reach.
    const withHost = doc(
      `<script>window.chatwootConfig = { hostURL: 'https://cortoba-chatwoot.onrender.com' }</script>`,
    );
    const out = rewriteChatwootHtml(withHost, OPTS);
    expect(out).toContain("hostURL: 'https://cortoba-rfq.onrender.com/whatsapp'");
    expect(out).not.toContain("cortoba-chatwoot.onrender.com");
  });

  it("makes apiHost and websocketURL explicit for the same origin", () => {
    const withCfg = doc(`<script>window.chatwootConfig = { hostURL: 'x' }</script>`);
    const out = rewriteChatwootHtml(withCfg, OPTS);
    expect(out).toContain("apiHost: 'https://cortoba-rfq.onrender.com/whatsapp'");
    expect(out).toContain("websocketURL: 'https://cortoba-rfq.onrender.com/whatsapp'");
  });

  it("leaves a document without chatwootConfig untouched apart from <base>", () => {
    const out = rewriteChatwootHtml("<html><head></head><body>plain</body></html>", OPTS);
    expect(out).not.toContain("apiHost");
    expect(out).toContain("plain");
    expect(out).toContain('<base href="/whatsapp/">');
  });

  it("tolerates a host with a trailing slash", () => {
    const out = rewriteChatwootHtml(
      doc(`<script>window.chatwootConfig = { hostURL: 'y' }</script>`),
      { prefix: "/whatsapp", host: "https://cortoba-rfq.onrender.com/" },
    );
    expect(out).toContain("apiHost: 'https://cortoba-rfq.onrender.com/whatsapp'");
  });
});
