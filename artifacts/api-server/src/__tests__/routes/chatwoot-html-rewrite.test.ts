import { describe, it, expect } from "vitest";
import { normalisePrefix, rewriteChatwootHtml } from "../../modules/chatwoot/html-rewrite";

/**
 * The console was a BLANK PAGE in production, and the test it replaced is the
 * reason it shipped: it asserted `does NOT rewrite /vite/assets — the proxy
 * serves them under the prefix`, i.e. it GUARDED the defect and described it as
 * a considered choice. The suite was green while the console rendered nothing.
 *
 * `<base href>` fixes RELATIVE urls only. Chatwoot's entry tags are
 * root-absolute (`/vite/assets/index-<hash>.js`), so the browser fetched them
 * from the domain root, our SPA fallback answered with `index.html`, and the
 * browser parsed HTML as JavaScript. Measured: 31 root-absolute references.
 *
 * The fixture below is that measured shape, not an idealised one.
 */

const REAL_SHAPE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <base href="/stale/">
    <link rel="icon" href="/favicon-32x32.png">
    <link rel="apple-touch-icon" href="/apple-icon-180x180.png">
    <link rel="manifest" href="/manifest.json">
    <link rel="stylesheet" href="/vite/assets/v3app-9HH37jG8.css">
    <link rel="modulepreload" href="/vite/assets/index-DJvsux1d.js">
    <script>
      window.chatwootConfig = {
        hostURL: 'https://cortoba-chatwoot.onrender.com',
        helpCenterURL: '',
        fbAppId: '',
      }
    </script>
  </head>
  <body>
    <script src="/vite/assets/v3app-C2io2ZNB.js"></script>
    <img src="https://cdn.example.com/logo.png">
    <a href="//cdn.example.com/x">ext</a>
    <a href="#anchor">frag</a>
  </body>
</html>`;

const OPTS = {
  prefix: "/whatsapp/console",
  host: "https://cortoba-rfq.onrender.com",
};

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
  it("prefixes every root-absolute asset reference", () => {
    // This is the blank page. Without it the bundle is requested from
    // `/vite/assets/...` and answered with the SPA's index.html.
    const out = rewriteChatwootHtml(REAL_SHAPE, OPTS);
    expect(out).toContain('src="/whatsapp/console/vite/assets/v3app-C2io2ZNB.js"');
    expect(out).toContain('href="/whatsapp/console/vite/assets/index-DJvsux1d.js"');
    expect(out).toContain('href="/whatsapp/console/vite/assets/v3app-9HH37jG8.css"');
    expect(out).toContain('href="/whatsapp/console/favicon-32x32.png"');
    expect(out).toContain('href="/whatsapp/console/manifest.json"');
    // No original root-absolute asset may survive.
    expect(out).not.toMatch(/(src|href)="\/vite\//);
    expect(out).not.toMatch(/(src|href)="\/favicon-/);
    expect(out).not.toMatch(/(src|href)="\/manifest\.json"/);
  });

  it("leaves external, protocol-relative and fragment urls alone", () => {
    const out = rewriteChatwootHtml(REAL_SHAPE, OPTS);
    expect(out).toContain('src="https://cdn.example.com/logo.png"');
    expect(out).toContain('href="//cdn.example.com/x"');
    expect(out).toContain('href="#anchor"');
  });

  it("injects <base> as the FIRST element of <head> and drops the stale one", () => {
    const out = rewriteChatwootHtml(REAL_SHAPE, OPTS);
    expect(out).toContain('<base href="/whatsapp/console/">');
    expect(out).not.toContain('<base href="/stale/">');
    expect(out.match(/<base\b/gi)?.length).toBe(1);
    expect(out.indexOf("<base")).toBeLessThan(out.indexOf("<link"));
  });

  it("still produces a usable document when <head> is missing", () => {
    const out = rewriteChatwootHtml("<html><body>x</body></html>", OPTS);
    expect(out.startsWith('<base href="/whatsapp/console/">')).toBe(true);
  });

  it("is idempotent — a re-rewrite never doubles the prefix", () => {
    // A doubled prefix is a 404: the blank page by another route.
    const once = rewriteChatwootHtml(REAL_SHAPE, OPTS);
    const twice = rewriteChatwootHtml(once, OPTS);
    expect(twice).toContain('src="/whatsapp/console/vite/assets/v3app-C2io2ZNB.js"');
    expect(twice).not.toContain("/whatsapp/console/whatsapp/console/");
  });

  it("points hostURL and apiHost at the same-origin prefixed url", () => {
    // Chatwoot builds absolute links from hostURL, and the bundle builds its
    // axios baseURL from apiHost; both must be reachable from the browser.
    const out = rewriteChatwootHtml(REAL_SHAPE, OPTS);
    expect(out).toContain("hostURL: 'https://cortoba-rfq.onrender.com/whatsapp/console'");
    expect(out).toContain("apiHost: 'https://cortoba-rfq.onrender.com/whatsapp/console'");
    expect(out).not.toContain("cortoba-chatwoot.onrender.com");
  });

  it("gives websocketURL the socket scheme, not the page's", () => {
    const out = rewriteChatwootHtml(REAL_SHAPE, OPTS);
    expect(out).toContain("websocketURL: 'wss://cortoba-rfq.onrender.com'");
  });

  it("does NOT invent a help centre the operator never configured", () => {
    // Measured: this release emits `helpCenterURL: ''`. Rewriting the empty
    // value would silently enable a link that does not exist.
    const out = rewriteChatwootHtml(REAL_SHAPE, OPTS);
    expect(out).toContain("helpCenterURL: ''");
  });

  it("still rewrites a help centre url that IS set", () => {
    const withHelp = REAL_SHAPE.replace(
      "helpCenterURL: ''",
      "helpCenterURL: 'https://cortoba-chatwoot.onrender.com'",
    );
    const out = rewriteChatwootHtml(withHelp, OPTS);
    expect(out).toContain("helpCenterURL: 'https://cortoba-rfq.onrender.com/whatsapp/console'");
  });

  it("leaves a document without chatwootConfig untouched apart from <base>", () => {
    const out = rewriteChatwootHtml("<html><head></head><body>plain</body></html>", OPTS);
    expect(out).not.toContain("apiHost");
    expect(out).toContain("plain");
  });

  it("tolerates a host with a trailing slash", () => {
    const out = rewriteChatwootHtml(REAL_SHAPE, {
      prefix: "/whatsapp/console",
      host: "https://cortoba-rfq.onrender.com/",
    });
    expect(out).toContain("apiHost: 'https://cortoba-rfq.onrender.com/whatsapp/console'");
  });

  it("touches nothing when the prefix is the root", () => {
    const out = rewriteChatwootHtml(REAL_SHAPE, {
      prefix: "",
      host: "https://x.test",
    });
    expect(out).toContain('src="/vite/assets/v3app-C2io2ZNB.js"');
  });
});
