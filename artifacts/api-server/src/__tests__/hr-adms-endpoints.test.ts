import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { readFileSync } from "fs";
import path from "path";

const H = vi.hoisted(() => {
  const DEVICES = { __t: "devices" };
  const PUNCHES = { __t: "punches" };
  const state = {
    active: new Set<string>(),
    deviceUpserts: [] as Record<string, unknown>[],
    punchRows: [] as Record<string, unknown>[],
  };
  return { DEVICES, PUNCHES, state };
});

vi.mock("@workspace/db", () => ({
  db: {
    insert: () => ({
      values: (vals: unknown) => ({
        onConflictDoUpdate: async () => {
          H.state.deviceUpserts.push(vals as Record<string, unknown>);
          return { ok: true };
        },
        onConflictDoNothing: async () => {
          H.state.punchRows.push(
            ...((Array.isArray(vals) ? vals : [vals]) as Record<string, unknown>[]),
          );
          return { ok: true };
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: (cond: { __eqValue?: unknown }) => ({
          limit: async () => [{ isActive: H.state.active.has(String(cond?.__eqValue ?? "")) }],
        }),
      }),
    }),
  },
  hrAttendanceDevicesTable: H.DEVICES,
  hrAttendancePunchesTable: H.PUNCHES,
}));

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, value: unknown) => ({ __eqValue: value }),
}));

