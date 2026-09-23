import { describe, it, expect } from "vitest";
import { whatsappSafeMime } from "../../modules/communications/service";

/**
 * WhatsApp's media upload only accepts a fixed list of types and rejects the
 * rest with `(#100)`. The rejection is invisible to the operator — they asked
 * for a file and simply never receive one — so every MIME the assistant can
 * produce must map onto an accepted type.
 */
describe("whatsappSafeMime", () => {
  it("remaps text/csv, which WhatsApp rejects outright", () => {
    // Observed live: every CSV export failed to upload with
    // `Received file of type 'text/csv'`, so the file was silently lost.
    expect(whatsappSafeMime("text/csv")).toBe("text/plain");
    expect(whatsappSafeMime("application/csv")).toBe("text/plain");
    expect(whatsappSafeMime("TEXT/CSV")).toBe("text/plain");
  });

  it("keeps the types WhatsApp accepts unchanged", () => {
    for (const mime of [
      "application/pdf",
      "text/plain",
      "image/jpeg",
      "image/png",
      "audio/ogg",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]) {
      expect(whatsappSafeMime(mime)).toBe(mime);
    }
  });

  it("never returns a type WhatsApp would reject", () => {
    const accepted = new Set([
      "audio/aac",
      "audio/mp4",
      "audio/mpeg",
      "audio/amr",
      "audio/ogg",
      "audio/opus",
      "application/vnd.ms-powerpoint",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/pdf",
      "text/plain",
      "application/vnd.ms-excel",
      "image/jpeg",
      "image/png",
      "image/webp",
      "video/mp4",
      "video/3gpp",
    ]);
    for (const mime of [
      "text/csv",
      "application/csv",
      "application/json",
      "text/html",
      "application/octet-stream",
      "",
      "  ",
      "application/x-foo",
    ]) {
      expect(accepted.has(whatsappSafeMime(mime))).toBe(true);
    }
  });

  it("handles a missing or malformed type without throwing", () => {
    expect(() => whatsappSafeMime("")).not.toThrow();
    expect(whatsappSafeMime("")).toBe("text/plain");
  });
});
