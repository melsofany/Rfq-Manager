/**
 * Pure mapping: Google Workspace users ↔ system employees.
 *
 * Kept free of I/O so the linking rules can be tested without Google.
 * A Workspace user is linked to an employee when the employee's login email is
 * the user's primary address (case-insensitive). Aliases are extra addresses
 * that belong to the same person, so they count toward `addressCount`.
 */

export interface DirectoryUser {
  primaryEmail: string;
  name?: string;
  suspended: boolean;
  isAdmin: boolean;
  aliases: string[];
}

export interface EmployeeRef {
  id: number;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  permissions: Record<string, boolean> | null;
}

export interface AccountRow {
  email: string;
  displayName: string;
  suspended: boolean;
  isAdmin: boolean;
  aliases: string[];
  /** Primary address plus aliases: how many addresses this person holds. */
  addressCount: number;
  employee: {
    id: number;
    name: string;
    role: string;
    isActive: boolean;
    permissions: Record<string, boolean> | null;
  } | null;
}

export interface EmailAccountsView {
  domain: string;
  accounts: AccountRow[];
  /** Employees with no matching Workspace account (not an error, just a gap). */
  employeesWithoutAccount: Array<Pick<EmployeeRef, "id" | "name" | "email" | "role">>;
}

const norm = (s: string) => s.trim().toLowerCase();

export function buildEmailAccountsView(
  domain: string,
  users: DirectoryUser[],
  employees: EmployeeRef[],
): EmailAccountsView {
  const employeeByEmail = new Map(employees.map((e) => [norm(e.email), e]));
  const linkedEmployeeIds = new Set<number>();

  const accounts: AccountRow[] = users
    .map((u): AccountRow => {
      const emp = employeeByEmail.get(norm(u.primaryEmail)) ?? null;
      if (emp) linkedEmployeeIds.add(emp.id);
      const aliases = [...new Set(u.aliases.map(norm))].filter((a) => a !== norm(u.primaryEmail));
      return {
        email: norm(u.primaryEmail),
        displayName: u.name?.trim() || norm(u.primaryEmail).split("@")[0],
        suspended: u.suspended,
        isAdmin: u.isAdmin,
        aliases,
        addressCount: 1 + aliases.length,
        employee: emp
          ? {
              id: emp.id,
              name: emp.name,
              role: emp.role,
              isActive: emp.isActive,
              permissions: emp.permissions,
            }
          : null,
      };
    })
    .sort((a, b) => a.email.localeCompare(b.email));

  const employeesWithoutAccount = employees
    .filter((e) => !linkedEmployeeIds.has(e.id))
    .map((e) => ({ id: e.id, name: e.name, email: e.email, role: e.role }));

  return { domain, accounts, employeesWithoutAccount };
}
