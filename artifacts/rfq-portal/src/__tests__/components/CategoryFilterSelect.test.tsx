import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CategoryFilterSelect } from "@/modules/users/pages/suppliers/CategoryFilterSelect";
import { LanguageProvider } from "@/contexts/LanguageContext";

const OPTIONS = [
  { id: 1, name: "كهرباء", parentId: null },
  { id: 2, name: "إضاءة", parentId: 1 },
  { id: 3, name: "سباكة", parentId: null },
];

// The component reads its own strings from the i18n dictionary now, so it needs
// the provider. The default language is English — the operator asked for BOTH.
function renderSelect(props: Partial<Parameters<typeof CategoryFilterSelect>[0]> = {}) {
  return render(
    <LanguageProvider>
      <CategoryFilterSelect
        label="التصنيف التجاري"
        options={OPTIONS}
        selectedLabel={null}
        onPick={vi.fn()}
        onClear={vi.fn()}
        {...props}
      />
    </LanguageProvider>,
  );
}

describe("CategoryFilterSelect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("shows the «all» label from the dictionary when nothing is selected", () => {
    renderSelect();
    expect(screen.getByText("التصنيف التجاري")).toBeInTheDocument();
    expect(screen.getByText("All")).toBeInTheDocument();
  });

  it("renders the whole catalogue as a compact dropdown, not a wall of chips", () => {
    renderSelect();
    // Closed: no option is in the DOM — that is the point of the change.
    expect(screen.queryByText("سباكة")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("التصنيف التجاري"));
    expect(screen.getByText("سباكة")).toBeInTheDocument();
    // A subcategory is indented under its parent, so the tree reads.
    expect(screen.getByText(/إضاءة/)).toBeInTheDocument();
  });

  it("picks an option and closes", () => {
    const onPick = vi.fn();
    renderSelect({ label: "يورّد بنود", onPick });
    fireEvent.click(screen.getByText("يورّد بنود"));
    fireEvent.click(screen.getByText("سباكة"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 3, name: "سباكة" }));
    expect(screen.queryByText("سباكة")).not.toBeInTheDocument();
  });

  it("filters the catalogue by the search box", () => {
    renderSelect();
    fireEvent.click(screen.getByText("التصنيف التجاري"));
    fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "سبا" } });
    expect(screen.getByText("سباكة")).toBeInTheDocument();
    expect(screen.queryByText("كهرباء")).not.toBeInTheDocument();
  });

  it("clears the selection through the inline X", () => {
    const onClear = vi.fn();
    renderSelect({ selectedLabel: "كهرباء", onClear });
    // The selected value is shown on the trigger.
    expect(screen.getByText("كهرباء")).toBeInTheDocument();
    const trigger = screen.getByText("التصنيف التجاري").closest("button")!;
    // The X is the only role=button inside the trigger.
    const x = trigger.querySelector('[role="button"]') as HTMLElement;
    fireEvent.click(x);
    expect(onClear).toHaveBeenCalled();
  });

  it("renders the same control in Arabic when the language is Arabic", () => {
    localStorage.setItem("rfq-lang", "ar");
    renderSelect();
    // «الكل» is the Arabic for the same key — proving the screen is bilingual.
    expect(screen.getByText("الكل")).toBeInTheDocument();
    expect(screen.queryByText("All")).not.toBeInTheDocument();
  });
});
