import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TradeCategoryPicker } from "@/modules/users/pages/suppliers/TradeCategoryPicker";

const options = [
  { id: 1, name: "كهرباء", parentId: null },
  { id: 2, name: "كابلات", parentId: 1 },
  { id: 3, name: "أدوات", parentId: null },
];

describe("TradeCategoryPicker", () => {
  it("shows the number of selected categories and a removable chip for each", () => {
    const onToggle = vi.fn();
    render(
      <TradeCategoryPicker options={options} selected={["كهرباء", "أدوات"]} onToggle={onToggle} />,
    );
    expect(screen.getByText("sup.pick.selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "أدوات" }));
    expect(onToggle).toHaveBeenCalledWith("أدوات");
  });

  it("toggles a category from the list and marks it selected", () => {
    const onToggle = vi.fn();
    render(<TradeCategoryPicker options={options} selected={[]} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("option", { name: "كابلات" }));
    expect(onToggle).toHaveBeenCalledWith("كابلات");
  });

  it("filters the list by the search box", () => {
    render(<TradeCategoryPicker options={options} selected={[]} onToggle={() => {}} />);
    fireEvent.change(screen.getByLabelText("sup.filter.search"), { target: { value: "أدو" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "أدوات" })).toBeTruthy();
  });
});
