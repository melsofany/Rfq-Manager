import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CategoryFilterSelect } from "@/modules/users/pages/suppliers/CategoryFilterSelect";

const OPTIONS = [
  { id: 1, name: "كهرباء", parentId: null },
  { id: 2, name: "إضاءة", parentId: 1 },
  { id: 3, name: "سباكة", parentId: null },
];

describe("CategoryFilterSelect", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows «الكل» when nothing is selected, and the label always", () => {
    render(
      <CategoryFilterSelect
        label="التصنيف التجاري"
        options={OPTIONS}
        selectedLabel={null}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.getByText("التصنيف التجاري")).toBeInTheDocument();
    expect(screen.getByText("الكل")).toBeInTheDocument();
  });

  it("renders the whole catalogue as a compact dropdown, not a wall of chips", () => {
    render(
      <CategoryFilterSelect
        label="التصنيف التجاري"
        options={OPTIONS}
        selectedLabel={null}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    // Closed: no option is in the DOM — that is the point of the change.
    expect(screen.queryByText("سباكة")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("التصنيف التجاري"));
    expect(screen.getByText("سباكة")).toBeInTheDocument();
    // A subcategory is indented under its parent, so the tree reads.
    expect(screen.getByText(/إضاءة/)).toBeInTheDocument();
  });

  it("picks an option and closes", () => {
    const onPick = vi.fn();
    render(
      <CategoryFilterSelect
        label="يورّد بنود"
        options={OPTIONS}
        selectedLabel={null}
        onPick={onPick}
        onClear={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("يورّد بنود"));
    fireEvent.click(screen.getByText("سباكة"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 3, name: "سباكة" }));
    expect(screen.queryByText("سباكة")).not.toBeInTheDocument();
  });

  it("filters the catalogue by the search box", () => {
    render(
      <CategoryFilterSelect
        label="التصنيف التجاري"
        options={OPTIONS}
        selectedLabel={null}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("التصنيف التجاري"));
    fireEvent.change(screen.getByPlaceholderText("بحث..."), { target: { value: "سبا" } });
    expect(screen.getByText("سباكة")).toBeInTheDocument();
    expect(screen.queryByText("كهرباء")).not.toBeInTheDocument();
  });

  it("clears the selection through the inline X", () => {
    const onClear = vi.fn();
    render(
      <CategoryFilterSelect
        label="التصنيف التجاري"
        options={OPTIONS}
        selectedLabel="كهرباء"
        onPick={vi.fn()}
        onClear={onClear}
      />,
    );
    // The selected value is shown on the trigger.
    expect(screen.getByText("كهرباء")).toBeInTheDocument();
    const trigger = screen.getByText("التصنيف التجاري").closest("button")!;
    // The X is the only role=button inside the trigger.
    const x = trigger.querySelector('[role="button"]') as HTMLElement;
    fireEvent.click(x);
    expect(onClear).toHaveBeenCalled();
  });
});