vi.mock("../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import admsRouter from "../modules/hr/adms";

const app = express();
app.use(admsRouter);

beforeEach(() => {
  H.state.active.clear();
  H.state.deviceUpserts.length = 0;
  H.state.punchRows.length = 0;
});

describe("ADMS liveness + registry endpoints", () => {
  it("answers the legacy ping probe", async () => {
    const res = await request(app).get("/iclock/ping?SN=K14PRO001");
    expect(res.status).toBe(200);
    expect(res.text).toBe("OK");
  });

  it("acknowledges a device registry announcement (GET and POST)", async () => {
    expect((await request(app).get("/iclock/registry?SN=K14PRO001")).text).toBe("OK");
    const post = await request(app)
      .post("/iclock/registry?SN=K14PRO001")
      .set("Content-Type", "text/plain")
      .send("DeviceName=K14 Pro,UserCount=12");
    expect(post.status).toBe(200);
    expect(post.text).toBe("OK");
  });

  it("accepts the serial number from the SN header as well as the query", async () => {
    const res = await request(app).get("/iclock/ping").set("SN", "K14PRO002");
    expect(res.status).toBe(200);
    expect(res.text).toBe("OK");
  });

  it("rejects a request with no serial number at all", async () => {
    const res = await request(app).get("/iclock/ping");
    expect(res.status).toBe(400);
    expect(res.text).toBe("BAD SN");
  });
});

describe("ADMS post-handshake pushes", () => {
  it("acknowledges an OPTIONS push without storing it", async () => {
    const res = await request(app)
      .post("/iclock/cdata?SN=K14PRO001&table=OPTIONS")
      .set("Content-Type", "text/plain")
      .send("GET OPTION FROM: K14PRO001");
    expect(res.status).toBe(200);
    expect(res.text).toBe("OK");
    expect(H.state.punchRows).toHaveLength(0);
  });

  it("acknowledges an OPERLOG push without storing it", async () => {
    const res = await request(app)
      .post("/iclock/cdata?SN=K14PRO001&table=OPERLOG")
      .set("Content-Type", "text/plain")
      .send("1\t2026-10-15 09:00:00\t0\t0\t0");
    expect(res.status).toBe(200);
    expect(res.text).toBe("OK");
    expect(H.state.punchRows).toHaveLength(0);
  });

  it("ACKS an ATTLOG from a still-inactive device instead of forcing a retry loop", async () => {
    // The device is registered (it now appears on /hr) but an operator has not
    // activated it. Returning non-OK here makes the firmware re-send the same
    // batch forever, so the punches are dropped but the upload is confirmed.
    const res = await request(app)
      .post("/iclock/cdata?SN=K14PRO001&table=ATTLOG")
      .set("Content-Type", "text/plain")
      .send("7\t2026-10-15 08:55:12\t0\t1\t0\t0\r\n");
    expect(res.status).toBe(200);
    expect(res.text).toBe("OK");
    expect(H.state.punchRows).toHaveLength(0);
    expect(H.state.deviceUpserts.map((u) => u.sn)).toContain("K14PRO001");
  });

  it("stores punches for an activated device, parsing tabs and dropping junk", async () => {
    H.state.active.add("K14PRO001");
    const res = await request(app)
      .post("/iclock/cdata?SN=K14PRO001&table=ATTLOG")
      .set("Content-Type", "text/plain")
      .send("7\t2026-10-15 08:55:12\t0\t1\t0\t0\r\n9\tnot-a-time\t0\r\n");
    expect(res.status).toBe(200);
    expect(res.text).toBe("OK");
    expect(H.state.punchRows).toEqual([
      {
        deviceSn: "K14PRO001",
        pin: "7",
        punchedAt: "2026-10-15 08:55:12",
        status: "0",
        verify: "1",
      },
    ]);
  });

  it("parses the body when the firmware labels it application/octet-stream", async () => {
    H.state.active.add("K14PRO001");
    const res = await request(app)
      .post("/iclock/cdata?SN=K14PRO001&table=ATTLOG")
      .set("Content-Type", "application/octet-stream")
      .send("7\t2026-10-15 08:55:12\t0\t1\t0\t0\r\n");
    expect(res.text).toBe("OK");
    expect(H.state.punchRows).toHaveLength(1);
  });
});

describe("ADMS handshake", () => {
  it("returns the config block with the push-protocol versions", async () => {
    const res = await request(app).get("/iclock/cdata?SN=K14PRO001&options=all");
    expect(res.status).toBe(200);
    expect(res.text).toContain("GET OPTION FROM: K14PRO001");
    expect(res.text).toContain("ServerVer=3.0.1");
    expect(res.text).toContain("PushProtVer=2.4.1");
    expect(res.text).toContain("SupportPing=1");
  });
});

describe("ADMS shared-key gate", () => {
  it("stays open when ADMS_DEVICE_KEY is not configured", async () => {
    delete process.env.ADMS_DEVICE_KEY;
    const res = await request(app).get("/iclock/ping?SN=K14PRO001");
    expect(res.status).toBe(200);
  });

  it("refuses a request whose key does not match", async () => {
    process.env.ADMS_DEVICE_KEY = "s3cret";
    const res = await request(app).get("/iclock/ping?SN=K14PRO001&key=wrong");
    expect(res.status).toBe(401);
    expect(res.text).toBe("UNAUTHORIZED");
    delete process.env.ADMS_DEVICE_KEY;
  });

  it("accepts the correct key", async () => {
    process.env.ADMS_DEVICE_KEY = "s3cret";
    const res = await request(app).get("/iclock/ping?SN=K14PRO001&key=s3cret");
    expect(res.status).toBe(200);
    delete process.env.ADMS_DEVICE_KEY;
  });
});

describe("ADMS mount point", () => {
  it("is mounted at the ROOT, before the SPA fallback", () => {
    // A device calls `/iclock/...` with no `/api` prefix. If the router is only
    // mounted under `/api`, the request falls through to the SPA catch-all and
    // the device receives HTML instead of its handshake config.
    const src = readFileSync(path.resolve(__dirname, "../app.ts"), "utf8");
    const mount = src.indexOf("app.use(admsRouter)");
    expect(mount).toBeGreaterThan(-1);
    const spaFallback = src.indexOf("app.get(/.*/");
    expect(spaFallback).toBeGreaterThan(-1);
    expect(mount).toBeLessThan(spaFallback);
  });
});
