import { beforeEach, describe, expect, it } from "vitest";
import {
  SOURCE_QUESTION,
  clearSourceChoice,
  recoverSourceState,
  resolveSourceChoice,
} from "../modules/ai-assistant/source-choice";

const NOW = 1_800_000_000_000;
const K = "201000000000";
const Q = "اعمل حصر لكل بنود الكابل لج في أوامر الشراء";

describe("source-choice state survives a restart", () => {
  beforeEach(() => clearSourceChoice());

  it("a pending source question is restored from the log", () => {
    recoverSourceState(
      K,
      [
        { role: "user", content: Q, at: NOW - 60_000 },
        { role: "assistant", content: SOURCE_QUESTION, at: NOW - 59_000 },
      ],
      NOW,
    );
    const r = resolveSourceChoice(K, "2", NOW);
    expect(r.kind).toBe("run");
    expect(r.kind === "run" && r.text).toContain(Q);
    expect(r.kind === "run" && r.text).toContain("من الميل");
  });

  it("«كمّل» resumes the newest substantive question after a restart", () => {
    recoverSourceState(
      K,
      [
        { role: "user", content: Q, at: NOW - 120_000 },
        { role: "assistant", content: "الحصر لم يكتمل", at: NOW - 100_000 },
      ],
      NOW,
    );
    const r = resolveSourceChoice(K, "كمل", NOW);
    expect(r.kind === "run" && r.text).toContain(Q);
  });

  it("ignores turns older than the resume window and never overrides live state", () => {
    recoverSourceState(K, [{ role: "user", content: Q, at: NOW - 3_600_000 }], NOW);
    const r = resolveSourceChoice(K, "كمل", NOW);
    expect(r.kind === "run" && r.text).toBe("كمل");
  });
});
