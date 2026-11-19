import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
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

  it("clicking a category shows only its suppliers on the right", () => {
    renderPicker([]);
    fireEvent.click(screen.getByRole("button", { name: "كابلات" }));
    expect(screen.getByText("مورد أ")).toBeTruthy();
    expect(screen.queryByText("مورد ب")).toBeNull();
    expect(screen.queryByText("مورد ج")).toBeNull();
  });

  it("a second category stacks below the first, and both stay visible", () => {
    renderPicker([]);
    fireEvent.click(screen.getByRole("button", { name: "كابلات" }));
    fireEvent.click(screen.getByRole("button", { name: "مواسير" }));
    expect(screen.getByText("مورد أ")).toBeTruthy();
    expect(screen.getByText("مورد ب")).toBeTruthy();
    const headers = screen
      .getAllByRole("button", { name: /^إغلاق / })
      .map((b) => b.getAttribute("aria-label"));
    expect(headers).toEqual(["إغلاق كابلات", "إغلاق مواسير"]);
  });

  it("select-all inside a section selects only that section's suppliers", () => {
    const onChange = renderPicker([]);
    fireEvent.click(screen.getByRole("button", { name: "كابلات" }));
    fireEvent.click(screen.getByRole("button", { name: "تحديد الكل في كابلات" }));
    const next = onChange.mock.calls[0][0] as Set<number>;
    expect([...next].sort()).toEqual([10, 14]);
  });

  it("collapsing a section hides its suppliers and keeps the header", () => {
    renderPicker([]);
    fireEvent.click(screen.getByRole("button", { name: "كابلات" }));
    fireEvent.click(screen.getByRole("button", { name: "طي كابلات" }));
    expect(screen.queryByText("مورد أ")).toBeNull();
    expect(screen.getByRole("button", { name: "توسيع كابلات" })).toBeTruthy();
  });

  it("closing a section removes it from the right panel", () => {
    renderPicker([]);
    fireEvent.click(screen.getByRole("button", { name: "كابلات" }));
    fireEvent.click(screen.getByRole("button", { name: "إغلاق كابلات" }));
    expect(screen.queryByText("مورد أ")).toBeNull();
    expect(screen.getByText("اختر تصنيفاً من القائمة لعرض موردييه هنا")).toBeTruthy();
  });

  it("search filters the suppliers inside every open section", () => {
    renderPicker([]);
    fireEvent.click(screen.getByRole("button", { name: "كابلات" }));
    fireEvent.click(screen.getByRole("button", { name: "أدوات" }));
    fireEvent.change(screen.getByPlaceholderText("بحث..."), { target: { value: "مورد ج" } });
    expect(screen.getByText("مورد ج")).toBeTruthy();
    expect(screen.queryByText("مورد أ")).toBeNull();
    expect(screen.queryByRole("button", { name: "إغلاق كابلات" })).toBeNull();
  });

  it("opening a main category does not list its subcategories' suppliers", () => {
    renderPicker([]);
    fireEvent.click(screen.getByRole("button", { name: "كهرباء" }));
    expect(screen.queryByText("مورد أ")).toBeNull();
    expect(screen.queryByText("مورد ب")).toBeNull();
    expect(screen.queryByText("مورد هـ")).toBeNull();
    expect(
      screen.getByText(
        "لا يوجد موردون مرتبطون بهذا التصنيف مباشرة، اختر تصنيفاً فرعياً من القائمة",
      ),
    ).toBeTruthy();
  });

  it("a subcategory opened after its main shows only its own suppliers", () => {
    renderPicker([]);
    fireEvent.click(screen.getByRole("button", { name: "كهرباء" }));
    fireEvent.click(screen.getByRole("button", { name: "مواسير" }));
    expect(screen.getByText("مورد ب")).toBeTruthy();
    expect(screen.queryByText("مورد أ")).toBeNull();
    expect(screen.queryByText("مورد هـ")).toBeNull();
  });

  it("a supplier tagged with the main category directly is listed under it", () => {
    const direct = [
      ...suppliers,
      {
        id: 15,
        name: "مورد كهرباء مباشر",
        category: "كهرباء",
        isActive: true,
        contactPerson: null,
        email: null,
        supplierId: null,
      },
    ] as never[];
    render(
      <SupplierPicker
        categories={categories as never[]}
        suppliers={direct}
        selectedIds={new Set()}
        onChange={vi.fn()}
        alreadySentIds={new Set()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "كهرباء" }));
    expect(screen.getByText("مورد كهرباء مباشر")).toBeTruthy();
    expect(screen.queryByText("مورد أ")).toBeNull();
  });
});
