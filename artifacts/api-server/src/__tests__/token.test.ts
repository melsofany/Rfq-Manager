import { describe, it, expect } from "vitest";
import { generateToken } from "../shared/token";

describe("generateToken", () => {
  it("returns a non-empty string", () => {
    const token = generateToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("returns a base64url-safe string (no +, /, = characters)", () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("returns 16-byte token (22 chars in base64url)", () => {
    const token = generateToken();
    // 16 bytes → ceil(16*4/3) = 22 base64url chars (no padding)
    expect(token.length).toBe(22);
  });

  it("generates unique tokens on each call", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateToken()));
    expect(tokens.size).toBe(50);
  });
});
