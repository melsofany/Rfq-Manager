import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  hrAttendanceDevicesTable: {},
  hrAttendancePunchesTable: {},
}));
vi.mock("../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { parseAttlogBody, handshakeConfig } from "../modules/hr/adms";

describe("ADMS ATTLOG parser", () => {
  it("parses tab-separated punches with CRLF line endings", () => {
    const body = "1\t2026-10-15 08:55:12\t0\t1\t0\t0\r\n2\t2026-10-15 17:03:40\t1\t1\t0\t0\r\n";
    expect(parseAttlogBody(body)).toEqual([
      { pin: "1", punchedAt: "2026-10-15 08:55:12", status: "0", verify: "1" },
      { pin: "2", punchedAt: "2026-10-15 17:03:40", status: "1", verify: "1" },
    ]);
  });

  it("skips blank and malformed lines without throwing", () => {
    const body = "\n\tnot-a-time\n3\t2026-13-99 25:00:00\t0\n4\t2026-10-15 09:00:00\n";
    expect(parseAttlogBody(body)).toEqual([
      { pin: "4", punchedAt: "2026-10-15 09:00:00", status: null, verify: null },
    ]);
  });

  it("rejects PINs with unsafe characters", () => {
    expect(parseAttlogBody("1'; DROP--\t2026-10-15 09:00:00\t0\t1")).toEqual([]);
  });

  it("returns an empty list for an empty body", () => {
    expect(parseAttlogBody("")).toEqual([]);
  });
});

describe("ADMS handshake config", () => {
  it("echoes the serial number and disables old-log resend", () => {
    const cfg = handshakeConfig("CKT1234");
    expect(cfg.startsWith("GET OPTION FROM: CKT1234")).toBe(true);
    expect(cfg).toContain("ATTLOGStamp=None");
    expect(cfg).toContain("Realtime=1");
  });

  it("advertises the push-protocol versions a K14 Pro firmware requires", () => {
    // Without these the newer firmware does not accept the endpoint as a real
    // ADMS server and never opens the real-time push channel.
    const cfg = handshakeConfig("CKT1234");
    expect(cfg).toContain("ServerVer=3.0.1");
    expect(cfg).toContain("PushProtVer=2.4.1");
    expect(cfg).toContain("SupportPing=1");
  });

  it("separates config lines with CRLF and ends with a blank line", () => {
    const cfg = handshakeConfig("CKT1234");
    expect(cfg.endsWith("\r\n")).toBe(true);
    expect(cfg).not.toMatch(/[^\r]\n/);
  });
});
