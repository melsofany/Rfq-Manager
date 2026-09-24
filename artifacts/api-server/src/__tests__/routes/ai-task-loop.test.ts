/**
 * Task-execution control (OpenManus-derived).
 *
 * These tests pin the behaviour that makes a multi-step run durable rather than
 * a fixed number of blind rounds: a repeated failing call is detected and
 * steered, a stalled run is not extended, a progressing run may be, and an error
 * observation is classified as a fixable (model-fault) or data error.
 *
 * The integration cases in `ai-agent.test.ts` prove these decisions actually
 * change the loop; here we prove the decisions themselves are correct.
 */
import { describe, it, expect } from "vitest";
import {
  TaskTrace,
  isErrorObservation,
  isValidationError,
  callSignature,
  normalizeThought,
  steeringMessage,
  DUPLICATE_THRESHOLD,
  HARD_MAX_STEPS,
  EXTEND_MIN_REMAINING_MS,
  type ObservedStep,
} from "../../modules/ai-assistant/task-loop";

const step = (
  step: number,
  thought: string,
  calls: Array<{ name: string; args: unknown }>,
  results: string[],
): ObservedStep => ({ step, thought, toolCalls: calls, results });

describe("observation classification", () => {
  it("recognises the agent's ERROR: string and an {ok:false} envelope", () => {
    expect(isErrorObservation("ERROR: الأداة غير معروفة")).toBe(true);
    expect(isErrorObservation('{"ok":false,"error":"bad"}')).toBe(true);
    expect(isErrorObservation('{"ok":true,"data":[]}')).toBe(false);
    expect(isErrorObservation("")).toBe(false);
  });

  it("classifies a malformed-argument error as fixable, a timeout as not", () => {
    // A schema/argument error is the model's fault — an instruction can fix it.
    expect(isValidationError("ERROR: unknown tool 'aggregate_po_itemz'")).toBe(true);
    expect(isValidationError('{"ok":false,"error":"missing required parameter: table"}')).toBe(
      true,
    );
    // A timeout is the data's fault — retrying it unchanged wastes quota.
    expect(isValidationError("ERROR: لم تكمل الأداة خلال 100 ثانية")).toBe(false);
    expect(isValidationError('{"ok":true,"data":[]}')).toBe(false);
  });
});

describe("callSignature", () => {
  it("treats argument key order as equivalent and differing values as distinct", () => {
    expect(callSignature("t", { a: 1, b: 2 })).toBe(callSignature("t", { b: 2, a: 1 }));
    expect(callSignature("t", { a: 1 })).not.toBe(callSignature("t", { a: 2 }));
    expect(callSignature("t", { a: 1 })).not.toBe(callSignature("u", { a: 1 }));
  });
});

describe("TaskTrace — stuck detection", () => {
  it("is not stuck on a first, distinct step", () => {
    const t = new TaskTrace();
    t.record(step(1, "أبحث", [{ name: "search_database", args: { q: "PO" } }], ["{}"]));
    expect(t.isStuck()).toBe(false);
    expect(t.stuckReason()).toBeNull();
  });

  it("detects a repeated thought (duplicate_response)", () => {
    const t = new TaskTrace();
    t.record(step(1, "أبحث", [{ name: "search_database", args: { q: "PO" } }], ['{"ok":true}']));
    t.record(step(2, "أبحث", [{ name: "search_database", args: { q: "PO2" } }], ['{"ok":true}']));
    expect(DUPLICATE_THRESHOLD).toBe(2);
    // One duplicate earlier turn is below the threshold (needs 2).
    expect(t.isStuck()).toBe(false);
    t.record(step(3, "أبحث", [{ name: "search_database", args: { q: "PO3" } }], ['{"ok":true}']));
    expect(t.isStuck()).toBe(true);
    expect(t.stuckReason()).toBe("duplicate_response");
  });

  it("detects the same call failing repeatedly (repeated_failed_call)", () => {
    const t = new TaskTrace();
    const fail = () => '{"ok":false,"error":"missing required parameter: table"}';
    t.record(step(1, "t1", [{ name: "search_database", args: { q: "x" } }], [fail()]));
    t.record(step(2, "t2", [{ name: "search_database", args: { q: "x" } }], [fail()]));
    expect(t.isStuck()).toBe(true);
    expect(t.stuckReason()).toBe("repeated_failed_call");
    expect(t.repeatedFailureTool()).toBe("search_database");
  });

  it("does not count a successful repeat as a failure loop", () => {
    const t = new TaskTrace();
    t.record(step(1, "t1", [{ name: "search_database", args: { q: "x" } }], ['{"ok":true}']));
    t.record(step(2, "t2", [{ name: "search_database", args: { q: "x" } }], ['{"ok":true}']));
    expect(t.isStuck()).toBe(false);
    expect(t.hasProgress).toBe(true);
  });
});

