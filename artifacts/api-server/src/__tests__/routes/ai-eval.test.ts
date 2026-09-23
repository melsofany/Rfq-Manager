/**
 * The evaluation gate.
 *
 * This is the regression harness the assistant work was asked to include: a
 * labelled set of real operator questions scored against the DETERMINISTIC
 * router, with accuracy / path-accuracy / latency reported. It runs with no
 * network and no model call, so it costs nothing to run on every commit — which
 * is the only way a quality gate survives.
 *
 * The thresholds are deliberately explicit. If routing quality regresses (a
 * mis-classified intent, or worse an analysis routed as a quick lookup) the
 * suite fails rather than printing a number nobody reads.
 */
import { describe, it, expect } from "vitest";
import { EVAL_CASES, runOfflineEvaluation } from "../../modules/ai-assistant/eval";

const REPORT = runOfflineEvaluation();

describe("evaluation: coverage of the labelled set", () => {
  it("has enough cases to be meaningful", () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(15);
  });

  it("spans both paths and several intents", () => {
    const paths = new Set(EVAL_CASES.map((c) => c.expectedPath));
    expect(paths.has("fast")).toBe(true);
    expect(paths.has("deep")).toBe(true);
    const intents = new Set(EVAL_CASES.flatMap((c) => c.expectedIntents));
    expect(intents.size).toBeGreaterThanOrEqual(5);
  });
});

describe("evaluation: router quality", () => {
  it("meets the intent-accuracy threshold", () => {
    // 90% of a labelled set is a real bar without being brittle to one label.
    expect(REPORT.accuracy).toBeGreaterThanOrEqual(0.9);
  });

  it("meets the PATH-accuracy threshold (the safety-critical metric)", () => {
    // The path decides the budget. A fast-labelled analysis answers from a
    // sample; that is the bug class this whole effort targets, so the path bar
    // is stricter than the intent bar.
    expect(REPORT.pathAccuracy).toBeGreaterThanOrEqual(0.95);
  });

  it("keeps routing latency negligible (it must never be the bottleneck)", () => {
    // The router is pure regex over a short string; if this ever rises, an
    // expensive matcher has crept in and should be reviewed.
    expect(REPORT.maxRouteMs).toBeLessThan(20);
    expect(REPORT.medianRouteMs).toBeLessThan(5);
  });

  it("classifies the observed incident cases correctly", () => {
    for (const c of EVAL_CASES) {
      if (!c.note) continue;
      const r = REPORT.results.find((x) => x.question === c.question);
      expect(r, `no result for «${c.question}»`).toBeTruthy();
      // Incident-derived cases carry a note; a regression on any of them is a
      // repeat of a bug we already paid for, so assert them individually.
      expect(r!.passed, `${c.question} (${c.note})`).toBe(true);
    }
  });
});

describe("evaluation: failure reporting", () => {
  it("reports failures with the question and the chosen route, not just a count", () => {
    // Feed a deliberately impossible case so the failure path is exercised.
    const bad = runOfflineEvaluation([
      {
        question: "اعمل حصر لكل PO في البريد خلال 2026",
        expectedIntents: ["document_lookup"],
        expectedPath: "fast",
      },
    ]);
    expect(bad.accuracy).toBe(0);
    expect(bad.failures).toHaveLength(1);
    expect(bad.failures[0].intent).toBe("analytics");
    expect(bad.failures[0].path).toBe("deep");
  });

  it("handles an empty dataset without dividing by zero", () => {
    const empty = runOfflineEvaluation([]);
    expect(empty.total).toBe(0);
    expect(empty.accuracy).toBe(0);
    expect(empty.pathAccuracy).toBe(0);
    expect(empty.medianRouteMs).toBe(0);
  });
});
