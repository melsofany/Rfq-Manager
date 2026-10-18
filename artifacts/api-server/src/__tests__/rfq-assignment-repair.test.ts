import { describe, it, expect } from "vitest";
import { planAssignmentRepairs } from "../modules/rfq/assignment-repair";

const cats = [
  { id: 1, code: "elec", name: "كهرباء", kind: "functional", parentId: null },
  { id: 2, code: "mech", name: "الميكانيكا", kind: "functional", parentId: null },
  { id: 3, code: "plumb", name: "سباكة", kind: "functional", parentId: null },
  { id: 4, code: "light", name: "إضاءة", kind: "functional", parentId: null },
];
const owners = [
  { employeeId: 10, categoryId: 1, isPrimary: true },
  { employeeId: 20, categoryId: 2, isPrimary: false },
  { employeeId: 21, categoryId: 2, isPrimary: false },
  { employeeId: 30, categoryId: 3, isPrimary: false },
];

describe("planAssignmentRepairs", () => {
  it("leaves a correct assignment alone", () => {
    const plan = planAssignmentRepairs({
      items: [{ id: 1, categoryId: 1, cancelled: false }],
      assignments: [
        { id: 100, customerRfqItemId: 1, categoryId: 1, employeeId: 10, source: "auto" },
      ],
      categories: cats,
      owners,
    });
    expect(plan.repairs).toEqual([]);
  });

  it("fixes only the category label when the employee already owns the domain", () => {
    const plan = planAssignmentRepairs({
      items: [{ id: 1, categoryId: 1, cancelled: false }],
      assignments: [
        { id: 100, customerRfqItemId: 1, categoryId: 4, employeeId: 10, source: "auto" },
      ],
      categories: cats,
      owners,
    });
    expect(plan.repairs).toEqual([
      {
        assignmentId: 100,
        customerRfqItemId: 1,
        reason: "category",
        from: { categoryId: 4, employeeId: 10 },
        to: { categoryId: 1, employeeId: 10 },
      },
    ]);
  });

  it("moves an item to the primary owner when the employee does not own the category", () => {
    const plan = planAssignmentRepairs({
      items: [{ id: 1, categoryId: 1, cancelled: false }],
      assignments: [
        { id: 100, customerRfqItemId: 1, categoryId: 1, employeeId: 30, source: "inherited" },
      ],
      categories: cats,
      owners,
    });
    expect(plan.repairs[0]).toMatchObject({
      reason: "owner",
      to: { categoryId: 1, employeeId: 10 },
    });
  });

  it("never changes a manual decision; it reports it", () => {
    const plan = planAssignmentRepairs({
      items: [{ id: 1, categoryId: 1, cancelled: false }],
      assignments: [
        { id: 100, customerRfqItemId: 1, categoryId: 4, employeeId: 30, source: "manual" },
      ],
      categories: cats,
      owners,
    });
    expect(plan.repairs).toEqual([]);
    expect(plan.skippedManual).toEqual([{ assignmentId: 100, customerRfqItemId: 1 }]);
  });

  it("reports, and does not guess, when the category has several owners and no primary", () => {
    const plan = planAssignmentRepairs({
      items: [{ id: 1, categoryId: 2, cancelled: false }],
      assignments: [
        { id: 100, customerRfqItemId: 1, categoryId: 3, employeeId: 30, source: "auto" },
      ],
      categories: cats,
      owners,
    });
    expect(plan.repairs).toEqual([]);
    expect(plan.noOwner).toEqual([{ assignmentId: 100, customerRfqItemId: 1, categoryId: 2 }]);
  });

  it("reports an item whose category has no owner at all", () => {
    const plan = planAssignmentRepairs({
      items: [{ id: 1, categoryId: 4, cancelled: false }],
      assignments: [
        { id: 100, customerRfqItemId: 1, categoryId: 4, employeeId: 10, source: "auto" },
      ],
      categories: cats,
      owners,
    });
    expect(plan.repairs).toEqual([]);
    expect(plan.noOwner).toHaveLength(1);
  });

  it("skips cancelled items entirely", () => {
    const plan = planAssignmentRepairs({
      items: [{ id: 1, categoryId: 1, cancelled: true }],
      assignments: [
        { id: 100, customerRfqItemId: 1, categoryId: 4, employeeId: 30, source: "auto" },
      ],
      categories: cats,
      owners,
    });
    expect(plan.repairs).toEqual([]);
    expect(plan.noOwner).toEqual([]);
  });
});
