/**
 * ZKTeco ADMS / push endpoints — استقبال البصمات من جهاز الحضور.
 *
 * The device connects OUT to this server (no inbound port needed on the office
 * network). Mounted at the ROOT as `/iclock/...` because that path is
 * hard-coded in ZKTeco firmware — a device never sends an `/api` prefix. The
 * same router is also reachable under `/api/iclock/...` for manual testing.
 *
 *   GET  /iclock/cdata?SN=…&options=all   handshake → config lines
 *   POST /iclock/cdata?SN=…&table=ATTLOG  punch records (tab-separated lines)
 *   GET  /iclock/getrequest?SN=…          heartbeat → "OK"
 *   POST /iclock/devicecmd?SN=…           command results → "OK"
 *   GET  /iclock/ping?SN=…                legacy liveness probe → "OK"
 *   GET|POST /iclock/registry?SN=…        device registration → "OK"
 *
 * Authorization: the device has no login, so its serial number (SN) is the key.
 * Unknown SNs are stored as INACTIVE and their punches are dropped until an
 * admin activates them on the HR page. Optionally the firmware can be told to
 * authenticate with a shared key — see `ADMS_DEVICE_KEY`.
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
const SN_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

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

/**
 * Offset of Africa/Cairo from UTC, in minutes, at the given moment.
 * Derived from the IANA zone so DST changes are picked up automatically
 * (UTC+2 in winter, UTC+3 during Egypt's summer DST).
 */
export function cairoOffsetMinutes(at: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const cairoAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  const utcMs = Math.floor(at.getTime() / 1000) * 1000;
  return Math.round((cairoAsUtc - utcMs) / 60_000);
}

/**
 * Config the device expects after handshake.
 *
 * The `*Stamp` values are the high-water marks of what we already hold. This
 * server accepts duplicates (a unique index on `(device_sn, pin, punched_at)`
 * makes a re-send a no-op), so we deliberately ask for the FULL history with
 * `Stamp=None` rather than risk a lost window if a stamp is mis-parsed.
 *
 * `ServerVer`/`PushProtVer`/`SupportPing` are what newer firmware (the K14 Pro
 * generation) looks for to accept the server as a real ADMS endpoint and to
 * enable the `/iclock/ping` liveness probe. Older firmware ignores them.
 *
 * `TimeZone` is the offset in minutes east of UTC. Without it the firmware
 * falls back to its factory default (GMT+8) on every reconnect, so the device
 * clock drifts by 8 hours no matter what the operator sets locally.
 */
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
    `TimeZone=${cairoOffsetMinutes()}`,
    "ServerVer=3.0.1",
    "PushProtVer=2.4.1",
    "SupportPing=1",
    "",
  ].join("\r\n");
}

/**
 * The serial number the device identifies itself with. Firmware variants send
 * it as the `SN` query parameter, others (and some proxies) as an `SN`/`sn`
 * header, so accept either.
 */
export function snOf(req: Request): string | null {
  const raw = req.query.SN ?? req.query.sn ?? req.get("SN") ?? req.get("sn") ?? "";
  const sn = String(raw).trim();
  return SN_RE.test(sn) ? sn : null;
}

/**
 * Optional shared secret. When `ADMS_DEVICE_KEY` is set the device must send it
 * as `?key=` (or an `X-Device-Key` header); when it is unset the endpoint stays
 * open and relies on SN activation, as before.
 */
function keyAccepted(req: Request): boolean {
  const expected = process.env.ADMS_DEVICE_KEY?.trim();
  if (!expected) return true;
  const supplied = String(req.query.key ?? req.get("X-Device-Key") ?? "").trim();
  return supplied === expected;
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

/** Gate + resolve the SN in one step; writes the refusal itself. */
async function admit(req: Request, res: Response): Promise<string | null> {
  const sn = snOf(req);
  if (!sn) {
    res.status(400).type("text/plain").send("BAD SN");
    return null;
  }
  if (!keyAccepted(req)) {
    logger.warn({ sn }, "adms: rejected — device key mismatch");
    res.status(401).type("text/plain").send("UNAUTHORIZED");
    return null;
  }
  return sn;
}

const router: IRouter = Router();

// Raw text for EVERY request on this router, declared before the handlers so
// the body is never consumed by a parser the device did not satisfy. ZKTeco
// firmware is inconsistent about Content-Type on ATTLOG uploads (text/plain,
// application/octet-stream, or none at all) and `type: () => true` takes all.
const rawText = express.text({ type: () => true, limit: "5mb" });

router.get("/iclock/cdata", async (req: Request, res: Response): Promise<void> => {
  const sn = await admit(req, res);
  if (!sn) return;
  try {
    await touchDevice(sn);
    res.type("text/plain").send(handshakeConfig(sn));
  } catch (err) {
    logger.error({ err, sn }, "adms: handshake failed");
    res.status(500).type("text/plain").send("ERROR");
  }
});

router.post("/iclock/cdata", rawText, async (req: Request, res: Response): Promise<void> => {
  const sn = await admit(req, res);
  if (!sn) return;
  const table = String(req.query.table ?? req.query.Table ?? "").toUpperCase();
  try {
    const active = await touchDevice(sn);
    const body = typeof req.body === "string" ? req.body : "";

    if (table === "ATTLOG") {
      if (!active) {
        // Registering the device and acknowledging the upload is deliberate: an
        // un-acked push makes the device retry the same batch forever. The
        // punches are dropped, and the operator activates the SN on /hr.
        logger.warn({ sn }, "adms: attlog from inactive device dropped");
      } else {
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
      }
    } else if (table === "OPERLOG") {
      logger.info({ sn }, "adms: operlog acknowledged");
    } else if (table === "OPTIONS" || table === "ATTPHOTO" || table === "BIODATA") {
      // The device pushes its own configuration / photos / templates right
      // after the handshake. We do not store them, but they MUST be
      // acknowledged or the firmware treats the server as broken and re-sends.
      logger.info({ sn, table, body: body.slice(0, 2000) }, "adms: push acknowledged");
    }

    res.type("text/plain").send("OK");
  } catch (err) {
    logger.error({ err, sn, table }, "adms: push failed");
    // Non-OK makes the device retry later, so punches are not lost.
    res.status(500).type("text/plain").send("ERROR");
  }
});

router.get("/iclock/getrequest", async (req: Request, res: Response): Promise<void> => {
  const sn = await admit(req, res);
  if (!sn) return;
  await touchDevice(sn).catch(() => undefined);
  // "OK" with no command body = nothing queued. Remote commands are not used.
  res.type("text/plain").send("OK");
});

router.post("/iclock/devicecmd", rawText, async (req: Request, res: Response): Promise<void> => {
  const sn = await admit(req, res);
  if (!sn) return;
  await touchDevice(sn).catch(() => undefined);
  res.type("text/plain").send("OK");
});

/** Legacy liveness probe; some firmware pings this before the first handshake. */
router.get("/iclock/ping", async (req: Request, res: Response): Promise<void> => {
  const sn = await admit(req, res);
  if (!sn) return;
  await touchDevice(sn).catch(() => undefined);
  res.type("text/plain").send("OK");
});

/**
 * Device registry (push protocol 3.x). The device announces its capabilities
 * as `key=value` pairs; acknowledging keeps it on the modern flow instead of
 * falling back to the legacy one.
 */
const registry = async (req: Request, res: Response): Promise<void> => {
  const sn = await admit(req, res);
  if (!sn) return;
  await touchDevice(sn).catch(() => undefined);
  res.type("text/plain").send("OK");
};
router.get("/iclock/registry", registry);
router.post("/iclock/registry", rawText, registry);

export default router;
