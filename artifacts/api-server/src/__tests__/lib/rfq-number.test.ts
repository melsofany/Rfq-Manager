/**
 * Tests for RFQ number format validation.
 *
 * Internal RFQ numbers follow the pattern: CRQ-YYYY-XXXXXX
 * where YYYY is the current year and XXXXXX is a zero-padded 6-digit sequence.
 */
import { describe, it, expect } from "vitest";

const RFQ_PATTERN = /^CRQ-\d{4}-\d{6}$/;

function formatRfqNumber(year: number, seq: number): string {
  return `CRQ-${year}-${String(seq).padStart(6, "0")}`;
}

describe("RFQ number format", () => {
  it("matches CRQ-YYYY-XXXXXX pattern", () => {
    expect(formatRfqNumber(2025, 1)).toMatch(RFQ_PATTERN);
    expect(formatRfqNumber(2025, 999999)).toMatch(RFQ_PATTERN);
  });

  it("pads sequence to 6 digits", () => {
    expect(formatRfqNumber(2025, 1)).toBe("CRQ-2025-000001");
    expect(formatRfqNumber(2025, 42)).toBe("CRQ-2025-000042");
    expect(formatRfqNumber(2025, 123456)).toBe("CRQ-2025-123456");
  });

  it("includes the correct year", () => {
    expect(formatRfqNumber(2024, 1)).toContain("2024");
    expect(formatRfqNumber(2026, 1)).toContain("2026");
  });

  it("rejects strings not matching the pattern", () => {
    expect("RFQ-2025-000001").not.toMatch(RFQ_PATTERN);
    expect("CRQ-25-000001").not.toMatch(RFQ_PATTERN);
    expect("CRQ-2025-12345").not.toMatch(RFQ_PATTERN); // only 5 digits
  });
});
