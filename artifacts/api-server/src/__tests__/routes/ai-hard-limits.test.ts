/**
 * The assistant reads everything and writes nothing.
 *
 * This is a PRODUCT guarantee, not a prompt preference: the operator's rule is
 * that the agent may run any task, but must never modify the database, send
 * email, or send WhatsApp. A prompt rule alone is not a boundary — a model that
 * misreads the instruction would still be able to act — so these tests assert
 * the guarantee against the TOOL REGISTRY and the SOURCE, which is what actually
 * decides what the model can call.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "src/modules/ai-assistant");

describe("no tool can write to the database", () => {
  const writers = ["tools.ts", "db-tools.ts", "procurement-tools.ts", "sql-registry.ts", "jobs.ts"];

  it.each(writers)("%s issues no INSERT/UPDATE/DELETE", (file) => {
    const src = readFileSync(join(DIR, file), "utf8");
    // Only the assistant's OWN bookkeeping tables may be written (messages,
    // memories, jobs, scan sessions). A business-table write would show up here.
    const hits = [...src.matchAll(/\.(insert|update|delete)\(\s*([A-Za-z0-9_]+)/g)]
      .map((m) => `${m[1]}(${m[2]})`)
      .filter((h) => !/Table\)/.test(h) === false)
      .filter(
        (h) =>
          /messagesTable|MemoriesTable|JobsTable|ScanSessionsTable|StateTable|orgProfilesTable|IncidentsTable|UsersTable/i.test(
            h,
          ) === false,
      );
    expect(hits).toEqual([]);
  });

  it("the read-only SQL guard is enforced in code, not only in the prompt", () => {
    const src = readFileSync(join(DIR, "query-exec.ts"), "utf8");
    // The database itself must refuse the write — the allowlist alone is one bug
    // away from being no check.
    expect(src).toMatch(/BEGIN TRANSACTION READ ONLY|SET TRANSACTION READ ONLY/);
    expect(src).toMatch(/SELECT|WITH/);
  });
});

describe("no tool can send anything to an external party", () => {
  it("send_email does not exist in the tool registry", () => {
    const src = readFileSync(join(DIR, "tool-definitions.ts"), "utf8");
    expect(src).not.toMatch(/name:\s*"send_email"/);
  });

  it("the dispatch has no send_email case", () => {
    const src = readFileSync(join(DIR, "tools.ts"), "utf8");
    expect(src).not.toMatch(/case\s+"send_email"/);
  });

  it("no WhatsApp sending tool exists", () => {
    const src = readFileSync(join(DIR, "tool-definitions.ts"), "utf8");
    const names = [...src.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    const senders = names.filter((n) => /^(send|whatsapp|notify|message)_/.test(n));
    expect(senders).toEqual([]);
  });

  it("sendAssistantEmail is gone from the module", () => {
    const src = readFileSync(join(DIR, "email.ts"), "utf8");
    expect(src).not.toMatch(/export async function sendAssistantEmail/);
  });
});

describe("the prompt states the limits and cannot be displaced", () => {
  it("carries a <hard_limits> block naming all three prohibitions", () => {
    const src = readFileSync(join(DIR, "system-prompt.ts"), "utf8");
    expect(src).toMatch(/<hard_limits>/);
    expect(src).toMatch(/الكتابة على قاعدة البيانات: ممنوعة/);
    expect(src).toMatch(/إرسال البريد: ممنوع/);
    expect(src).toMatch(/إرسال الواتساب: ممنوع/);
  });

  it("re-appends the limits AFTER the admin's custom instructions", () => {
    const src = readFileSync(join(DIR, "system-prompt.ts"), "utf8");
    // An admin prompt that arrives after the limits could otherwise override
    // them by being the last thing the model reads.
    expect(src).toMatch(/settings\.systemPrompt/);
    expect(src).toMatch(/replace\(\s*"\\n<hard_limits>"/);
  });

  it("the AGENT surface is free of a business-table write", () => {
    // `routes.ts` is the ADMIN API (a human adding an allowlisted number or
    // editing settings) and `index.ts` is a mount point — neither is something
    // the model can call, so they are out of scope for this guarantee.
    const files = readdirSync(DIR).filter(
      (f) => f.endsWith(".ts") && f !== "routes.ts" && f !== "index.ts",
    );
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(DIR, f), "utf8");
      for (const m of src.matchAll(/db\s*\.\s*(insert|update|delete)\(\s*([A-Za-z0-9_]+)/g)) {
        const table = m[2];
        if (
          !/messages|memories|jobs|scansessions|scan_sessions|state|profiles|incidents|users|audit/i.test(
            table,
          )
        ) {
          offenders.push(`${f}: ${m[1]}(${table})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
describe("the assistant's conversation stays out of the shared inbox", () => {
  it("recordInboundOnce refuses to record an assistant phone", () => {
    const src = readFileSync(join(process.cwd(), "src/modules/communications/routes.ts"), "utf8");
    const start = src.indexOf("async function recordInboundOnce");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("\n}", start));
    // The guard must be BEFORE the insert: the webhook records before
    // dispatching to a handler, so a post-dispatch check would still leak.
    const guard = body.indexOf("isAiAssistantPhone");
    const insertAt = body.indexOf(".insert(whatsappChatsTable)");
    expect(guard).toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(insertAt);
  });

  it("the privacy guard is exported from the assistant config", () => {
    const src = readFileSync(join(DIR, "config.ts"), "utf8");
    expect(src).toMatch(/export async function isAiAssistantPhone/);
    expect(src).toMatch(/export function resetAiPhoneCache/);
  });
});
