/**
 * The operator's complaint: sending a quotation request for a customer number
 * that was ALREADY sent created a second RFQ, scattering the offers so the
 * comparison could not be read. The form now warns and points at the row that
 * already holds the work.
 *
 * This renders the REAL banner component (not a source grep), so the guard
 * fails if the element stops rendering or stops naming the row.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExistingRfqBanner } from "../modules/rfq/components/ExistingRfqBanner";

// The REAL wouter Link is used on purpose: it renders the anchor, so asserting
// the href proves the component routes to the existing row (a mocked Link could
// pass while the real one rendered nothing).
vi.mock("wouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wouter")>();
  return { ...actual, useLocation: () => ["/rfq/new", () => {}] };
});

const EXISTING = {
  id: 121,
  internalRfqNo: "CRQ-2026-000075",
  status: "QUOTED",
  itemCount: 3,
  duplicates: 1,
};

describe("ExistingRfqBanner", () => {
  it("names the RFQ that already holds the work and its item count", () => {
    render(<ExistingRfqBanner existing={EXISTING} customerRfqNo="26R007225" />);
    const text = screen.getByTestId("existing-rfq-banner").textContent ?? "";
    // The row must be NAMED, or the operator cannot open it.
    expect(text).toContain("CRQ-2026-000075");
    expect(text).toContain("26R007225");
    expect(text).toContain("يوجد طلب تسعير");
    expect(text).toContain("3 بند");
  });

  it("links to the existing RFQ, not to a new form", () => {
    render(<ExistingRfqBanner existing={EXISTING} customerRfqNo="26R007225" />);
    const link = screen.getByText("فتح الطلب القائم").closest("a");
    expect(link?.getAttribute("href")).toBe("/rfq/121");
  });

  it("mentions how many duplicate rows exist when the history split", () => {
    // Measured production case 26R007225 had 5 rows — the operator should see
    // that the scatter already happened, not just that a row exists.
    render(
      <ExistingRfqBanner existing={{ ...EXISTING, duplicates: 5 }} customerRfqNo="26R007225" />,
    );
    expect(screen.getByTestId("existing-rfq-banner").textContent).toContain("5 طلبات مكررة");
  });

  it("does not claim duplicates when there is only one row", () => {
    render(<ExistingRfqBanner existing={EXISTING} customerRfqNo="26R007225" />);
    expect(screen.getByTestId("existing-rfq-banner").textContent).not.toContain("مكررة");
  });
});
