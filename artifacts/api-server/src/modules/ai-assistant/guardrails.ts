/**
 * AI Assistant — request guardrails (P4).
 *
 * The assistant is reachable from WhatsApp, where a message is free to send but
 * an answer costs provider quota (Gemini free tier: 20 requests/model/day) and a
 * few seconds. Two abuses follow directly from that:
 *
 *  1. **Flooding.** A burst of messages from one number exhausts the day's quota
 *     and the assistant goes silent for everyone — the recorded failure mode.
 *     A per-phone sliding window bounds that.
 *
 *  2. **Unbounded input.** A pasted document of arbitrary length is billed as
 *     tokens and can crowd the real question out of the context. The input is
 *     capped and the operator told, rather than truncated silently.
 *
 * Both are deliberately in-memory and per-process: this is a rate limit, not an
 * audit trail, and restarting the service resetting the window is acceptable.
 */
import { logger } from "../../shared/logger";

/** Max characters accepted from one message. Beyond this it is truncated. */
export const MAX_INPUT_CHARS = 4000;

/** Messages allowed per phone inside the window. */
export const RATE_LIMIT_MAX = 20;

/** Sliding window for the rate limit. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** phone → timestamps (ms) of the messages it sent inside the current window. */
const hits = new Map<string, number[]>();

/**
 * Truncate an over-long message and report whether it was cut.
 *
 * Returned rather than applied in place so the caller can tell the operator the
 * message was shortened — silently answering a truncated question produces a
 * confidently wrong answer, which is the failure class this module exists to
 * avoid.
 */
export function capInput(text: string): { text: string; truncated: boolean } {
  const t = text ?? "";
  if (t.length <= MAX_INPUT_CHARS) return { text: t, truncated: false };
  return { text: t.slice(0, MAX_INPUT_CHARS), truncated: true };
}

/**
 * Record a message from `phone` and report whether it is over the limit.
 *
 * The check is the admission decision: `allowed === false` means the caller
 * must NOT spend quota on this message. Old timestamps are pruned on every call
 * so the map cannot grow without bound.
 */
export function checkRateLimit(
  phone: string,
  now = Date.now(),
): { allowed: boolean; retryAfterMs: number } {
  const list = (hits.get(phone) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (list.length >= RATE_LIMIT_MAX) {
    const oldest = list[0];
    hits.set(phone, list);
    return { allowed: false, retryAfterMs: Math.max(0, RATE_LIMIT_WINDOW_MS - (now - oldest)) };
  }
  list.push(now);
  hits.set(phone, list);
  return { allowed: true, retryAfterMs: 0 };
}

/** Test seam: clear all windows so cases start from a known state. */
export function resetRateLimits(): void {
  hits.clear();
}

/**
 * Whether a message looks like an attempt to override the assistant's rules.
 *
 * This does NOT block the message — blocking is easy to bypass with a rephrase
 * and would break legitimate questions that merely contain the words. It is
 * logged so an attack is visible, and the system prompt's rule to treat tool and
 * mail content as DATA (never as instructions) is the actual defence: the model
 * is told, not merely filtered.
 */
const INJECTION_RE =
  /(ignore\s+(all\s+)?(previous|prior|above)\s+instructions|تجاهل\s+(كل\s+)?(التعليمات|الأوامر)|أنت الآن|you are now|developer\s*mode|اكشف\s+(لي\s+)?(المفتاح|التوكن|كلمة\s*المرور)|print\s+(your\s+)?(system\s+)?prompt)/i;

export function looksLikeInjection(text: string): boolean {
  return INJECTION_RE.test(text ?? "");
}

/** Log (never block) a suspected prompt-injection attempt. */
export function noteInjection(text: string, phone: string): void {
  if (looksLikeInjection(text)) {
    logger.warn({ phone }, "AI assistant: possible prompt-injection attempt");
  }
}
