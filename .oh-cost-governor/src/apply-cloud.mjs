#!/usr/bin/env node
// Apply a *minimal partial* update to OpenHands Cloud settings.
//
// Safety:
//   - Refuses to run unless a backup of the current settings exists.
//   - Sends ONLY the keys given (the cloud treats POST /api/v1/settings as a
//     partial update; an empty body is a verified no-op).
//   - Reads the settings back afterwards and prints a diff.
//
// Usage: node src/apply-cloud.mjs '<json-patch>'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const API = process.env.OH_CLOUD_API || "https://app.all-hands.dev/api/v1";
const TOKEN = process.env.OPENHANDS_API_KEY;
const BACKUP_DIR = process.env.OH_BACKUP_DIR || "/workspace/oh-cost-backup";

if (!TOKEN) {
  console.error("OPENHANDS_API_KEY is not set — refusing to run.");
  process.exit(1);
}

async function getSettings() {
  const r = await fetch(`${API}/settings`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`GET settings failed: ${r.status}`);
  return r.json();
}

async function postSettings(patch) {
  const r = await fetch(`${API}/settings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`POST settings failed: ${r.status} ${text.slice(0, 300)}`);
  return text;
}

function redact(o) {
  if (Array.isArray(o)) return o.map(redact);
  if (o && typeof o === "object") {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      out[k] = /key|token|secret|password/i.test(k) && v ? "<REDACTED>" : redact(v);
    }
    return out;
  }
  return o;
}

const patch = JSON.parse(process.argv[2] || "{}");
if (!Object.keys(patch).length) {
  console.error("Empty patch — nothing to do.");
  process.exit(1);
}

const latestBackup = existsSync(BACKUP_DIR)
  ? readFileSync(`${BACKUP_DIR}/2026-11-12/cloud_settings.raw.json`, "utf8")
  : null;
if (!latestBackup) {
  console.error(`No backup found under ${BACKUP_DIR} — refusing to modify settings.`);
  process.exit(1);
}

const before = await getSettings();
const ts = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync(`${BACKUP_DIR}/pre-apply`, { recursive: true });
writeFileSync(`${BACKUP_DIR}/pre-apply/cloud_settings.${ts}.json`, JSON.stringify(before, null, 2));

console.log("Applying patch keys:", Object.keys(patch).join(", "));
console.log(await postSettings(patch));

const after = await getSettings();
console.log("\n=== changed top-level keys ===");
for (const k of Object.keys(patch)) {
  const b = JSON.stringify(redact(before[k]));
  const a = JSON.stringify(redact(after[k]));
  console.log(`  ${k}: ${b?.slice(0, 120)} -> ${a?.slice(0, 120)}`);
}
