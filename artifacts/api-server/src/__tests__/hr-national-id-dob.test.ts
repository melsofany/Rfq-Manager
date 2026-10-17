import { describe, it, expect } from "vitest";
import { birthDateFromNationalId } from "../modules/hr/onboarding-logic";

describe("birthDateFromNationalId", () => {
  it("reads a 1990s birth date (century digit 2)", () => {
    expect(birthDateFromNationalId("29403151234567")).toBe("1994-03-15");
  });

  it("reads a 2000s birth date (century digit 3)", () => {
    expect(birthDateFromNationalId("30112010012345")).toBe("2001-12-01");
  });

  it("returns null for a bad century digit", () => {
    expect(birthDateFromNationalId("19403151234567")).toBeNull();
  });

  it("returns null for a date that does not exist", () => {
    expect(birthDateFromNationalId("29402301234567")).toBeNull(); // Feb 30
    expect(birthDateFromNationalId("29413151234567")).toBeNull(); // month 13
  });

  it("returns null for malformed input", () => {
    expect(birthDateFromNationalId("2940315123456")).toBeNull();
    expect(birthDateFromNationalId("abcdefghijklmn")).toBeNull();
  });
});
