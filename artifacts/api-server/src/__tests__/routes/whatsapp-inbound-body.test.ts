import { describe, it, expect } from "vitest";
import { describeInboundBody } from "../../modules/communications/routes";

/**
 * What the operator SEES in the inbox for a message whose type we do not render.
 *
 * The defect: the fallback wrote our own diagnostic token into the body —
 * `[رسالة من نوع: system]` — so a supplier's reaction or a system notice arrived
 * as literal enum text. The operator replied «الرساله مش واضحه؟» to it, which is
 * the whole problem: a message nobody can read is worse than no message.
 *
 * The rule these pin: NEVER put the raw type in the body, and never claim to
 * have read content we did not read.
 */

type AnyMsg = Parameters<typeof describeInboundBody>[0];

describe("what the inbox shows for an unrendered message type", () => {
  it("does NOT leak the internal type token into the body", () => {
    const msg = {
      type: "system",
      system: { body: "", type: "customer_changed_number" },
    } as unknown as AnyMsg;
    const { body } = describeInboundBody(msg);
    // The exact string that reached a real operator's inbox.
    expect(body).not.toContain("رسالة من نوع");
    expect(body).not.toContain("system");
  });

  it("renders a reaction as a reaction, not as a message type", () => {
    const msg = {
      type: "reaction",
      reaction: { emoji: "👍", message_id: "wamid.X" },
    } as unknown as AnyMsg;
    const { body } = describeInboundBody(msg);
    expect(body).toContain("👍");
    expect(body).not.toContain("reaction");
  });

  it("says a system notice is a system notice", () => {
    const msg = { type: "system", system: { body: "" } } as unknown as AnyMsg;
    const { body } = describeInboundBody(msg);
    expect(body).toContain("رسالة نظام");
  });

  it("does NOT pretend to have read an unsupported message", () => {
    // Meta tells us the type was unknown and gives us NO content. Saying we
    // could not read it is the truth; anything else invents information.
    const msg = { type: "unsupported", unsupported: { type: "poll" } } as unknown as AnyMsg;
    const { body } = describeInboundBody(msg);
    expect(body).toContain("غير مدعوم");
    expect(body).not.toContain("unsupported");
  });

  it("falls back to something actionable, naming no internal type", () => {
    const msg = { type: "some_future_type" } as unknown as AnyMsg;
    const { body } = describeInboundBody(msg);
    expect(body).not.toContain("some_future_type");
    expect(body).toContain("غير مفهومة");
  });
});
