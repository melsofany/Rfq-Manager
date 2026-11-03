import { describe, it, expect } from "vitest";
import { buildEmailAccountsView, type EmployeeRef } from "../../modules/email-accounts/accounts";

const emp = (over: Partial<EmployeeRef>): EmployeeRef => ({
  id: 1,
  name: "Test",
  email: "test@cortoba-supplies.com",
  role: "purchasing",
  isActive: true,
  permissions: null,
  ...over,
});

describe("buildEmailAccountsView", () => {
  it("links a workspace user to the employee with the same primary email, ignoring case", () => {
    const view = buildEmailAccountsView(
      "cortoba-supplies.com",
      [{ primaryEmail: "Ali@Cortoba-Supplies.com", suspended: false, isAdmin: false, aliases: [] }],
      [emp({ id: 7, name: "Ali", email: "ali@cortoba-supplies.com" })],
    );
    expect(view.accounts[0].employee?.id).toBe(7);
    expect(view.employeesWithoutAccount).toEqual([]);
  });

  it("counts primary address plus aliases and drops duplicates of the primary", () => {
    const view = buildEmailAccountsView(
      "cortoba-supplies.com",
      [
        {
          primaryEmail: "sales@cortoba-supplies.com",
          suspended: false,
          isAdmin: false,
          aliases: [
            "info@cortoba-supplies.com",
            "SALES@cortoba-supplies.com",
            "info@cortoba-supplies.com",
          ],
        },
      ],
      [],
    );
    expect(view.accounts[0].aliases).toEqual(["info@cortoba-supplies.com"]);
    expect(view.accounts[0].addressCount).toBe(2);
  });

  it("reports employees that have no workspace account", () => {
    const view = buildEmailAccountsView(
      "cortoba-supplies.com",
      [],
      [emp({ id: 3, name: "Nour", email: "nour@cortoba-supplies.com" })],
    );
    expect(view.employeesWithoutAccount).toEqual([
      { id: 3, name: "Nour", email: "nour@cortoba-supplies.com", role: "purchasing" },
    ]);
  });

  it("keeps workspace accounts that match no employee, with employee null", () => {
    const view = buildEmailAccountsView(
      "cortoba-supplies.com",
      [
        {
          primaryEmail: "info@cortoba-supplies.com",
          suspended: false,
          isAdmin: false,
          aliases: [],
        },
      ],
      [],
    );
    expect(view.accounts[0].employee).toBeNull();
    expect(view.accounts[0].displayName).toBe("info");
  });
});

describe("extractBody", () => {
  const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

  it("prefers the text/plain part of a multipart message", async () => {
    const { extractBody } = await import("../../modules/email-accounts/gmail");
    const body = extractBody({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: b64url("<p>html</p>") } },
        { mimeType: "text/plain", body: { data: b64url("plain text مرحبا") } },
      ],
    });
    expect(body).toBe("plain text مرحبا");
  });

  it("falls back to stripped HTML when there is no plain part", async () => {
    const { extractBody } = await import("../../modules/email-accounts/gmail");
    const body = extractBody({
      mimeType: "text/html",
      body: { data: b64url("<div>Hello&nbsp;<b>you</b></div><script>x()</script>") },
    });
    expect(body).toBe("Hello you");
  });
});

describe("collectAttachments", () => {
  it("finds named attachments nested inside multipart messages", async () => {
    const { collectAttachments } = await import("../../modules/email-accounts/gmail");
    const found = collectAttachments({
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [{ mimeType: "text/plain", body: { data: "x" } }],
        },
        {
          mimeType: "application/pdf",
          filename: "invoice.pdf",
          body: { attachmentId: "ANGjdJ8abc123", size: 2048 },
        },
        { mimeType: "image/png", filename: "", body: { data: "inline" } },
      ],
    });
    expect(found).toEqual([
      {
        attachmentId: "ANGjdJ8abc123",
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        size: 2048,
      },
    ]);
  });
});
