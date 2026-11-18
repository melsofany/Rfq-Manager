import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SupplierPicker } from "@/modules/rfq/components/SupplierPicker";

const categories = [
  { id: 1, name: "كهرباء", parentId: null },
  { id: 2, name: "كابلات", parentId: 1 },
  { id: 3, name: "مواسير", parentId: 1 },
  { id: 4, name: "أدوات", parentId: null },
];

const suppliers = [
  {
    id: 10,
    name: "مورد أ",
    category: "كابلات",
    isActive: true,
    contactPerson: null,
    email: "a@x.com",
    supplierId: null,
  },
  {
    id: 11,
    name: "مورد ب",
    category: "مواسير",
    isActive: true,
    contactPerson: null,
    email: "b@x.com",
    supplierId: null,
  },
  {
    id: 12,
    name: "مورد ج",
    category: "أدوات",
    isActive: true,
    contactPerson: null,
    email: null,
    supplierId: null,
  },
  {
    id: 13,
    name: "مورد د",
    category: "",
    isActive: true,
    contactPerson: null,
    email: null,
    supplierId: null,
  },
  {
    id: 14,
    name: "مورد هـ",
    category: "كابلات, أدوات",
    isActive: true,
    contactPerson: null,
    email: null,
    supplierId: null,
  },
] as never[];

function renderPicker(selected: number[], onChange = vi.fn()) {
  render(
    <SupplierPicker
      categories={categories as never[]}
      suppliers={suppliers}
      selectedIds={new Set(selected)}
      onChange={onChange}
      alreadySentIds={new Set()}
    />,
  );
  return onChange;
}

describe("SupplierPicker", () => {
  it("selecting a main category selects every supplier in its subtree", () => {
    const onChange = renderPicker([]);
    fireEvent.click(screen.getByRole("button", { name: "تحديد كهرباء" }));
    const next = onChange.mock.calls[0][0] as Set<number>;
    expect([...next].sort()).toEqual([10, 11, 14]);
  });

  it("selecting a subcategory affects only its own suppliers", () => {
    const onChange = renderPicker([]);
    fireEvent.click(screen.getByRole("button", { name: "تحديد كابلات" }));
    const next = onChange.mock.calls[0][0] as Set<number>;
    expect([...next].sort()).toEqual([10, 14]);
  });

  it("unselecting a fully selected category removes its suppliers and keeps others", () => {
    const onChange = renderPicker([10, 11, 14, 12]);
    fireEvent.click(screen.getByRole("button", { name: "تحديد كهرباء" }));
    const next = onChange.mock.calls[0][0] as Set<number>;
    expect([...next]).toEqual([12]);
  });

  it("union: suppliers from different main categories can be selected together", () => {
    const onChange = renderPicker([10]);
    fireEvent.click(screen.getByRole("button", { name: "تحديد أدوات" }));
    const next = onChange.mock.calls[0][0] as Set<number>;
    expect([...next].sort()).toEqual([10, 12, 14]);
  });

  it("shows unclassified suppliers under بدون تصنيف", () => {
    renderPicker([]);
    fireEvent.click(screen.getByText("بدون تصنيف"));
    expect(screen.getByText("مورد د")).toBeTruthy();
  });
});
