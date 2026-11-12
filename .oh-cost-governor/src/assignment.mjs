// Operator-assigned model distribution (2026-11-12), mirrored from the live
// OpenHands configuration. This is the single source of truth for "which model
// runs which class of task" — the router and the guard both read it.
//
// simple  -> openhands/deepseek-v4.1-flash  (base/default model, cheap)
// medium  -> gemini/gemini-3.5-flash         (economical)
// complex -> anthropic/claude-opus-5-5       (premium, REQUIRES APPROVAL)
export const ASSIGNMENT = {
  simple: {
    model: "openhands/deepseek-v4.1-flash",
    profile: "Default",
    tier: "economical",
    note: "Base/default model. Handles reading, search, docs, comments, small UI.",
  },
  medium: {
    model: "gemini/gemini-3.5-flash",
    profile: "Gemini",
    tier: "economical",
    note: "Features, medium bugs, backend/API, SQL, React, business logic.",
  },
  complex: {
    model: "anthropic/claude-opus-5-5",
    profile: "Opus 5.5",
    tier: "premium",
    requiresApproval: true,
    note: "Architecture, large refactors, hard bugs, production incidents.",
  },
};

export const CLASSIFIER = { model: "groq/openai/gpt-oss-120b", profile: "Groq", tier: "free" };

// Routing is DENY-BY-DEFAULT for the premium tier: the complex class is only
// reachable with an explicit, one-shot approval recorded through the guard.
export function modelForClass(cls) {
  const a = ASSIGNMENT[cls];
  return a ? a.model : null;
}

export function requiresApproval(model) {
  return model === ASSIGNMENT.complex.model;
}
