/**
 * The WhatsApp gateway into the assistant.
 *
 * Two things here are security-relevant and easy to break silently:
 *  - the allowlist: a non-allowlisted number must fall through to the normal
 *    chat flow, not reach the agent (and definitely not the database tools);
 *  - inbound media: a document/image is downloaded and handed to the model, and
 *    a download FAILURE must not be answered as if the file were empty.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/test";

const findAuthorizedUser = vi.fn();
const loadSettings = vi.fn();
vi.mock("../../modules/ai-assistant/config", () => ({
  isAiConfigured: true,
  findAuthorizedUser: (...a: unknown[]) => findAuthorizedUser(...a),
  loadSettings: (...a: unknown[]) => loadSettings(...a),
}));

const runAgent = vi.fn();
vi.mock("../../modules/ai-assistant/agent", () => ({
  runAgent: (...a: unknown[]) => runAgent(...a),
  resetHistory: vi.fn(),
}));

const downloadInboundMedia = vi.fn();
const sendWhatsAppText = vi.fn();
const sendWhatsAppDocument = vi.fn();
vi.mock("../../modules/communications/service", () => ({
  downloadInboundMedia: (...a: unknown[]) => downloadInboundMedia(...a),
  sendWhatsAppText: (...a: unknown[]) => sendWhatsAppText(...a),
  sendWhatsAppDocument: (...a: unknown[]) => sendWhatsAppDocument(...a),
}));

const { handleAiAssistantMessage, pendingAiAssistantWork } =
  await import("../../modules/ai-assistant/handler");

const user = { id: 1, phone: "201000000000", name: "مدير", employeeId: 7, role: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
  findAuthorizedUser.mockResolvedValue(user);
  loadSettings.mockResolvedValue({
    enabled: true,
    model: "m",
    baseUrl: null,
    systemPrompt: null,
    language: "ar",
  });
  runAgent.mockResolvedValue({ reply: "جواب", attachments: [] });
});

describe("allowlist", () => {
  it("ignores a number that is not allowlisted", async () => {
    // Returns false so the rep bot / supplier chat still receives the message.
    findAuthorizedUser.mockResolvedValue(null);
    const taken = await handleAiAssistantMessage("201111111111", {
      type: "text",
      text: { body: "السلام عليكم" },
    });
    await pendingAiAssistantWork();
    expect(taken).toBe(false);
    expect(runAgent).not.toHaveBeenCalled();
  });
});

describe("documents", () => {
  it("downloads a document and passes it to the agent", async () => {
    downloadInboundMedia.mockResolvedValue({
      buffer: Buffer.from("pdf-bytes"),
      mimeType: "application/pdf",
    });

    await handleAiAssistantMessage("201000000000", {
      type: "document",
      document: { id: "doc-1", filename: "po.pdf", mime_type: "application/pdf" },
      text: { body: "لخّص ده" },
    });
    await pendingAiAssistantWork();

    expect(downloadInboundMedia).toHaveBeenCalledWith("doc-1");
    const payload = runAgent.mock.calls[0][0];
    expect(payload.document).toEqual({
      buffer: Buffer.from("pdf-bytes"),
      mimeType: "application/pdf",
      filename: "po.pdf",
    });
    // A caption is the question about the file.
    expect(payload.text).toBe("لخّص ده");
  });

  it("asks for a summary when the document arrives without a caption", async () => {
    downloadInboundMedia.mockResolvedValue({
      buffer: Buffer.from("x"),
      mimeType: "application/pdf",
    });
    await handleAiAssistantMessage("201000000000", {
      type: "document",
      document: { id: "d", filename: "po.pdf", mime_type: "application/pdf" },
    });
    await pendingAiAssistantWork();
    expect(runAgent.mock.calls[0][0].text).toContain("لخّص");
  });

  it("still answers the caption when the download fails", async () => {
    // The failure must not be swallowed: the model has to be told there is no
    // document rather than quietly answering a question about nothing.
    downloadInboundMedia.mockResolvedValue(null);
    await handleAiAssistantMessage("201000000000", {
      type: "document",
      document: { id: "d", filename: "po.pdf" },
      text: { body: "لخّص ده" },
    });
    await pendingAiAssistantWork();
    const payload = runAgent.mock.calls[0][0];
    expect(payload.document).toBeUndefined();
    expect(payload.text).toBe("لخّص ده");
  });
});

describe("images", () => {
  it("passes an image as a data URL and defaults the question", async () => {
    downloadInboundMedia.mockResolvedValue({ buffer: Buffer.from("img"), mimeType: "image/jpeg" });
    await handleAiAssistantMessage("201000000000", {
      type: "image",
      image: { id: "img-1", mime_type: "image/jpeg" },
    });
    await pendingAiAssistantWork();
    const payload = runAgent.mock.calls[0][0];
    expect(payload.imageUrl).toBe(
      `data:image/jpeg;base64,${Buffer.from("img").toString("base64")}`,
    );
    expect(payload.text).toContain("الصورة");
  });
});

describe("reset", () => {
  it("clears the conversation without calling the agent", async () => {
    await handleAiAssistantMessage("201000000000", { type: "text", text: { body: "تصفير" } });
    await pendingAiAssistantWork();
    expect(runAgent).not.toHaveBeenCalled();
    expect(sendWhatsAppText).toHaveBeenCalledWith(user.phone, expect.stringContaining("تصفير"));
  });
});
