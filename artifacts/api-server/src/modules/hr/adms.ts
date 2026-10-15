/**
 * ZKTeco ADMS / push endpoints — استقبال البصمات من جهاز الحضور.
 *
 * The device connects OUT to this server (no inbound port needed on the office
 * network). Mounted under /api, so the device's server path is `/api/iclock/...`.
 *
 *   GET  /api/iclock/cdata?SN=…            handshake → config lines
 *   POST /api/iclock/cdata?SN=…&table=ATTLOG  punch records (tab-separated lines)
 *   GET  /api/iclock/getrequest?SN=…       heartbeat → "OK"
 *   POST /api/iclock/devicecmd?SN=…        command results → "OK"
 *
 * Authorization: the device has no login, so its serial number (SN) is the key.
 * Unknown SNs are stored as INACTIVE and their punches are dropped until an
 * admin activates them on the HR page.
 */
import express, { Router, type IRouter, type Request, type Response } from "express";
import { db, hrAttendanceDevicesTable, hrAttendancePunchesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../shared/logger";

export interface ParsedPunch {
  pin: string;
  punchedAt: string;
  status: string | null;
  verify: string | null;
}

const TS_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
const PIN_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Rejects e.g. 2026-02-31 that the regex alone would let through. */
function isRealDate(ymd: string): boolean {
  const d = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
}

/**
 * Parse an ATTLOG body: one punch per line, tab-separated
 * `PIN<TAB>YYYY-MM-DD HH:MM:SS<TAB>status<TAB>verify<TAB>…`.
 * Malformed lines are skipped (never throw — the device would retry forever).
 */
export function parseAttlogBody(body: string): ParsedPunch[] {
  const out: ParsedPunch[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split("\t");
    const pin = (parts[0] ?? "").trim();
    const punchedAt = (parts[1] ?? "").trim();
    if (!PIN_RE.test(pin) || !TS_RE.test(punchedAt)) continue;
    if (!isRealDate(punchedAt.slice(0, 10))) continue;
    out.push({
      pin,
      punchedAt,
      status: parts[2]?.trim() || null,
      verify: parts[3]?.trim() || null,
    });
  }
  return out;
}

/** Config the device expects after handshake. Stamps "None" = no resend of old logs. */
export function handshakeConfig(sn: string): string {
  return [
    `GET OPTION FROM: ${sn}`,
    "ATTLOGStamp=None",
    "OPERLOGStamp=None",
    "ATTPHOTOStamp=None",
    "ErrorDelay=60",
    "Delay=10",
    "TransTimes=00:00;14:05",
    "TransInterval=1",
    "TransFlag=1000000000",
    "Realtime=1",
    "Encrypt=None",
    "",
  ].join("\r\n");
}

async function touchDevice(sn: string): Promise<boolean> {
  await db
    .insert(hrAttendanceDevicesTable)
    .values({ sn, isActive: false, lastSeenAt: new Date() })
    .onConflictDoUpdate({
      target: hrAttendanceDevicesTable.sn,
      set: { lastSeenAt: new Date() },
    });
  const [row] = await db
    .select({ isActive: hrAttendanceDevicesTable.isActive })
    .from(hrAttendanceDevicesTable)
    .where(eq(hrAttendanceDevicesTable.sn, sn))
    .limit(1);
  return Boolean(row?.isActive);
}

function snOf(req: Request): string | null {
  const sn = String(req.query.SN ?? req.query.sn ?? "").trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(sn) ? sn : null;
}

const router: IRouter = Router();

router.get("/iclock/cdata", async (req: Request, res: Response): Promise<void> => {
  const sn = snOf(req);
  if (!sn) {
    res.status(400).type("text/plain").send("BAD SN");
    return;
  }
  try {
    await touchDevice(sn);
    res.type("text/plain").send(handshakeConfig(sn));
  } catch (err) {
    logger.error({ err, sn }, "adms: handshake failed");
    res.status(500).type("text/plain").send("ERROR");
  }
});

router.post(
  "/iclock/cdata",
  express.text({ type: () => true, limit: "5mb" }),
  async (req: Request, res: Response): Promise<void> => {
    const sn = snOf(req);
    if (!sn) {
      res.status(400).type("text/plain").send("BAD SN");
      return;
    }
    const table = String(req.query.table ?? "").toUpperCase();
    try {
      const active = await touchDevice(sn);
      if (table === "ATTLOG" && active) {
        const body = typeof req.body === "string" ? req.body : "";
        const punches = parseAttlogBody(body);
        if (punches.length) {
          await db
            .insert(hrAttendancePunchesTable)
            .values(
              punches.map((p) => ({
                deviceSn: sn,
                pin: p.pin,
                punchedAt: p.punchedAt,
                status: p.status,
                verify: p.verify,
              })),
            )
            .onConflictDoNothing();
        }
        logger.info({ sn, received: punches.length }, "adms: attlog stored");
      } else if (table === "ATTLOG") {
        logger.warn({ sn }, "adms: attlog from inactive device dropped");
      }
      res.type("text/plain").send("OK");
    } catch (err) {
      logger.error({ err, sn, table }, "adms: push failed");
      // Non-OK makes the device retry later, so punches are not lost.
      res.status(500).type("text/plain").send("ERROR");
    }
  },
);

router.get("/iclock/getrequest", async (req: Request, res: Response): Promise<void> => {
  const sn = snOf(req);
  if (sn) await touchDevice(sn).catch(() => undefined);
  res.type("text/plain").send("OK");
});

router.post(
  "/iclock/devicecmd",
  express.text({ type: () => true, limit: "1mb" }),
  (_req: Request, res: Response): void => {
    res.type("text/plain").send("OK");
  },
);

export default router;
