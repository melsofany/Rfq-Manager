import { describe, it, expect } from "vitest";
import { validateSetting } from "../modules/hr/settings-logic";

describe("holidays setting", () => {
  it("accepts a list of dated holidays and sorts them by date", () => {
    expect(
      validateSetting("holidays", [
        { date: "2026-10-06", name: "ذكرى انتصار أكتوبر" },
        { date: "2026-04-26", name: "شم النسيم" },
      ]),
    ).toEqual({
      value: [
        { date: "2026-04-26", name: "شم النسيم" },
        { date: "2026-10-06", name: "ذكرى انتصار أكتوبر" },
      ],
    });
  });

  it("treats null and an empty list as no holidays", () => {
    expect(validateSetting("holidays", null)).toEqual({ value: [] });
    expect(validateSetting("holidays", [])).toEqual({ value: [] });
  });

  it("rejects bad dates, missing names, and duplicate dates", () => {
    expect(validateSetting("holidays", [{ date: "2026-02-30", name: "x" }])).toHaveProperty(
      "error",
    );
    expect(validateSetting("holidays", [{ date: "2026-10-06", name: "" }])).toHaveProperty("error");
    expect(
      validateSetting("holidays", [
        { date: "2026-10-06", name: "a" },
        { date: "2026-10-06", name: "b" },
      ]),
    ).toHaveProperty("error");
  });
});
