import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  ItemTags,
  StatusBadge,
  strongestEvidence,
  type ItemCategoryRef,
  type SupplierRow,
} from "@/modules/users/pages/suppliers/list/supplier-display";
import { SupplierTable } from "@/modules/users/pages/suppliers/list/supplier-table";

const t = (k: string) => k;

describe("strongestEvidence", () => {
  it("prefers a purchase order over a quote over a manual link", () => {
    expect(strongestEvidence({ id: 1, name: "a", ordered: true, quoted: true, manual: true })).toBe(
      "ordered",
    );
    expect(strongestEvidence({ id: 1, name: "a", quoted: true, manual: true })).toBe("quoted");
    expect(strongestEvidence({ id: 1, name: "a", manual: true })).toBe("manual");
    expect(strongestEvidence({ id: 1, name: "a" })).toBeNull();
  });
});

describe("ItemTags", () => {
  it("folds categories beyond two into a +N counter", () => {
    const cats: ItemCategoryRef[] = [
      { id: 1, name: "كابلات" },
      { id: 2, name: "شنايدر" },
      { id: 3, name: "مفاتيح" },
      { id: 4, name: "لمبات" },
    ];
    render(<ItemTags cats={cats} t={t} />);
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.getByText("كابلات")).toBeTruthy();
    expect(screen.queryByText("مفاتيح")).toBeNull();
  });

  it("lists the strongest evidence first", () => {
    const cats: ItemCategoryRef[] = [
      { id: 1, name: "يدوي", manual: true },
      { id: 2, name: "مُسعَّر", quoted: true },
      { id: 3, name: "أمر", ordered: true },
    ];
    const { container } = render(<ItemTags cats={cats} t={t} />);
    const order = Array.from(container.querySelectorAll("span[title]")).map((el) =>
      el.textContent?.trim(),
    );
    // Only two chips show, so the weakest evidence (manual) is the one folded away.
    expect(order).toEqual(["أمر", "مُسعَّر", "+1"]);
  });

  it("shows the not-set label when a supplier has no item categories", () => {
    render(<ItemTags cats={[]} t={t} />);
    expect(screen.getByText("sup.notSet")).toBeTruthy();
  });
});

describe("StatusBadge", () => {
  it("shows the VAT note only when the supplier invoices without VAT", () => {
    const base: SupplierRow = { id: 1, name: "x", isActive: true, invoiceHasVat: true };
    const { rerender } = render(<StatusBadge supplier={base} t={t} />);
    expect(screen.queryByText("sup.noVat")).toBeNull();
    rerender(<StatusBadge supplier={{ ...base, invoiceHasVat: false }} t={t} />);
    expect(screen.getByText("sup.noVat")).toBeTruthy();
  });
});

describe("SupplierTable", () => {
  it("opens the supplier on row click and on Enter", () => {
    const onOpen = vi.fn();
    const rows: SupplierRow[] = [{ id: 7, name: "مورد", isActive: true }];
    render(<SupplierTable t={t} suppliers={rows} onOpen={onOpen} />);
    const row = screen.getByRole("link", { name: "مورد" });
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledWith(7);
  });
});
