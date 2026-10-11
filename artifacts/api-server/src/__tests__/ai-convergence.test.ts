import { describe, expect, it } from "vitest";
import {
  HARD_MAX_STEPS,
  isProductiveRound,
  shouldExtendForProgress,
} from "../modules/ai-assistant/task-loop";

const call = (name: string, args: unknown, content = '{"rows":[1]}', ok = true) => ({
  name,
  args,
  content,
  ok,
});

describe("convergence-based extension", () => {
  it("a round that read something new is productive; a repeat or an error is not", () => {
    const seen = new Set<string>();
    expect(isProductiveRound(seen, [call("search_database", { table: "a" })])).toBe(true);
    expect(isProductiveRound(seen, [call("search_database", { table: "a" })])).toBe(false);
    expect(
      isProductiveRound(seen, [call("search_database", { table: "b" }, "ERROR: x", false)]),
    ).toBe(false);
  });

  const base = {
    productive: true,
    consumedRounds: 8,
    effectiveRounds: 8,
    extensions: 0,
    remainingMs: 90_000,
    steered: false,
  };
  it("extends a converging run at the cap", () => {
    expect(shouldExtendForProgress(base)).toBe(true);
  });
  it("never extends past the bounds", () => {
    expect(shouldExtendForProgress({ ...base, productive: false })).toBe(false);
    expect(shouldExtendForProgress({ ...base, steered: true })).toBe(false);
    expect(shouldExtendForProgress({ ...base, extensions: 3 })).toBe(false);
    expect(shouldExtendForProgress({ ...base, remainingMs: 10_000 })).toBe(false);
    expect(shouldExtendForProgress({ ...base, effectiveRounds: HARD_MAX_STEPS })).toBe(false);
    expect(shouldExtendForProgress({ ...base, consumedRounds: 3 })).toBe(false);
  });
});
