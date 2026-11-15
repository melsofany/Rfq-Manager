/**
 * The 85 production rows shaped `2025-17-09` make any `::date` query throw, so a
 * report that touches `expiry_date` fails instead of returning a number.
 *
 * These tests pin the repair (`2025-17-09` → `2025-09-17`, which is unambiguous
 * — no year has a 17th month) and the refusal (a value that is not a date stores
 * nothing, because a wrong date silently mis-sorts every report).
 */
import { describe, it, expect } from "vitest";
import { normalizeIsoDate, isCastableDate } from "../../shared/date-guard";

describe("normalizeIsoDate", () => {
  it("repairs the swapped day and month production actually holds", () => {
    // The real values measured in `customer_rfqs`: the month is impossible
    // (17–27) while the day is a valid month, so the reading is unambiguous.
    expect(normalizeIsoDate("2025-17-09")).toBe("2025-09-17");
    expect(normalizeIsoDate("2025-20-09")).toBe("2025-09-20");
    expect(normalizeIsoDate("2025-27-09")).toBe("2025-09-27");
  });

  it("leaves a correct date untouched", () => {
    expect(normalizeIsoDate("2025-09-17")).toBe("2025-09-17");
    expect(normalizeIsoDate("2026-01-01")).toBe("2026-01-01");
    expect(normalizeIsoDate("2024-02-29")).toBe("2024-02-29"); // leap year
  });

  it("pads a single-digit month and day", () => {
    expect(normalizeIsoDate("2025-9-7")).toBe("2025-09-07");
    expect(normalizeIsoDate("2025-9-17")).toBe("2025-09-17");
  });

  it("refuses a date that does not exist instead of inventing one", () => {
    // A wrong date is worse than none: it silently mis-sorts every report that
    // uses the column, and nothing downstream can tell it was guessed.
    expect(normalizeIsoDate("2025-02-30")).toBeNull(); // no 30 February
    expect(normalizeIsoDate("2023-02-29")).toBeNull(); // 2023 is not a leap year
    expect(normalizeIsoDate("2025-13-32")).toBeNull(); // both impossible
    expect(normalizeIsoDate("ليس تاريخًا")).toBeNull();
    expect(normalizeIsoDate("")).toBeNull();
    expect(normalizeIsoDate(null)).toBeNull();
    expect(normalizeIsoDate(undefined)).toBeNull();
  });

  it("does not swap when the day cannot be a month either", () => {
    // `2025-13-32` has no valid reading at all — swapping would need month 32.
    expect(normalizeIsoDate("2025-13-32")).toBeNull();
    // 13 is a valid month but 32 is not a valid day for any month.
    expect(normalizeIsoDate("2025-13-40")).toBeNull();
  });

  it("does not read a locale-dependent format", () => {
    // `new Date("17/09/2025")` resolves by runtime locale, so the same input
    // would store differently on two machines. Refused on purpose.
    expect(normalizeIsoDate("17/09/2025")).toBeNull();
    expect(normalizeIsoDate("09/17/2025")).toBeNull();
  });

  it("returns a value PostgreSQL can always cast", () => {
    for (const input of ["2025-17-09", "2025-9-7", "2025-02-29", "2024-02-29"]) {
      const out = normalizeIsoDate(input);
      if (out) expect(isCastableDate(out)).toBe(true);
    }
  });
});

describe("isCastableDate", () => {
  it("accepts only a real ISO date", () => {
    expect(isCastableDate("2025-09-17")).toBe(true);
    expect(isCastableDate("2025-17-09")).toBe(false); // the production defect
    expect(isCastableDate("2025-02-30")).toBe(false);
    expect(isCastableDate("")).toBe(false);
    expect(isCastableDate(null)).toBe(false);
    expect(isCastableDate("17 September 2025")).toBe(false);
  });

  it("is the STORED-value check: a repairable input is still not castable", () => {
    // The two functions answer different questions and must not be confused:
    // `normalizeIsoDate` asks "what should this INPUT become?" (so `2025-17-09`
    // is repairable), while `isCastableDate` asks "can PostgreSQL cast this
    // STORED value right now?" (so `2025-17-09` throws and is false).
    // Conflating them is how the repair would be skipped for the very rows that
    // need it: the migration must test the STORED form.
    expect(normalizeIsoDate("2025-17-09")).toBe("2025-09-17");
    expect(isCastableDate("2025-17-09")).toBe(false);
    // Once normalised, the stored form is castable — the two agree on the OUTPUT.
    expect(isCastableDate(normalizeIsoDate("2025-17-09")!)).toBe(true);
  });
});
