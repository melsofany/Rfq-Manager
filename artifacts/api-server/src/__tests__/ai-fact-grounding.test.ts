import { describe, expect, it } from "vitest";
import { findGroundingNumbers, findUngroundedNumbers } from "../modules/ai-assistant/answer-guard";

const NOW = new Date("2026-10-09T12:00:00Z");
const evidence = (t: string) => new Set(findGroundingNumbers(t, "evidence"));

describe("date and quantity grounding", () => {
  const tool = '{"customerRfqNo":"26R012450","expiryDate":"2026-10-10","qty":"200.0000"}';
  it("accepts facts that appear in the tool result", () => {
    const ans = "ميعاد الإغلاق 2026-10-10 — الكمية: 200 — الطلب 26R012450";
    expect(findUngroundedNumbers(ans, evidence(tool), NOW)).toEqual([]);
  });
  it("flags an invented date and an invented quantity", () => {
    const ans = "ميعاد الإغلاق 2026-11-03 — الكمية: 230";
    const bad = findUngroundedNumbers(ans, evidence(tool), NOW);
    expect(bad).toContain("20261103");
    expect(bad).toContain("الكمية 230");
  });
  it("does not accept a quantity that is only a prefix of a real one", () => {
    expect(findUngroundedNumbers("الكمية 20", evidence(tool), NOW)).toContain("الكمية 20");
  });
  it("allows today/tomorrow, Arabic digits, d/m/yyyy evidence, and totals", () => {
    expect(findUngroundedNumbers("غدًا 2026-10-10", new Set(), NOW)).toEqual([]);
    expect(findUngroundedNumbers("الكمية: ٢٠٠", evidence(tool), NOW)).toEqual([]);
    expect(findUngroundedNumbers("تاريخ 2026-10-04", evidence("entry 04/10/2026"), NOW)).toEqual(
      [],
    );
    expect(findUngroundedNumbers("إجمالي الكمية 999", evidence(tool), NOW)).toEqual([]);
  });
});
