// The curated model catalog and its three-tier classification.
//
// Tiers
//   free       - provider offers a documented free tier; marginal cost is zero
//                *within quota*. No paid fallback is ever allowed from here.
//   economical - cheap paid (sub-$1 / 1M input). The daily driver.
//   premium    - expensive. REQUIRES explicit per-task approval; never selected
//                automatically, never used by planner/condenser/sub-agents.
//
// `profile` names the saved OpenHands LLM profile that already carries the
// credentials for the provider. `null` means "use the managed OpenHands proxy"
// (the `openhands/...` model ids).
export const TIERS = ["free", "economical", "premium"];

export const CATALOG = [
  // ---------- FREE (documented free tier) ----------
  {
    id: "groq/openai/gpt-oss-120b",
    label: "Groq · gpt-oss-120b",
    tier: "free",
    provider: "groq",
    profile: "Groq",
    freeTier: true,
    freeTierNote: "Groq free tier; rate-limited, zero marginal cost within quota",
    toolCalling: true,
    contextWindow: 131072,
    strengths: ["fast", "code", "search", "summarise"],
  },
  {
    id: "cerebras/gpt-oss-120b",
    label: "Cerebras · gpt-oss-120b",
    tier: "free",
    provider: "cerebras",
    profile: "Cerebras",
    freeTier: true,
    freeTierNote: "Cerebras free tier; very fast inference",
    toolCalling: true,
    contextWindow: 131072,
    strengths: ["fast", "code", "search"],
  },
  {
    id: "gemini/gemini-3.5-flash-lite",
    label: "Gemini · 3.5 Flash-Lite",
    tier: "free",
    provider: "gemini",
    profile: "Gemini",
    freeTier: true,
    freeTierNote: "Google AI Studio free tier (documented free quota)",
    toolCalling: true,
    contextWindow: 1000000,
    strengths: ["long-context", "docs", "summarise"],
  },
  {
    id: "gemini/gemini-3.1-flash-lite",
    label: "Gemini · 3.1 Flash-Lite",
    tier: "free",
    provider: "gemini",
    profile: "Gemini",
    freeTier: true,
    freeTierNote: "Google AI Studio free tier (documented free quota)",
    toolCalling: true,
    contextWindow: 1000000,
    strengths: ["long-context", "docs"],
  },
  {
    id: "openrouter/nex-agi/nex-n2.5-pro:free",
    label: "OpenRouter · Nex N2.5 Pro (free)",
    tier: "free",
    provider: "openrouter",
    profile: "OpenRouter",
    freeTier: true,
    freeTierNote: "OpenRouter ':free' variant; zero cost, stricter rate limits",
    toolCalling: true,
    contextWindow: 128000,
    strengths: ["reasoning", "code"],
  },

  // ---------- ECONOMICAL (cheap paid = the daily driver) ----------
  {
    id: "openhands/deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash (managed)",
    tier: "economical",
    provider: "openhands",
    profile: null,
    toolCalling: true,
    contextWindow: 128000,
    strengths: ["code", "tools", "balanced"],
  },
  {
    id: "deepseek/deepseek-chat",
    label: "DeepSeek Chat",
    tier: "economical",
    provider: "deepseek",
    profile: "DeepSeek-V4-Pro",
    toolCalling: true,
    contextWindow: 128000,
    strengths: ["code", "tools", "cheap"],
  },
  {
    id: "deepseek/deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    tier: "economical",
    provider: "deepseek",
    profile: "DeepSeek-V4-Pro",
    toolCalling: true,
    contextWindow: 128000,
    strengths: ["code", "fast"],
  },

  // ---- Economical, observed in this workspace's real cloud billing ----
  // These are the managed (`openhands/...`) and Gemini aliases the cloud
  // reports. Classifying them is what stops the monitor calling real spend
  // "unknown" and what keeps them out of the premium approval path.
  {
    id: "deepseek/deepseek-v4-pro",
    label: "DeepSeek V4 Pro (managed)",
    tier: "economical",
    provider: "openhands",
    profile: null,
    toolCalling: true,
    highCost: true, // ~$1.32 / $3.96 per 1M direct — the priciest economical tier
    contextWindow: 128000,
    strengths: ["reasoning", "code"],
  },
  {
    id: "openhands/deepseek-v4-pro",
    label: "DeepSeek V4 Pro (managed alias)",
    tier: "economical",
    provider: "openhands",
    profile: null,
    toolCalling: true,
    highCost: true,
    contextWindow: 128000,
    strengths: ["reasoning", "code"],
  },
  {
    id: "openhands/deepseek-v4-flash",
    label: "DeepSeek V4 Flash (managed)",
    tier: "economical",
    provider: "openhands",
    profile: null,
    toolCalling: true,
    contextWindow: 128000,
    strengths: ["code", "fast"],
  },
  {
    id: "openhands/deepseek-chat",
    label: "DeepSeek Chat (managed)",
    tier: "economical",
    provider: "openhands",
    profile: null,
    toolCalling: true,
    contextWindow: 128000,
    strengths: ["code", "cheap"],
  },
  // --- Operator-assigned distribution (2026-11-12) ---
  // simple -> deepseek-v4.1-flash (base/default), medium -> gemini-3.5-flash, complex -> opus-5.5 (approval-gated)
  {
    id: "gemini/gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    tier: "economical",
    provider: "gemini",
    profile: "Gemini",
    toolCalling: true,
    contextWindow: 1000000,
    strengths: ["medium tasks", "long-context", "code"],
    assigned: "medium",
  },
  {
    id: "anthropic/claude-opus-5-5",
    label: "Claude Opus 5.5",
    tier: "premium",
    provider: "anthropic",
    profile: "Opus 5.5",
    toolCalling: true,
    contextWindow: 200000,
    strengths: ["complex reasoning", "architecture", "hard bugs"],
    assigned: "complex",
    requiresApproval: true,
  },
  {
    id: "gemini/gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    tier: "economical",
    provider: "gemini",
    profile: "Gemini",
    toolCalling: true,
    contextWindow: 1000000,
    strengths: ["long-context", "code"],
  },
  {
    id: "gemini/gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    tier: "economical",
    provider: "gemini",
    profile: "Gemini",
    toolCalling: true,
    contextWindow: 1000000,
    strengths: ["long-context", "code"],
  },
  {
    id: "gemini/gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    tier: "economical",
    provider: "gemini",
    profile: "Gemini",
    toolCalling: true,
    contextWindow: 1000000,
    strengths: ["long-context", "code"],
  },
  {
    id: "openhands/gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite (managed)",
    tier: "free",
    provider: "openhands",
    profile: null,
    freeTier: true,
    freeTierNote: "Gemini Flash-Lite family; free tier at Google, managed alias here",
    toolCalling: true,
    contextWindow: 1000000,
    strengths: ["long-context", "cheap"],
  },
  {
    id: "openhands/gemini-3.7-flash",
    label: "Gemini 3.7 Flash (managed)",
    tier: "economical",
    provider: "openhands",
    profile: null,
    toolCalling: true,
    contextWindow: 1000000,
    strengths: ["long-context"],
  },
  {
    id: "openhands/glm-5.3-flash",
    label: "GLM 5.3 Flash (managed)",
    tier: "economical",
    provider: "openhands",
    profile: null,
    toolCalling: true,
    contextWindow: 128000,
    strengths: ["code"],
  },
  {
    id: "openhands/minimax-m3.1-flash",
    label: "MiniMax M3.1 Flash (managed)",
    tier: "economical",
    provider: "openhands",
    profile: null,
    toolCalling: true,
    contextWindow: 128000,
    strengths: ["code"],
  },
  {
    id: "openhands/nemotron-3-nano",
    label: "Nemotron 3 Nano (managed)",
    tier: "economical",
    provider: "openhands",
    profile: null,
    toolCalling: true,
    contextWindow: 128000,
    strengths: ["cheap"],
  },
  {
    id: "openhands/qwen3-coder-flash",
    label: "Qwen3 Coder Flash (managed)",
    tier: "economical",
    provider: "openhands",
    profile: null,
    toolCalling: true,
    contextWindow: 128000,
    strengths: ["code"],
  },
  {
    id: "openhands/devstral-2512",
    label: "Devstral 2512 (managed)",
    tier: "economical",
    provider: "openhands",
    profile: null,
    toolCalling: true,
    contextWindow: 128000,
    strengths: ["code"],
  },
  {
    id: "nvidia_nim/nvidia/nemotron-3-super-120b-a12b",
    label: "Nemotron 3 Super 120B (NVIDIA NIM)",
    tier: "economical",
    provider: "nvidia_nim",
    profile: "NVIDIA",
    toolCalling: true,
    contextWindow: 128000,
    strengths: ["reasoning"],
  },

  // ---------- PREMIUM (approval required) ----------
  {
    id: "anthropic/claude-opus-5-5",
    label: "Claude Opus 5.5",
    tier: "premium",
    provider: "anthropic",
    profile: "Opus 5.5",
    toolCalling: true,
    contextWindow: 200000,
    strengths: ["architecture", "refactor", "hard-debug"],
  },
  {
    id: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5",
    tier: "premium",
    provider: "anthropic",
    profile: "Opus 5.5",
    toolCalling: true,
    contextWindow: 200000,
    strengths: ["complex-code"],
  },
  {
    id: "anthropic/claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    tier: "premium",
    provider: "anthropic",
    profile: "Opus 5.5",
    toolCalling: true,
    contextWindow: 200000,
    strengths: ["fast-premium"],
  },
];

const BY_ID = new Map(CATALOG.map((m) => [m.id, m]));

export function modelById(id) {
  return BY_ID.get(id) || null;
}

export function tierOf(id) {
  const m = BY_ID.get(id);
  return m ? m.tier : null;
}

export function modelsByTier(tier) {
  return CATALOG.filter((m) => m.tier === tier);
}

// Providers that hold a paid credential. Anything reaching one of these is a
// spend event unless the model is on the documented free tier.
export const PAID_PROVIDERS = ["anthropic", "openai", "deepseek", "openhands"];

export function isPaidModel(id) {
  const m = BY_ID.get(id);
  if (!m) {
    // Unknown model: treat as paid (deny-by-default) unless it is clearly a
    // free-tier provider AND explicitly marked free by suffix.
    return !id.endsWith(":free");
  }
  return m.tier !== "free" && !m.freeTier;
}

// Free-tier models must never be silently treated as "free forever": the
// provider may bill past the quota, so the policy keeps them in the free tier
// but the monitor records the caveat.
export function freeTierCaveat(id) {
  const m = BY_ID.get(id);
  return m?.freeTier ? m.freeTierNote : null;
}
