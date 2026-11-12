// Model pricing, derived from the LiteLLM price map bundled with the
// OpenHands agent-server. Prices are USD per single token (LiteLLM's own unit);
// every consumer converts to USD per 1M tokens for readability.
import { readFileSync, existsSync, readdirSync } from "node:fs";

const PRICE_FILE_CANDIDATES = [
  process.env.OH_LITELLM_PRICE_FILE,
  "/tmp/_MEI00000001iojat0/litellm/model_prices_and_context_window_backup.json",
].filter(Boolean);

let PRICE_MAP = null;
let PRICE_SOURCE = null;

function findPriceFile() {
  for (const f of PRICE_FILE_CANDIDATES) {
    if (f && existsSync(f)) return f;
  }
  // Fall back to any bundled PyInstaller extraction of litellm.
  try {
    for (const d of readdirSync("/tmp")) {
      if (d.startsWith("_MEI")) {
        const p = `/tmp/${d}/litellm/model_prices_and_context_window_backup.json`;
        if (existsSync(p)) return p;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function loadPriceMap() {
  if (PRICE_MAP) return PRICE_MAP;
  const file = findPriceFile();
  if (!file) {
    PRICE_MAP = {};
    PRICE_SOURCE = null;
    return PRICE_MAP;
  }
  PRICE_MAP = JSON.parse(readFileSync(file, "utf8"));
  PRICE_SOURCE = file;
  return PRICE_MAP;
}

export function priceSource() {
  loadPriceMap();
  return PRICE_SOURCE;
}

// Resolve a model id to its price entry. Tries exact id, then a set of
// provider-qualified forms, then a unique suffix match.
export function lookupPrice(modelId) {
  const map = loadPriceMap();
  if (!modelId) return null;
  const direct = map[modelId];
  if (direct && direct.input_cost_per_token != null) return { key: modelId, entry: direct };

  const bare = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
  const providerHints = [
    "deepseek/" + bare,
    "groq/" + bare,
    "cerebras/" + bare,
    "gemini/" + bare,
    "anthropic/" + bare,
    "openai/" + bare,
    "moonshot/" + bare,
    "zai/" + bare,
    "nebius/nvidia/" + bare,
    bare,
  ];
  for (const k of providerHints) {
    if (map[k] && map[k].input_cost_per_token != null) return { key: k, entry: map[k] };
  }
  const matches = Object.keys(map).filter((k) => k === bare || k.endsWith("/" + bare));
  for (const k of matches) {
    if (map[k].input_cost_per_token != null) return { key: k, entry: map[k] };
  }
  return null;
}

// USD per 1M tokens.
export function perMillion(entry, field) {
  const v = entry?.[field];
  if (v == null) return null;
  return v * 1_000_000;
}

export function priceSummary(modelId) {
  const hit = lookupPrice(modelId);
  if (!hit) return { model: modelId, found: false };
  const { entry, key } = hit;
  return {
    model: modelId,
    priceKey: key,
    found: true,
    inputPerM: perMillion(entry, "input_cost_per_token"),
    outputPerM: perMillion(entry, "output_cost_per_token"),
    cacheReadPerM: perMillion(entry, "cache_read_input_token_cost"),
    cacheWritePerM: perMillion(entry, "cache_creation_input_token_cost"),
    contextWindow: entry.max_input_tokens ?? null,
  };
}
