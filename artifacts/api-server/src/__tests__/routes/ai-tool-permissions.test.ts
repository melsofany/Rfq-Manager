import { it, expect, describe } from "vitest";
import { readFileSync } from "node:fs";
import {
  decideToolUse,
  isKnownTool,
  toolEffect,
  operatorApprovedSend,
  KNOWN_TOOLS,
} from "../../modules/ai-assistant/tool-permissions";

/**
 * ONE permission layer. The point is that the classification lives in a single
 * place and an unclassified tool is refused — a guard inside each tool body is
 * a guard that a new tool does not have.
 */
const DB_ON = { settings: { allowDatabase: true, allowEmail: true, allowReadOnlySql: true } };

describe("tool permissions", () => {
  it("classifies every tool, and refuses an unknown one", () => {
    expect(toolEffect("search_database")).toBe("read");
    expect(toolEffect("remember_fact")).toBe("write");
    expect(toolEffect("send_email")).toBe("send");
    expect(toolEffect("delete_everything")).toBeNull();
    expect(isKnownTool("delete_everything")).toBe(false);
    expect(decideToolUse("delete_everything", DB_ON).allowed).toBe(false);
  });

  it("refuses a send until the OPERATOR approves it", () => {
    const blocked = decideToolUse("send_email", DB_ON);
    expect(blocked.allowed).toBe(false);
    expect(blocked.requiresApproval).toBe(true);
    expect(blocked.reason).toContain("خارج الشركة");

    const allowed = decideToolUse("send_email", { ...DB_ON, approvedEffects: ["send"] });
    expect(allowed.allowed).toBe(true);
  });

  it("never lets the model approve itself — only the operator's words do", () => {
    // The model writing «أرسل العرض» is intent, not consent.
    expect(operatorApprovedSend("سأرسل العرض للمورد الآن")).toBe(false);
    expect(operatorApprovedSend("ما رأيك أن نرسل؟")).toBe(false);
    // The operator's own reply is consent.
    expect(operatorApprovedSend("موافق")).toBe(true);
    expect(operatorApprovedSend("تمام ابعت")).toBe(true);
    expect(operatorApprovedSend("اعتمد")).toBe(true);
  });

  it("honours the settings gates it did not replace", () => {
    const noDb = { settings: { allowDatabase: false, allowEmail: true } };
    expect(decideToolUse("search_database", noDb).allowed).toBe(false);
    const noMail = { settings: { allowDatabase: true, allowEmail: false } };
    expect(decideToolUse("search_emails", noMail).allowed).toBe(false);
    expect(decideToolUse("search_database", noMail).allowed).toBe(true);
  });

  it("allows reads and writes without approval", () => {
    expect(decideToolUse("search_database", DB_ON).allowed).toBe(true);
    expect(decideToolUse("remember_fact", DB_ON).allowed).toBe(true);
    expect(decideToolUse("generate_pdf", DB_ON).allowed).toBe(true);
  });

  it("GUARD: every dispatched tool has a classification", () => {
    // The dispatcher's OWN switch is the surface. Slicing from
    // `executeToolInner` avoids the two other switches in this file that
    // branch on a DOCUMENT TYPE (`describe_schema`, `lookupDocument`) — those
    // cases are data, not tools, and treating them as tools was a false alarm.
    const src = readFileSync("src/modules/ai-assistant/tools.ts", "utf8");
    const body = src.slice(src.indexOf("async function executeToolInner"));
    const dispatched = [...new Set([...body.matchAll(/case\s+"([a-z_]+)":/g)].map((m) => m[1]))];
    expect(dispatched.length).toBeGreaterThan(20);
    expect(dispatched.filter((n) => !isKnownTool(n))).toEqual([]);
  });

  it("GUARD: no classification names a tool the dispatcher lacks", () => {
    const src = readFileSync("src/modules/ai-assistant/tools.ts", "utf8");
    const body = src.slice(src.indexOf("async function executeToolInner"));
    const dispatched = new Set([...body.matchAll(/case\s+"([a-z_]+)":/g)].map((m) => m[1]));
    // `send_whatsapp` / `send_email` are classified so a future sender cannot
    // ship unclassified; no dispatcher branch exists yet, and that gap is
    // recorded here rather than hidden.
    const NOT_YET_DISPATCHED = ["send_whatsapp", "send_email"];
    expect(
      KNOWN_TOOLS.filter((n) => !dispatched.has(n) && !NOT_YET_DISPATCHED.includes(n)),
    ).toEqual([]);
  });
});
