import { describe, it, expect } from "vitest";
import {
  notificationFor,
  shouldNotify,
  isEmailConfigured,
  SUPPLIER_NOTIFY_TEMPLATES,
  statusLabel,
} from "../modules/supplier-review/notifications";
import { REVIEW_STATUS } from "../modules/supplier-review/workflow";

/**
 * The supplier must learn the decision. These guards pin the DECISION TABLE —
 * which transitions notify, and what each message says — because a decision the
 * supplier never hears about leaves them waiting for an answer already given.
 */
describe("supplier notifications — decision table", () => {
  const base = {
    phone: "+201000000000",
    email: "supplier@example.com",
    supplierName: "شركة النور للتوريدات",
    reference: "APP-2026-000009",
  };

  it("notifies on approve, reject, more-info, more-documents and suspend", () => {
    for (const status of [
      REVIEW_STATUS.APPROVED,
      REVIEW_STATUS.REJECTED,
      REVIEW_STATUS.NEEDS_INFORMATION,
      REVIEW_STATUS.NEEDS_DOCUMENTS,
      REVIEW_STATUS.SUSPENDED,
    ]) {
      expect(shouldNotify(status), `${status} must notify`).toBe(true);
      expect(notificationFor({ ...base, status }), `${status} needs a message`).not.toBeNull();
    }
  });

  it("stays silent on internal moves — assigned / under review / verified", () => {
    // Messaging on every status change trains the supplier to ignore all of them.
    for (const status of [
      REVIEW_STATUS.ASSIGNED,
      REVIEW_STATUS.UNDER_REVIEW,
      REVIEW_STATUS.VERIFIED,
    ]) {
      expect(shouldNotify(status), `${status} must NOT notify`).toBe(false);
      expect(notificationFor({ ...base, status })).toBeNull();
    }
  });

  it("the approval message states the approval and carries the reference", () => {
    const m = notificationFor({ ...base, status: REVIEW_STATUS.APPROVED })!;
    expect(m.body).toContain("اعتماد");
    expect(m.body).toContain(base.reference);
    expect(m.body).toContain(base.supplierName);
    expect(m.subject).toContain(base.reference);
  });

  it("the rejection message includes the reviewer's reason", () => {
    const m = notificationFor({
      ...base,
      status: REVIEW_STATUS.REJECTED,
      note: "صورة السجل التجاري غير واضحة",
    })!;
    expect(m.body).toContain("تعذّر اعتماد");
    expect(m.body).toContain("صورة السجل التجاري غير واضحة");
  });

  it("a document request lists what is missing and the deadline", () => {
    const m = notificationFor({
      ...base,
      status: REVIEW_STATUS.NEEDS_DOCUMENTS,
      requestedItems: ["السجل التجاري", "خطاب البنك"],
      deadline: "2026-12-01",
    })!;
    expect(m.body).toContain("السجل التجاري");
    expect(m.body).toContain("خطاب البنك");
    expect(m.body).toContain("2026-12-01");
  });

  it("an information request names the required data, not documents", () => {
    const m = notificationFor({
      ...base,
      status: REVIEW_STATUS.NEEDS_INFORMATION,
      requestedItems: ["الرقم الضريبي"],
    })!;
    expect(m.body).toContain("البيانات");
    expect(m.body).toContain("الرقم الضريبي");
  });

  it("a missing supplier name does not produce a broken greeting", () => {
    const m = notificationFor({
      ...base,
      supplierName: "",
      status: REVIEW_STATUS.APPROVED,
    })!;
    expect(m.body).toContain("المورد الكريم");
    expect(m.body).not.toContain("السادة ،");
  });

  it("every notifying status has its own WhatsApp template", () => {
    // One template with a variable decision word would put «تم اعتماد» and
    // «مرفوض» in the same body, and Meta does not allow editing an approved one.
    const names = Object.values(SUPPLIER_NOTIFY_TEMPLATES);
    expect(new Set(names).size).toBe(names.length);
    for (const status of [
      REVIEW_STATUS.APPROVED,
      REVIEW_STATUS.REJECTED,
      REVIEW_STATUS.NEEDS_INFORMATION,
      REVIEW_STATUS.NEEDS_DOCUMENTS,
      REVIEW_STATUS.SUSPENDED,
    ]) {
      expect(SUPPLIER_NOTIFY_TEMPLATES[status], `${status} needs a template`).toBeTruthy();
    }
  });

  it("labels the status for the reviewer's confirmation line", () => {
    expect(statusLabel(REVIEW_STATUS.APPROVED)).toBeTruthy();
    expect(statusLabel(REVIEW_STATUS.REJECTED)).toBeTruthy();
  });

  it("reports email as NOT configured when SMTP credentials are absent", () => {
    // This deployment has no SMTP_* vars at all, so the honest answer is "not
    // configured" — never a silent success.
    const saved = {
      host: process.env.SMTP_HOST,
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    };
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    expect(isEmailConfigured()).toBe(false);

    process.env.SMTP_USER = "u";
    expect(isEmailConfigured()).toBe(false); // user alone is not enough
    process.env.SMTP_PASS = "p";
    expect(isEmailConfigured()).toBe(true); // host defaults to smtp.gmail.com

    process.env.SMTP_HOST = saved.host ?? "";
    process.env.SMTP_USER = saved.user ?? "";
    process.env.SMTP_PASS = saved.pass ?? "";
    if (!saved.host) delete process.env.SMTP_HOST;
    if (!saved.user) delete process.env.SMTP_USER;
    if (!saved.pass) delete process.env.SMTP_PASS;
  });
});
