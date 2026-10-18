import { describe, it, expect } from "vitest";
import {
  BLANK_PHOTO,
  CARD_MAX_HTML_CHARS,
  DEFAULT_CARD_FRONT,
  escapeHtml,
  renderCardHtml,
  validateCardManager,
  validateCardTemplate,
  type CardData,
} from "../modules/hr/card-logic";

const emp: CardData = {
  fullName: "أحمد <b>يوسف</b>",
  nationalId: "29801011234567",
  managerName: "",
  managerSignature: null,
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

describe("general manager on cards", () => {
  it("renders the manager name escaped and the signature image", () => {
    const out = renderCardHtml('<p>{{managerName}}</p><img src="{{managerSignature}}">', {
      ...emp,
      managerName: "أ/ <i>محمد</i>",
      managerSignature: "data:image/png;base64,AAAA",
    });
    expect(out).toBe('<p>أ/ &lt;i&gt;محمد&lt;/i&gt;</p><img src="data:image/png;base64,AAAA">');
  });

  it("accepts a name and an image signature, or nothing", () => {
    expect(validateCardManager(null)).toEqual({ value: null });
    expect(
      validateCardManager({ name: "  محمد كمال  ", signature: "data:image/png;base64,AAAA" }),
    ).toEqual({ value: { name: "محمد كمال", signature: "data:image/png;base64,AAAA" } });
    expect(validateCardManager({ name: "", signature: null })).toEqual({
      value: { name: "", signature: null },
    });
  });

  it("rejects non-image signatures, long names and oversized signatures", () => {
    expect(
      validateCardManager({ name: "x", signature: "data:text/html;base64,PHNjcmlwdD4=" }),
    ).toHaveProperty("error");
    expect(validateCardManager({ name: "x".repeat(101) })).toHaveProperty("error");
    expect(
      validateCardManager({ name: "x", signature: "data:image/png;base64," + "A".repeat(300_000) }),
    ).toHaveProperty("error");
  });
});
