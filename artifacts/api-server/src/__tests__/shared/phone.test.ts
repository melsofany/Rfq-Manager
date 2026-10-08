import { describe, it, expect } from "vitest";
import { pickSendablePhone, splitPhoneCandidates, normalizeSinglePhone } from "../../shared/phone";

describe("pickSendablePhone", () => {
  it("picks the first of two numbers joined by a slash (live RFQ CRQ-2026-000256)", () => {
    const r = pickSendablePhone("201147498505/201006110550");
    expect(r.phone).toBe("201147498505");
    expect(r.ignored).toEqual(["201006110550"]);
  });

  it("never returns a string containing a separator", () => {
    for (const raw of ["0114 749 8505 / 0100 611 0550", "+20 114 749 8505, +20 100 611 0550"]) {
      const { phone } = pickSendablePhone(raw);
      expect(phone).toMatch(/^\d{10,15}$/);
    }
  });

  it("normalises a local Egyptian mobile to international form", () => {
    expect(pickSendablePhone("01147498505").phone).toBe("201147498505");
    expect(pickSendablePhone("+20 114 749 8505").phone).toBe("201147498505");
    expect(pickSendablePhone("0020114-749-8505").phone).toBe("201147498505");
  });

  it("skips a junk first candidate and uses the next sendable one", () => {
    const r = pickSendablePhone("N/A / 01147498505");
    expect(r.phone).toBe("201147498505");
  });

  it("returns null when nothing is sendable", () => {
    expect(pickSendablePhone("")).toEqual({ phone: null, ignored: [] });
    expect(pickSendablePhone(null).phone).toBeNull();
    expect(pickSendablePhone("abc").phone).toBeNull();
  });

  it("splits on Arabic 'or' and semicolons", () => {
    expect(splitPhoneCandidates("01000000000 أو 01111111111; 01222222222")).toHaveLength(3);
  });

  it("strips invisible bidi marks pasted from WhatsApp", () => {
    expect(normalizeSinglePhone("‎01147498505‏")).toBe("201147498505");
  });
});
