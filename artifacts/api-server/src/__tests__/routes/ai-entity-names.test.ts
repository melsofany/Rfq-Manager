/**
 * Regression tests for the assistant's ENTITY-NAME grounding.
 *
 * The live failure this targets (the «هاي فولت» incident): challenged about PO
 * 37, the model invented «شركة النور» / «الشركة المصرية» as the supplier. Prompt
 * rules alone did not stop it, and the only thing that caught it was a human
 * asking again. The fix is to give the model the REAL supplier/customer list and
 * to check the draft against it before the reply is sent.
 *
 * `findUnknownEntityNames` is deliberately conservative: an answer is only
 * flagged when a name-shaped run shares no token with any known entity. A wrong
 * flag would make the assistant "correct" a name it got right, which is a worse
 * failure than the one being fixed — so the false-positive cases are pinned too.
 */
import { describe, it, expect } from "vitest";

// The module reads no database at import time for the pure function, but it does
// import `@workspace/db` for its tables, so the URL must exist first.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/test";

const { findUnknownEntityNames } = await import("../../modules/ai-assistant/db-tools");

const KNOWN = {
  suppliers: [
    { id: 167, name: "هاي فولت" },
    { id: 146, name: "شركة الأمل للتوريدات" },
  ],
  customers: [{ id: 4, name: "المصرية للحفر" }],
};

describe("findUnknownEntityNames", () => {
  it("flags an invented supplier name", () => {
    expect(findUnknownEntityNames("أمر الشراء 37 خاص بشركة النور.", KNOWN)).toContain("شركة النور");
    expect(findUnknownEntityNames("والمورد هو مؤسسة الدلتا للتوريدات.", KNOWN)).toContain(
      "مؤسسة الدلتا للتوريدات",
    );
  });

  it("accepts a name that merely shares a word with a known entity", () => {
    // «الشركة المصرية» shares the token «المصرية» with the real customer
    // «المصرية للحفر». Accepting it is the deliberate safe direction: a wrong
    // flag would make the assistant "correct" a name it may have got right.
    expect(findUnknownEntityNames("المورد الخاص بالأمر 37 هو الشركة المصرية.", KNOWN)).toEqual([]);
  });

  it("accepts a name that really exists", () => {
    expect(findUnknownEntityNames("أمر الشراء 37 خاص بهاي فولت.", KNOWN)).toEqual([]);
    expect(findUnknownEntityNames("العميل هو المصرية للحفر.", KNOWN)).toEqual([]);
  });

  it("accepts a correct short form of a known name", () => {
    // The operator often shortens «شركة الأمل للتوريدات» to «الأمل»; flagging
    // that would make the assistant "correct" a name it got right.
    expect(findUnknownEntityNames("تم الإرسال إلى الأمل.", KNOWN)).toEqual([]);
    expect(findUnknownEntityNames("تم الإرسال إلى شركة الأمل.", KNOWN)).toEqual([]);
  });

  it("matches despite Arabic spelling differences", () => {
    // taa marbuta / alef-hamza folding: «هاي فولت» vs «های فولت» , «الأمل» vs «الامل».
    expect(findUnknownEntityNames("خاص بهاي فولت.", KNOWN)).toEqual([]);
    expect(findUnknownEntityNames("تم الإرسال إلى الامل.", KNOWN)).toEqual([]);
  });

  it("does not flag ordinary prose around a real name", () => {
    const text =
      "من جدول بنود أوامر الشراء: البند موجود في الأمر، والمورد هاي فولت، والكمية 12 قطعة.";
    expect(findUnknownEntityNames(text, KNOWN)).toEqual([]);
  });

  it("returns nothing when the vocabulary is empty (never guess)", () => {
    // Without a known list there is no basis to call anything unknown; the
    // checker must stay silent rather than flag every name.
    expect(findUnknownEntityNames("خاص بشركة أي كلام.", { suppliers: [], customers: [] })).toEqual(
      [],
    );
  });

  it("ignores single words (not a company name shape)", () => {
    expect(findUnknownEntityNames("تم.", KNOWN)).toEqual([]);
    expect(findUnknownEntityNames("الطلب موجود.", KNOWN)).toEqual([]);
  });
});
