/**
 * The invented job state — «المهمة 213 … 82%».
 *
 * Live, a mail census ran, the operator asked for its status repeatedly, and the
 * assistant produced a progress narrative for a job id that does not exist. Two
 * independent defects let that happen, and this file pins both:
 *
 *  1. SCOPE. `job_status` was absent from the email-scoped catalogue, so the
 *     model could not read the truth. It answered from nothing.
 *  2. THE CHECK. `findUngroundedNumbers` challenges only mixed alphanumeric ids,
 *     so a bare job number and a bare percentage were never verified.
 *
 * Both fail against the pre-fix source — verified by reverting.
 */
import { describe, it, expect } from "vitest";
import { checkJobClaims } from "../../modules/ai-assistant/claim-check";
import { toolsForIntent } from "../../modules/ai-assistant/tool-scope";
import type { ToolExchange } from "../../modules/ai-assistant/mastra-agent";

const ex = (name: string, data: unknown): ToolExchange =>
  ({ name, args: {}, content: JSON.stringify(data) }) as ToolExchange;

describe("job-state claims: an invented job number", () => {
  it("challenges a job number no tool ever returned", () => {
    // The exact live shape: a narrative about #213 while the newest real job was
    // #212 and no row had 213.
    const answer = "بناءً على آخر تحديث لحالة المهمة رقم 213، فقد تم إنجاز 48% من إجمالي الحصر.";
    const res = checkJobClaims(answer, [ex("job_status", { id: 212, status: "completed" })]);
    expect(res.rule).toBe("job-id-not-found");
    expect(res.correction).toContain("213");
    // The correction must carry the REAL ids, or the model just invents again.
    expect(res.correction).toContain("212");
  });

  it("challenges a job the tool explicitly reported as not found", () => {
    const answer = "المهمة رقم 213 اكتملت بالكامل الآن (100%).";
    const res = checkJobClaims(answer, [
      ex("job_status", { askedId: 213, found: false, jobs: [{ id: 212 }] }),
    ]);
    expect(res.rule).toBe("job-id-not-found");
  });

  it("does NOT challenge a job number that came from a tool", () => {
    const answer = "المهمة رقم 212 اكتملت، ونتيجتها مطابق 0.";
    const res = checkJobClaims(answer, [
      ex("job_status", { id: 212, status: "completed", progress: { percent: 100 } }),
    ]);
    expect(res.correction).toBeNull();
  });
});

describe("job-state claims: an invented progress percentage", () => {
  it("challenges a progress percentage when no job tool ran at all", () => {
    // The whole narrative: no job tool in the trace, yet a percentage.
    const res = checkJobClaims("تم إنجاز 82% من إجمالي الحصر المطلوب.", []);
    expect(res.rule).toBe("job-progress-without-status");
  });

  it("challenges a percentage that contradicts the tool's own progress", () => {
    const res = checkJobClaims("تم إنجاز 95% من الحصر.", [
      ex("job_status", { id: 212, progress: { percent: 100 } }),
    ]);
    expect(res.rule).toBe("job-progress-mismatch");
  });

  it("does NOT challenge the percentage the tool actually reported", () => {
    const res = checkJobClaims("اكتمل الحصر بنسبة 100%.", [
      ex("job_status", { id: 212, progress: { percent: 100 } }),
    ]);
    expect(res.correction).toBeNull();
  });

  it("never touches an ordinary business figure", () => {
    // A margin or a year must not be read as job progress — a false flag would
    // make the assistant "correct" a right answer, which is worse than the bug.
    const res = checkJobClaims("هامش الربح 82% على أمر الشراء لعام 2026.", []);
    expect(res.correction).toBeNull();
  });
});

describe("job-state tools survive every scope", () => {
  it("offers job_status on an email-scoped question", () => {
    // The live question named the mail; the scope then hid the one tool that
    // could report the census's real state.
    const allowed = toolsForIntent("report", "email")!;
    expect(allowed).toContain("job_status");
    expect(allowed).toContain("start_census_job");
    expect(allowed).toContain("cancel_job");
  });

  it("keeps the job tools in the unscoped core", () => {
    const allowed = toolsForIntent("analytics", "any")!;
    expect(allowed).toContain("job_status");
  });
});
