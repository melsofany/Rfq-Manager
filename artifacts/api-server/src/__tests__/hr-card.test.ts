import { describe, it, expect } from "vitest";
import {
  BLANK_PHOTO,
  CARD_MAX_HTML_CHARS,
  DEFAULT_CARD_FRONT,
  escapeHtml,
  renderCardHtml,
  validateCardTemplate,
  type CardData,
} from "../modules/hr/card-logic";

const emp: CardData = {
  fullName: "أحمد <b>يوسف</b>",
  nationalId: "29801011234567",
  employeeNo: "EMP-0001",
  jobTitle: "مهندس",
  department: null,
  hireDate: "2024-01-01",
  photo: "data:image/png;base64,AAAA",
};

describe("card rendering", () => {
  it("escapes HTML in employee values", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("replaces placeholders with escaped values", () => {
    const out = renderCardHtml("<p>{{fullName}}|{{ employeeNo }}|{{jobTitle}}</p>", emp);
    expect(out).toBe("<p>أحمد &lt;b&gt;يوسف&lt;/b&gt;|EMP-0001|مهندس</p>");
  });

  it("empties missing department and uses the blank photo when there is none", () => {
    expect(renderCardHtml("[{{department}}]", emp)).toBe("[]");
    expect(renderCardHtml('<img src="{{photo}}">', { ...emp, photo: null })).toBe(
      `<img src="${BLANK_PHOTO}">`,
    );
  });

  it("prints the national ID only when it is provided", () => {
    expect(renderCardHtml("{{nationalId}}", emp)).toBe("29801011234567");
    expect(renderCardHtml("[{{nationalId}}]", { ...emp, nationalId: null })).toBe("[]");
  });

  it("leaves unknown placeholders untouched", () => {
    expect(renderCardHtml("{{passport}}", emp)).toBe("{{passport}}");
  });

  it("the default front design uses known placeholders only", () => {
    const out = renderCardHtml(DEFAULT_CARD_FRONT, emp);
    expect(out).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
  });
});

describe("card template validation", () => {
  it("accepts null (use default) and a clean page", () => {
    expect(validateCardTemplate(null)).toEqual({ value: null });
    expect(validateCardTemplate({ html: "<div>ok</div>" })).toEqual({
      value: { html: "<div>ok</div>" },
    });
  });

  it("rejects scripts and inline handlers", () => {
    expect(validateCardTemplate({ html: "<script>alert(1)</script>" })).toHaveProperty("error");
    expect(validateCardTemplate({ html: '<img src=x onerror="alert(1)">' })).toHaveProperty(
      "error",
    );
  });

  it("rejects empty, wrong-shaped and oversized designs", () => {
    expect(validateCardTemplate({ html: "   " })).toHaveProperty("error");
    expect(validateCardTemplate("html")).toHaveProperty("error");
    expect(validateCardTemplate({ html: "a".repeat(CARD_MAX_HTML_CHARS + 1) })).toHaveProperty(
      "error",
    );
  });
});
