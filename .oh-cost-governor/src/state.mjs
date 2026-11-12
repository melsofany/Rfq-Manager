// Persistent policy state (local JSON, no secrets).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_STATE } from "./policy.mjs";

export const STATE_DIR = process.env.OH_COST_STATE_DIR || join(process.cwd(), "state");
export const STATE_FILE = join(STATE_DIR, "policy-state.json");

export function loadState() {
  if (!existsSync(STATE_FILE)) return { ...DEFAULT_STATE };
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  return STATE_FILE;
}
