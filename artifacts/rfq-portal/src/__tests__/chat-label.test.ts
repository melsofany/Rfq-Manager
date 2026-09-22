import { describe, it, expect } from "vitest";
import { chatLabel } from "@/lib/chat-label";

describe("chatLabel", () => {
  it("prefers the registered supplier name over the WhatsApp profile name", () => {
    expect(
      chatLabel({ phone: "201000000000", supplierName: "شركة النيل", contactName: "Ahmed" }),
    ).toBe("شركة النيل");
  });

  it("falls back to the WhatsApp profile name when no supplier is linked", () => {
    expect(chatLabel({ phone: "201000000000", supplierName: null, contactName: "Ahmed" })).toBe(
      "Ahmed",
    );
  });

  it("falls back to the phone number when there is no name at all", () => {
    expect(chatLabel({ phone: "201000000000", supplierName: null, contactName: null })).toBe(
      "201000000000",
    );
  });

  it("treats empty strings as absent", () => {
    expect(chatLabel({ phone: "201000000000", supplierName: "", contactName: "Ahmed" })).toBe(
      "Ahmed",
    );
    expect(chatLabel({ phone: "201000000000", supplierName: "", contactName: "" })).toBe(
      "201000000000",
    );
  });

  it("works when the name fields are omitted entirely", () => {
    expect(chatLabel({ phone: "201000000000" })).toBe("201000000000");
  });
});
