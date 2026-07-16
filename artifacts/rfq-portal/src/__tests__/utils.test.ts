import { describe, it, expect } from "vitest";
import { cn } from "@/lib/utils";

describe("cn (className utility)", () => {
  it("merges plain class strings", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("ignores falsy values", () => {
    expect(cn("foo", undefined, null, false, "bar")).toBe("foo bar");
  });

  it("resolves Tailwind conflicts — last class wins", () => {
    // tailwind-merge: conflicting utilities → keep the last one
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
    expect(cn("p-4", "p-8")).toBe("p-8");
    expect(cn("font-bold", "font-medium")).toBe("font-medium");
  });

  it("keeps non-conflicting classes from both arguments", () => {
    const result = cn("flex items-center", "text-sm font-bold");
    expect(result).toContain("flex");
    expect(result).toContain("items-center");
    expect(result).toContain("text-sm");
    expect(result).toContain("font-bold");
  });

  it("handles conditional class objects", () => {
    expect(cn({ "bg-red-500": true, "bg-blue-500": false })).toBe("bg-red-500");
  });

  it("returns empty string for no arguments", () => {
    expect(cn()).toBe("");
  });

  it("handles array inputs", () => {
    expect(cn(["foo", "bar"])).toBe("foo bar");
  });
});
