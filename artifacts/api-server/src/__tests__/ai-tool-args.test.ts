import { describe, expect, it } from "vitest";
import { coerceToolArgs, parseToolArgs, validateToolArgs } from "../modules/ai-assistant/tool-args";

const schema = {
  type: "object",
  properties: {
    table: { type: "string" },
    qty: { type: "number" },
    terms: { type: "array", items: { type: "string" } },
    mode: { type: "string", enum: ["a", "b"] },
    flag: { type: "boolean" },
  },
  required: ["table"],
};

describe("tool argument validation", () => {
  it("reports broken JSON instead of running with {}", () => {
    const r = parseToolArgs("{table:");
    expect(r.parseError).toMatch(/not valid JSON/);
    expect(validateToolArgs(schema, r.args, r.parseError)).toMatch(/not valid JSON/);
  });
  it("flags a missing required field and wrong types", () => {
    expect(validateToolArgs(schema, {})).toMatch(/missing required "table"/);
    expect(validateToolArgs(schema, { table: "x", qty: "abc" })).toMatch(/"qty" must be number/);
    expect(validateToolArgs(schema, { table: "x", terms: ["a", 3] })).toMatch(/"terms"\[1\]/);
    expect(validateToolArgs(schema, { table: "x", mode: "c" })).toMatch(/one of/);
  });
  it("accepts a valid call and tolerates extra properties", () => {
    expect(validateToolArgs(schema, { table: "x", qty: 2, extra: 1 })).toBeNull();
  });
  it("repairs numeric and boolean strings", () => {
    expect(coerceToolArgs(schema, { table: "x", qty: "230", flag: "true" })).toEqual({
      table: "x",
      qty: 230,
      flag: true,
    });
  });
});
