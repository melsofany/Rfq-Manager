import { describe, it, expect } from "vitest";
import { buildEmployeeNo, nextSequence, generateEmployeeNo } from "../modules/hr/employee-number";
import { parsePhoto, PHOTO_MAX_BYTES } from "../modules/hr/onboarding-logic";

describe("employee number", () => {
  it("builds hire YY + birth YY + 4-digit sequence", () => {
    expect(buildEmployeeNo(2026, 1994, 1)).toBe("26940001");
    expect(buildEmployeeNo(2026, 2000, 27)).toBe("26000027");
  });
  it("starts at 0001 for the first hire of a year", () => {
    expect(nextSequence(2026, [])).toBe(1);
  });
  it("continues from the highest sequence of the same hire year", () => {
    expect(nextSequence(2026, ["26940001", "26900002", "26880007"])).toBe(8);
  });
  it("ignores other years and legacy numbers", () => {
    expect(nextSequence(2026, ["25940009", "E-001", "2694000"])).toBe(1);
  });
  it("generates the full number", () => {
    expect(generateEmployeeNo(2026, 1994, ["26940001"])).toEqual({ employeeNo: "26940002" });
  });
  it("refuses once the 9999 slots of a year are used", () => {
    expect(generateEmployeeNo(2026, 1994, ["26009999"])).toHaveProperty("error");
  });
});

describe("employee photo", () => {
  const tiny = "data:image/png;base64,iVBORw0KGgo=";
  it("accepts a small PNG/JPEG/WebP data URL", () => {
    const r = parsePhoto(tiny);
    expect(r).toHaveProperty("photo");
    if (r && "photo" in r) expect(r.photo.mime).toBe("image/png");
  });
  it("accepts no photo at all", () => {
    expect(parsePhoto(undefined)).toBeNull();
    expect(parsePhoto("")).toBeNull();
  });
  it("refuses other file types", () => {
    expect(parsePhoto("data:image/gif;base64,R0lGOD==")).toHaveProperty("error");
    expect(parsePhoto("data:text/html;base64,PGI+")).toHaveProperty("error");
  });
  it("refuses photos over 300 KB", () => {
    const big = "A".repeat(Math.ceil((PHOTO_MAX_BYTES * 4) / 3) + 8);
    expect(parsePhoto(`data:image/jpeg;base64,${big}`)).toHaveProperty("error");
  });
});
