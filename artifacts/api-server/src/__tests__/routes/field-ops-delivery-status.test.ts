import { describe, it, expect } from "vitest";
import {
  computePoDeliveryStatus,
  isOutstandingDeliveryLine,
  lineRemaining,
  PO_DELIVERY_STATUS_LABEL,
  type DeliveryLineState,
} from "../../modules/field-ops/delivery-status";

function line(over: Partial<DeliveryLineState> = {}): DeliveryLineState {
  return { orderedQty: 10, deliveredQty: 0, rejectedQty: 0, acceptedFromSupplier: 10, ...over };
}

describe("lineRemaining", () => {
  it("counts both delivered and rejected units as settled", () => {
    expect(lineRemaining(line({ deliveredQty: 4, rejectedQty: 3 }))).toBe(3);
  });
  it("uses the supplier-accepted quantity as the ceiling", () => {
    expect(lineRemaining(line({ acceptedFromSupplier: 6, deliveredQty: 6 }))).toBe(0);
  });
  it("falls back to the ordered quantity when there is no supplier link", () => {
    expect(lineRemaining(line({ acceptedFromSupplier: null, deliveredQty: 10 }))).toBe(0);
  });
  it("never goes below zero", () => {
    expect(lineRemaining(line({ deliveredQty: 20 }))).toBe(0);
  });
});

describe("isOutstandingDeliveryLine", () => {
  it("is outstanding when there is quantity to hand over", () => {
    expect(isOutstandingDeliveryLine({ availableQty: 3 })).toBe(true);
  });
  it("is outstanding while waiting for the supplier receipt", () => {
    expect(isOutstandingDeliveryLine({ availableQty: 0, awaitingSupplierReceipt: true })).toBe(
      true,
    );
  });
  it("is not outstanding once settled", () => {
    expect(isOutstandingDeliveryLine({ availableQty: 0, awaitingSupplierReceipt: false })).toBe(
      false,
    );
  });
});

describe("computePoDeliveryStatus", () => {
  it("is completed when every line is fully delivered", () => {
    expect(
      computePoDeliveryStatus([
        line({ deliveredQty: 10 }),
        line({ orderedQty: 5, deliveredQty: 5, acceptedFromSupplier: 5 }),
      ]),
    ).toBe("completed");
  });

  it("is in_progress while a line still has quantity to settle", () => {
    expect(computePoDeliveryStatus([line({ deliveredQty: 10 }), line({ deliveredQty: 3 })])).toBe(
      "in_progress",
    );
  });

  it("is fully_rejected when every line is settled and none was delivered", () => {
    expect(
      computePoDeliveryStatus([
        line({ rejectedQty: 10 }),
        line({ orderedQty: 5, rejectedQty: 5, acceptedFromSupplier: 5 }),
      ]),
    ).toBe("fully_rejected");
  });

  it("stays in_progress when delivered and rejected lines are mixed", () => {
    // One line delivered, the other only PARTLY rejected — still outstanding.
    expect(computePoDeliveryStatus([line({ deliveredQty: 10 }), line({ rejectedQty: 3 })])).toBe(
      "in_progress",
    );
  });

  it("settles a line that was partly delivered and partly rejected", () => {
    // Delivered 6, rejected 4 of 10 — nothing left, so the order is complete.
    expect(computePoDeliveryStatus([line({ deliveredQty: 6, rejectedQty: 4 })])).toBe("completed");
  });

  it("treats a delivered-plus-rejected line as settled", () => {
    expect(computePoDeliveryStatus([line({ deliveredQty: 7, rejectedQty: 3 })])).toBe("completed");
  });

  it("keeps an unreceived supplier line outstanding (not settled)", () => {
    // Supplier PO issued but nothing received yet: the whole ordered qty is
    // still to come, so the line must not read as settled.
    expect(lineRemaining(line({ acceptedFromSupplier: 0, awaitingSupplierReceipt: true }))).toBe(
      10,
    );
    expect(
      computePoDeliveryStatus([line({ acceptedFromSupplier: 0, awaitingSupplierReceipt: true })]),
    ).toBe("in_progress");
  });

  it("does not call a wholly-unreceived order fully rejected", () => {
    expect(
      computePoDeliveryStatus([
        line({ acceptedFromSupplier: 0, awaitingSupplierReceipt: true }),
        line({ orderedQty: 4, acceptedFromSupplier: 0, awaitingSupplierReceipt: true }),
      ]),
    ).toBe("in_progress");
  });

  it("settles an awaiting line once it is received and delivered", () => {
    expect(
      computePoDeliveryStatus([
        line({ acceptedFromSupplier: 10, deliveredQty: 10, awaitingSupplierReceipt: false }),
      ]),
    ).toBe("completed");
  });

  it("has a human label for every status", () => {
    expect(PO_DELIVERY_STATUS_LABEL.completed).toBe("مكتمل التسليم");
    expect(PO_DELIVERY_STATUS_LABEL.in_progress).toBe("تحت التسليم");
    expect(PO_DELIVERY_STATUS_LABEL.fully_rejected).toBe("مرفوض بالكامل");
  });
});
