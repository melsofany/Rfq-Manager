import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/incidents.json";
import { detectIncidents, incidentToFixture } from "../modules/ai-assistant/incidents";

const base = { raised: [], toolCalls: 0, toolErrors: 0, hadToolMarkup: false, usedJob: false };

describe("incident detection", () => {
  // Each fixture is a REAL reply that went out in production. If a change makes
  // the detector stop recognising one, the failure has become invisible again.
  for (const f of fixtures) {
    it(`recognises the recorded failure: ${f.question.slice(0, 40)}`, () => {
      const kinds = detectIncidents({ ...base, reply: f.badReply });
      for (const k of f.kinds) expect(kinds).toContain(k);
    });
  }

  it("does not flag a normal answer", () => {
    expect(
      detectIncidents({ ...base, reply: "الطلب 26R012450 ميعاده 2026-10-10.", toolCalls: 3 }),
    ).toEqual([]);
  });
  it("flags a run where most tool calls failed", () => {
    expect(detectIncidents({ ...base, reply: "تمام", toolCalls: 4, toolErrors: 3 })).toContain(
      "tool_errors",
    );
  });
  it("a promise is not an incident when a background job carries it", () => {
    expect(detectIncidents({ ...base, reply: "سأفتح الأمر", usedJob: true })).not.toContain(
      "unkept_promise",
    );
  });
  it("turns a row into a fixture", () => {
    expect(incidentToFixture({ question: "q", reply: "r", kinds: ["gave_up"] })).toEqual({
      question: "q",
      badReply: "r",
      kinds: ["gave_up"],
    });
  });
});
