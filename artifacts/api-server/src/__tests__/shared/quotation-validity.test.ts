import { describe, it, expect } from "vitest";
import {
  computeValidityDate,
  validityPeriodFromTerms,
  addDaysIso,
  todayIso,
  DEFAULT_VALIDITY_DAYS,
} from "../../modules/customer-rfq/quotation-validity";

/**
 * The operator's rule, stated explicitly: the offer is valid for the period
 * written in the terms, counted from the SEND day; when the terms state no
 * period, the default is one week. A wrong date is a commercial promise, so the
 * rule is pinned here rather than trusted to the PDF code path.
 */
describe("quotation validity date", () => {
  it("counts a week stated in the terms from the send day", () => {
    // Sent on the 10th, terms say «صلاحية أسبوع» -> the 17th.
    expect(computeValidityDate("2026-11-10", ["صلاحية أسبوع"])).toBe("2026-11-17");
  });

  it("defaults to one week when the terms state no period", () => {
    expect(
      computeValidityDate("2026-11-10", ["الأسعار بالجنيه المصري.", "طريقة الدفع: نقدي."]),
    ).toBe("2026-11-17");
    expect(computeValidityDate("2026-11-10", [])).toBe("2026-11-17");
    expect(DEFAULT_VALIDITY_DAYS).toBe(7);
  });

  it("honours an explicit number of days", () => {
    expect(computeValidityDate("2026-11-10", ["صلاحية 10 أيام"])).toBe("2026-11-20");
    expect(computeValidityDate("2026-11-10", ["valid 15 days"])).toBe("2026-11-25");
  });

  it("honours dual forms that carry their own number", () => {
    expect(computeValidityDate("2026-11-10", ["العرض صالح أسبوعين"])).toBe("2026-11-24");
    expect(computeValidityDate("2026-11-10", ["صلاحية شهرين"])).toBe("2027-01-09");
  });

  it("prefers an explicit number over a bare unit word in the same terms", () => {
    // «أسبوع» would say 7, but the operator wrote 10 days — the number wins.
    const period = validityPeriodFromTerms(["صلاحية أسبوع", "التسليم خلال 10 أيام"]);
    expect(period).toEqual({ days: 10, source: "terms" });
  });

  it("reads Arabic-Indic numerals and spelling variants", () => {
    expect(computeValidityDate("2026-11-10", ["صلاحية ١٠ أيام"])).toBe("2026-11-20");
    // «إسبوع» (hamza) must fold to «اسبوع».
    expect(computeValidityDate("2026-11-10", ["صلاحية إسبوع"])).toBe("2026-11-17");
    // «سنة» folds to «سنه».
    expect(computeValidityDate("2026-11-10", ["صلاحية سنة"])).toBe("2027-11-10");
  });

  it("reports whether the period came from the terms or the default", () => {
    expect(validityPeriodFromTerms(["صلاحية شهر"]).source).toBe("terms");
    expect(validityPeriodFromTerms(["لا يوجد"]).source).toBe("default");
  });

  it("crosses a month and a year boundary correctly", () => {
    expect(computeValidityDate("2026-11-28", ["صلاحية أسبوع"])).toBe("2026-12-05");
    expect(computeValidityDate("2026-12-30", ["صلاحية 5 أيام"])).toBe("2027-01-04");
  });

  it("adds days on local calendar days, not UTC", () => {
    // A late-evening local time must not roll to the next UTC day.
    const late = new Date(2026, 10, 10, 23, 30, 0);
    expect(todayIso(late)).toBe("2026-11-10");
    expect(addDaysIso("2026-11-10", 7)).toBe("2026-11-17");
  });
});
