import { describe, it, expect } from "vitest";
import { withSchemaHint } from "../modules/ai-assistant/query-exec";

describe("withSchemaHint", () => {
  it("points the model at describe_schema when a column name does not exist (live: i.customerpoid)", () => {
    const err = Object.assign(new Error("column i.customerpoid does not exist"), { code: "42703" });
    const out = withSchemaHint(err);
    expect(out).toContain("column i.customerpoid does not exist");
    expect(out).toContain("describe_schema");
  });

  it("covers a missing table as well", () => {
    const err = Object.assign(new Error('relation "foo" does not exist'), { code: "42P01" });
    expect(withSchemaHint(err)).toContain("describe_schema");
  });

  it("leaves unrelated errors untouched — no hint where it would mislead", () => {
    const err = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
    expect(withSchemaHint(err)).not.toContain("describe_schema");
  });

  it("bounds the message length", () => {
    const err = Object.assign(new Error("x".repeat(1000)), { code: "42703" });
    expect(withSchemaHint(err).length).toBeLessThan(500); // 300-char error cap + a short hint
  });
});
