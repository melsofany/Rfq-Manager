/**
 * The operator's report: the delete refusal said «ألغِ بنوده بدلًا من الحذف» for
 * EVERY blocker. Cancelling items does not clear a customer PO, a supplier RFQ
 * or an invoice — the RESTRICT constraint refuses the delete however many items
 * are cancelled — so the operator did exactly what the message asked and was
 * refused again (`/customer-rfq/5647`).
 *
 * These render the REAL component, so the guard fails if the remedy stops being
 * shown or the reason is shown alone.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActionErrorBlock } from "../modules/customer-rfq/components/ActionErrorBlock";

const PO_BLOCKER = {
  code: "customer_po",
  reason: "أمر شراء عميل مرتبط",
  action: "احذف أمر شراء العميل المرتبط أولًا",
  where: "أوامر شراء العملاء",
};

describe("a refused action shows the remedy, not only the reason", () => {
  it("shows the action beside the reason", () => {
    render(<ActionErrorBlock error="محجوب" blockers={[PO_BLOCKER]} testId="delete-error" />);
    const text = screen.getByTestId("delete-error-blockers").textContent ?? "";
    expect(text).toContain("أمر شراء عميل مرتبط");
    expect(text).toContain("احذف أمر شراء العميل المرتبط أولًا");
  });

  it("names the screen where the remedy is performed", () => {
    render(<ActionErrorBlock error="محجوب" blockers={[PO_BLOCKER]} testId="delete-error" />);
    expect(screen.getByTestId("delete-error-blockers").textContent).toContain("أوامر شراء العملاء");
  });

  it("lists EVERY blocker with its own action, not one blanket instruction", () => {
    render(
      <ActionErrorBlock
        error="محجوب"
        testId="delete-error"
        blockers={[
          PO_BLOCKER,
          {
            code: "supplier_rfq",
            reason: "طلب تسعير مُرسل لموردين",
            action: "احذف طلب التسعير المُرسل للموردين أولًا",
            where: "طلبات التسعير",
          },
        ]}
      />,
    );
    const items = screen.getByTestId("delete-error-blockers").querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("احذف أمر شراء العميل");
    expect(items[1].textContent).toContain("احذف طلب التسعير المُرسل للموردين");
  });

  it("never shows the blanket «ألغِ بنوده» for a blocker it cannot clear", () => {
    render(<ActionErrorBlock error="محجوب" blockers={[PO_BLOCKER]} testId="delete-error" />);
    expect(screen.getByTestId("delete-error").textContent).not.toContain("ألغِ بنوده");
  });

  it("warns that unassigning alone does not clear the frozen achievement", () => {
    render(
      <ActionErrorBlock
        error="محجوب"
        testId="delete-error"
        blockers={[
          {
            code: "attribution",
            reason: "تاريخ إنجاز مُثبَّت لبند",
            action:
              "ألغِ البنود المنجزة (إلغاء الإسناد وحده لا يكفي — الإنجاز مُثبَّت عند أول أمر شراء)",
          },
        ]}
      />,
    );
    expect(screen.getByTestId("delete-error-blockers").textContent).toContain(
      "إلغاء الإسناد وحده لا يكفي",
    );
  });

  it("renders the reason alone when the server sent no remedy (a plain error)", () => {
    render(<ActionErrorBlock error="تعذّر الحذف" testId="delete-error" />);
    expect(screen.getByTestId("delete-error").textContent).toContain("تعذّر الحذف");
    expect(screen.queryByTestId("delete-error-blockers")).toBeNull();
  });
});
