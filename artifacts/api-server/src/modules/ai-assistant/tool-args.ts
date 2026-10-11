/**
 * AI Assistant — tool-argument validation.
 *
 * The model supplies tool arguments as a JSON string. Before this check a broken
 * string silently became `{}` and the tool ran with no arguments, and a wrong type
 * (a string where a number was required) reached the executor unchecked. Both
 * produce confident answers built on a call that did not mean what the model
 * intended.
 *
 * `validateToolArgs` checks the arguments against the SAME JSON schema the model
 * was shown and returns a short, machine-readable message naming the problem, so
 * the model can correct the call in its next round instead of guessing.
 *
 * Deliberately small (required / type / enum / array items): it covers the
 * subset of JSON Schema the tool definitions use, with no new dependency.
 */

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  items?: Schema;
};

export interface ParsedArgs {
  args: Record<string, unknown>;
  /** Set when the raw payload was not a JSON object. */
  parseError: string | null;
}

/** Parse a tool call's argument string; a malformed payload is reported, not hidden. */
export function parseToolArgs(raw: string | null | undefined): ParsedArgs {
  const text = (raw ?? "").trim();
  if (!text) return { args: {}, parseError: null };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown>, parseError: null };
    }
    return { args: {}, parseError: "arguments must be a JSON object" };
  } catch {
    return { args: {}, parseError: "arguments are not valid JSON" };
  }
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return typeOf(value) === "object";
    default:
      return typeOf(value) === expected;
  }
}

function check(value: unknown, schema: Schema, path: string, problems: string[]): void {
  if (schema.type && !matchesType(value, schema.type)) {
    problems.push(`${path} must be ${schema.type}, got ${typeOf(value)}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    problems.push(`${path} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
    return;
  }
  if (schema.type === "array" && schema.items && Array.isArray(value)) {
    value.slice(0, 50).forEach((item, i) => check(item, schema.items!, `${path}[${i}]`, problems));
  }
}

/**
 * Returns a problem description, or `null` when the call is acceptable.
 * Unknown extra properties are tolerated: rejecting them would fail calls that
 * the executors already handle.
 */
export function validateToolArgs(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
  parseError: string | null = null,
): string | null {
  if (parseError) return parseError;
  if (!schema) return null;
  const s = schema as Schema;
  const problems: string[] = [];
  for (const key of s.required ?? []) {
    if (args[key] === undefined || args[key] === null) problems.push(`missing required "${key}"`);
  }
  for (const [key, sub] of Object.entries(s.properties ?? {})) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    check(value, sub, `"${key}"`, problems);
  }
  return problems.length ? problems.slice(0, 5).join("; ") : null;
}

/**
 * Models often send "230" where a number is declared (or "true" for a boolean).
 * That intent is unambiguous, so it is repaired rather than costing a round.
 */
export function coerceToolArgs(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const props = (schema as Schema | undefined)?.properties;
  if (!props) return args;
  const out: Record<string, unknown> = { ...args };
  for (const [key, sub] of Object.entries(props)) {
    const v = out[key];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if ((sub.type === "number" || sub.type === "integer") && /^-?\d+(\.\d+)?$/.test(t)) {
      out[key] = Number(t);
    } else if (sub.type === "boolean" && /^(true|false)$/i.test(t)) {
      out[key] = t.toLowerCase() === "true";
    }
  }
  return out;
}
