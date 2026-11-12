#!/usr/bin/env node
// Roll back every change this toolchain made, using the backups taken before
// the first modification. Safe to run repeatedly.
//
// Usage: node src/rollback.mjs [--dry-run]
import { readFileSync, existsSync } from "node:fs";

const DRY = process.argv.includes("--dry-run");
const BACKUP_DIR = process.env.OH_BACKUP_DIR || "/workspace/oh-cost-backup";
const DAY = process.env.OH_BACKUP_DAY || "2026-11-12";
const dir = `${BACKUP_DIR}/${DAY}`;

const TOKEN = process.env.OPENHANDS_API_KEY;
const ORG = process.env.OH_ORG_ID || "27f3715a-6413-4d94-aea5-e9e78eb7f974";
const SESSION_KEY = process.env.OH_SESSION_API_KEY;
const AGENT = process.env.OH_AGENT_SERVER || "http://127.0.0.1:60000";

async function api(url, opts = {}) {
  const r = await fetch(url, opts);
  return { status: r.status, body: await r.text() };
}

const plan = [];

// 1. Cloud org: clear the per-task budget cap (restore the backed-up value).
const orgBackup = `${dir}/cloud_org.json`;
if (existsSync(orgBackup)) {
  const b = JSON.parse(readFileSync(orgBackup, "utf8"));
  plan.push({
    what: "cloud org max_budget_per_task",
    restoreTo: b.max_budget_per_task ?? null,
    run: async () => {
      if (DRY) return "(dry-run)";
      const r = await api(`https://app.all-hands.dev/api/organizations/${ORG}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ max_budget_per_task: b.max_budget_per_task ?? null }),
      });
      return `${r.status} ${r.body.slice(0, 120)}`;
    },
  });
}

// 2. Cloud org app settings: restore max_budget_per_task.
plan.push({
  what: "cloud org-app max_budget_per_task",
  restoreTo: null,
  run: async () => {
    if (DRY) return "(dry-run)";
    const r = await api("https://app.all-hands.dev/api/organizations/app", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ max_budget_per_task: null }),
    });
    return `${r.status} ${r.body.slice(0, 120)}`;
  },
});

// 3. Agent server: deactivate and delete the cost-router meta profile.
plan.push({
  what: "agent-server meta-profile cost-router",
  restoreTo: "deactivated + deleted (none existed before)",
  run: async () => {
    if (DRY) return "(dry-run)";
    if (!SESSION_KEY) return "skipped (OH_SESSION_API_KEY unset)";
    const h = { "X-Session-API-Key": SESSION_KEY, "Content-Type": "application/json" };
    const a = await api(`${AGENT}/api/settings`, {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ active_meta_profile: null }),
    });
    const d = await api(`${AGENT}/api/meta-profiles/cost-router`, { method: "DELETE", headers: h });
    return `deactivate ${a.status}, delete ${d.status}`;
  },
});

// 4. Cloud org profiles: restore each profile's model from the pre-change backup.
const profBackup = `${dir}/cloud_profiles.before.json`;
if (existsSync(profBackup)) {
  const b = JSON.parse(readFileSync(profBackup, "utf8"));
  for (const p of b.profiles || []) {
    plan.push({
      what: `cloud profile ${p.name}`,
      restoreTo: p.model,
      run: async () => {
        if (DRY) return "(dry-run)";
        const r = await api(
          `https://app.all-hands.dev/api/organizations/${ORG}/profiles/${encodeURIComponent(p.name)}`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              llm: { model: p.model, base_url: p.base_url },
              preserve_existing_api_key: true,
            }),
          },
        );
        return `${r.status}`;
      },
    });
  }
}

console.log(`Rollback plan (${DRY ? "DRY RUN" : "APPLYING"}):`);
for (const p of plan) {
  const res = await p.run();
  console.log(`  - ${p.what}: restore to ${JSON.stringify(p.restoreTo)} -> ${res}`);
}
console.log(
  "\nLocal files are untouched by rollback; delete .oh-cost-governor/ to remove the toolchain.",
);
