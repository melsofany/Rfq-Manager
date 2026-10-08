import { describe, expect, it } from "vitest";
import { findUnkeptPromise } from "../modules/ai-assistant/answer-guard";

describe("findUnkeptPromise", () => {
  it("flags the live reply that promised to open the order and stopped", () => {
    const reply =
      "ظهر أمر مرشّح قوي هو P26E15215 يتضمّن نصوص Lugs. سأفتح هذا الأمر مباشرة للتأكد من بنوده الحرفية.";
    expect(findUnkeptPromise(reply)).toContain("سأفتح هذا الأمر");
  });

  it("flags Egyptian and long-form future promises", () => {
    expect(findUnkeptPromise("هفتح الأمر ده وأرجعلك")).not.toBeNull();
    expect(findUnkeptPromise("تمام. سوف أتحقق من بنود الأمر")).not.toBeNull();
    expect(findUnkeptPromise("سأبدأ حصرًا جديدًا من البريد")).not.toBeNull();
  });

  it("does not flag a reply that reports finished work", () => {
    expect(findUnkeptPromise("فتحت الأمر P26E15215 وبنده Cable Lug 70x12 بكمية 230.")).toBeNull();
    expect(findUnkeptPromise("تم الفحص: لم أجد بندًا بهذه الكمية.")).toBeNull();
    expect(findUnkeptPromise("")).toBeNull();
  });

  it("does not match inside an unrelated word", () => {
    expect(findUnkeptPromise("الأمر مفتوح عند العميل منذ شهر")).toBeNull();
  });
});
