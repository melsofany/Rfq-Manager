import { describe, it, expect } from "vitest";
import { checkHrCandidate } from "../modules/users/hr-candidate";

const base = { id: 1, fullName: "أحمد", status: "active", procurementEmployeeId: null };

describe("checkHrCandidate", () => {
  it("accepts an active, unlinked HR employee", () => {
    expect(checkHrCandidate(base)).toEqual({ ok: true });
  });
  it("rejects an unknown HR employee", () => {
    expect(checkHrCandidate(undefined)).toMatchObject({ ok: false, status: 400 });
  });
  it("rejects a resigned or terminated employee", () => {
    expect(checkHrCandidate({ ...base, status: "resigned" })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(checkHrCandidate({ ...base, status: "terminated" })).toMatchObject({
      ok: false,
      status: 400,
    });
  });
  it("rejects someone already linked to a procurement account", () => {
    expect(checkHrCandidate({ ...base, procurementEmployeeId: 7 })).toMatchObject({
      ok: false,
      status: 409,
    });
  });
});
