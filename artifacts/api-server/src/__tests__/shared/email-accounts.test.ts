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
          aliases: ["info@cortoba-supplies.com", "SALES@cortoba-supplies.com", "info@cortoba-supplies.com"],
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
      [{ primaryEmail: "info@cortoba-supplies.com", suspended: false, isAdmin: false, aliases: [] }],
      [],
    );
    expect(view.accounts[0].employee).toBeNull();
    expect(view.accounts[0].displayName).toBe("info");
  });
});
