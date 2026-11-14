/**
 * Reported live: replying to a picture showed «ردًا على رسالة / [صورة مرسلة]» —
 * a DESCRIPTION of the picture instead of the picture, so the operator could
 * not tell which image the reply answered.
 *
 * The quote read the target's `body`, and a media message stores a placeholder
 * there. It now renders the message's own media. This drives the REAL page so
 * the guard is behaviour, not a source grep — a grep for "img" would pass even
 * if the quote never rendered one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import CommunicationsPage from "../modules/communications/pages/index";

// The page opens an SSE stream for live updates. jsdom has no EventSource, and
// the stream is irrelevant to the quote — a no-op stub keeps the page mounting.
class NoopEventSource {
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
vi.stubGlobal("EventSource", NoopEventSource);

vi.mock("@/components/Layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/contexts/LanguageContext", () => ({
  useLanguage: () => ({ t: (k: string) => k, dir: "rtl" }),
}));

const json = (body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );

const IMAGE = {
  id: 1,
  waMessageId: "wamid.IMG",
  direction: "inbound",
  phone: "201000000000",
  body: "[صورة مرسلة] — كتالوج المورد",
  mediaId: "MEDIA-123",
  mediaType: "image",
  isRead: true,
  createdAt: new Date().toISOString(),
};

const REPLY = {
  id: 2,
  waMessageId: "wamid.TXT",
  direction: "inbound",
  phone: "201000000000",
  body: "دي المواصفات المطلوبة",
  mediaId: null,
  mediaType: null,
  replyToMessageId: "wamid.IMG",
  isRead: true,
  createdAt: new Date().toISOString(),
};

describe("a quoted reply shows the picture, not its placeholder", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("renders the quoted image inside the reply", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      // Order matters: the thread URL is a PREFIX-match of the list URL.
      if (/\/api\/whatsapp\/chats\/201000000000/.test(url)) return json([IMAGE, REPLY]);
      if (url.includes("/api/whatsapp/chats")) {
        return json([
          { phone: "201000000000", contactName: "aHMED", lastMessage: "دي المواصفات", unread: 0 },
        ]);
      }
      return json([]);
    });

    render(<CommunicationsPage />);

    // Open the conversation so the thread (and the quote) renders.
    const chat = await screen.findByText("aHMED");
    chat.click();

    await waitFor(() => {
      const quoted = document.querySelector('img[alt="الصورة المردود عليها"]');
      expect(quoted, "the quote must render the image itself").not.toBeNull();
      expect((quoted as HTMLImageElement).getAttribute("src")).toBe(
        "/api/whatsapp/media/MEDIA-123",
      );
    });
  });
});
