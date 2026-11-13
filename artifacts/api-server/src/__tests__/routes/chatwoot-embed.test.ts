/**
 * Guards the Chatwoot overlay's console-embedding configuration.
 *
 * The overlay is Ruby, so it is not covered by the api-server or portal test
 * suites. That left the single most consequential thing about the console —
 * whether a browser will render it inside the app at all — with no guard. The
 * failure mode is invisible: a refused iframe is a BLANK panel, not an error, so
 * a regression here looks like "the console is slow" rather than "the console
 * can never load".
 *
 * Measured live before the fix:
 *
 *   cortoba-chatwoot.onrender.com refused to connect.  ERR_BLOCKED_BY_RESPONSE
 *
 * These assertions are deliberately structural. Ruby is not available in CI, so
 * the tests pin the properties that make the fix correct rather than executing
 * it — and each one corresponds to a way the fix can be silently undone.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// test file lives at artifacts/api-server/src/__tests__/routes/
const overlay = resolve(here, "../../../../../chatwoot-cortoba");

const initializer = readFileSync(resolve(overlay, "config/initializers/cortoba.rb"), "utf8");
const config = readFileSync(resolve(overlay, "lib/cortoba/config.rb"), "utf8");
const dockerfile = readFileSync(resolve(overlay, "Dockerfile"), "utf8");

/** Strip Ruby comments so prose about a header is not mistaken for code. */
const code = (src: string) =>
  src
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");

describe("Chatwoot overlay — console embedding", () => {
  it("removes X-Frame-Options at the source, not in a middleware", () => {
    // `ActionDispatch::DefaultHeaders` re-applies default_headers on the way
    // OUT, so a middleware that deletes the header has it restored afterwards:
    // the embed keeps failing while the code looks correct.
    expect(code(initializer)).toContain('default_headers.except("X-Frame-Options")');
  });

  it("replaces it with a frame-ancestors allow-list", () => {
    // Deleting the header with nothing in its place would make the console
    // embeddable by ANY site (clickjacking) — strictly worse than the blank
    // panel it fixes. The allow-list is what keeps the change a narrowing.
    expect(code(initializer)).toContain("frame-ancestors");
  });

  it("keeps the protection when framing is on but no origin is known", () => {
    // Fail closed: without a resolvable app URL there is nothing to allow, so
    // the header must survive. This is the branch that decides whether a
    // misconfiguration becomes a clickjacking hole.
    expect(code(initializer)).toContain("ancestors.empty?");
    expect(code(initializer)).toContain("clickjacked");
  });

  it("is opt-in, so an untouched deployment keeps upstream's protection", () => {
    expect(code(initializer)).toContain("framing_enabled?");
    // The removal must sit INSIDE the opt-in branch.
    const gate = code(initializer).indexOf("framing_enabled?");
    const removal = code(initializer).indexOf('default_headers.except("X-Frame-Options")');
    expect(gate).toBeGreaterThan(-1);
    expect(removal).toBeGreaterThan(gate);
  });

  it("treats the literal string 'false' as DISABLED", () => {
    // The subtle one. A `present?`/truthy check treats "false" as set, so an
    // operator writing CORTOBA_ALLOW_FRAMING=false would WIDEN a security
    // header while believing they had refused it. The value must be parsed
    // against an explicit list of truthy words.
    const body = code(config);
    expect(body).toContain("framing_enabled?");
    expect(body).toMatch(/%w\[1 true yes on\]/);
    // And it must NOT be the naive presence check.
    expect(body).not.toMatch(/framing_enabled\?\s*\n?\s*ENV\.fetch\([^)]*\)\.present\?/);
  });

  it("ships the overlay into the image so the fix actually reaches production", () => {
    // A correct initializer that the Dockerfile never copies is a fix that
    // exists only in the repository.
    expect(dockerfile).toContain(
      "COPY config/initializers/cortoba.rb /app/config/initializers/cortoba.rb",
    );
    expect(dockerfile).toContain("COPY lib/cortoba/ /app/lib/cortoba/");
  });

  it("does not modify the vendored upstream tree", () => {
    // The upgrade path is one Docker tag. Editing chatwoot/ would make every
    // future bump a manual merge.
    expect(dockerfile).toContain("FROM chatwoot/chatwoot:");
    expect(dockerfile).not.toMatch(/COPY\s+\.\.\/chatwoot\//);
  });
});