describe("TaskTrace — budget extension", () => {
  it("grants an extension only when a tool reports MORE work remains", () => {
    const t = new TaskTrace();
    t.record(
      step(
        1,
        "t1",
        [{ name: "scan_email_items", args: {} }],
        ['{"isComplete":false,"remainingMessages":2888,"continueHint":"أكمل"}'],
      ),
    );
    expect(t.hasPendingWork()).toBe(true);
    expect(t.canExtend(1, EXTEND_MIN_REMAINING_MS + 1, false)).toBe(true);
  });

  it("refuses an extension for a merely SUCCESSFUL call (no pending work)", () => {
    // "The tool ran" is not progress. A completed lookup means the model failed
    // to answer, and granting another round would spend another day's quota on
    // the same stall — this is the guard that keeps a fast-path lookup at 2 rounds.
    const t = new TaskTrace();
    t.record(step(1, "t1", [{ name: "lookup_document", args: {} }], ['{"found":true}']));
    expect(t.hasProgress).toBe(true);
    expect(t.hasPendingWork()).toBe(false);
    expect(t.canExtend(1, EXTEND_MIN_REMAINING_MS + 1, false)).toBe(false);
  });

  it("refuses an extension with no budget, already steered, or at the hard cap", () => {
    const pending = new TaskTrace();
    const more = '{"data":{"isComplete":false,"remainingMessages":10}}';
    pending.record(step(1, "t1", [{ name: "scan_email_items", args: {} }], [more]));
    expect(pending.canExtend(1, EXTEND_MIN_REMAINING_MS + 1, false)).toBe(true);
    expect(pending.canExtend(1, EXTEND_MIN_REMAINING_MS - 1, false)).toBe(false);
    expect(pending.canExtend(1, EXTEND_MIN_REMAINING_MS + 1, true)).toBe(false);
    expect(pending.canExtend(HARD_MAX_STEPS, EXTEND_MIN_REMAINING_MS + 1, false)).toBe(false);
  });

  it("does not treat an error observation as pending work", () => {
    const t = new TaskTrace();
    t.record(
      step(
        1,
        "t1",
        [{ name: "scan_email_items", args: {} }],
        ["ERROR: لم تكمل الأداة خلال 100 ثانية"],
      ),
    );
    expect(t.hasPendingWork()).toBe(false);
    expect(t.canExtend(1, EXTEND_MIN_REMAINING_MS + 1, false)).toBe(false);
  });
});

describe("steeringMessage", () => {
  it("names the failing tool when a call repeats its failure", () => {
    const t = new TaskTrace();
    const fail = '{"ok":false,"error":"unknown tool: aggregate_po_itemz"}';
    t.record(step(1, "t1", [{ name: "aggregate_po_itemz", args: {} }], [fail]));
    t.record(step(2, "t2", [{ name: "aggregate_po_itemz", args: {} }], [fail]));
    const msg = steeringMessage(t);
    expect(msg).toContain("aggregate_po_itemz");
    // Must demand a concrete behaviour change and forbid a blind retry.
    expect(msg).toMatch(/لا تُعِد|غيّر الاستراتيجية/);
  });

  it("gives the generic strategy change when only the thought repeated", () => {
    const t = new TaskTrace();
    t.record(step(1, "t", [{ name: "a", args: {} }], ['{"ok":true}']));
    t.record(step(2, "t", [{ name: "b", args: {} }], ['{"ok":true}']));
    t.record(step(3, "t", [{ name: "c", args: {} }], ['{"ok":true}']));
    const msg = steeringMessage(t);
    expect(msg).toContain("غيّر الاستراتيجية");
    // It must still allow a final answer rather than demanding an impossible search.
    expect(msg).toMatch(/الرد النهائي/);
  });
});

describe("TaskTrace — step accounting", () => {
  it("counts tool calls and errors and reports a summary", () => {
    const t = new TaskTrace();
    t.record(
      step(
        1,
        "t1",
        [
          { name: "a", args: {} },
          { name: "b", args: {} },
        ],
        ['{"ok":true}', "ERROR: bad"],
      ),
    );
    t.noteForcedAnswer();
    const s = t.summary();
    expect(s.steps).toBe(1);
    expect(s.toolCalls).toBe(2);
    expect(s.toolErrors).toBe(1);
    expect(s.distinctTools).toBe(2);
    expect(s.successfulTools).toBe(1);
    expect(s.forcedAnswers).toBe(1);
  });

  it("normalizeThought collapses whitespace so formatting is not a 'new' thought", () => {
    expect(normalizeThought("  أبحث   في\nالنظام ")).toBe("أبحث في النظام");
  });
});
