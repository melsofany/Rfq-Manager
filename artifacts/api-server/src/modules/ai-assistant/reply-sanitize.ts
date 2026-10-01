/**
 * Strip tool-call markup that a model sometimes emits as PLAIN TEXT.
 *
 * Live: the operator received a WhatsApp message containing literal
 * `<tool_calls>` / `<invoke name="вҖҰ">` markup instead of an answer. The model had
 * been asked for a tool-free turn, could not call a tool, and so wrote what it
 * wanted to call as prose вҖ” and DeepSeek's own special tokens (its
 * `begin_of_sentence` / full-width-pipe control markers) leak through the
 * OpenAI-compatible endpoint the same way.
 *
 * The operator must never see the mechanism. A message that describes the tool
 * call instead of making it is a broken reply, not a partial one, so the markup
 * is removed and вҖ” when nothing readable remains вҖ” the caller replaces it with an
 * honest notice rather than an empty message.
 */
const MARKUP_PATTERNS: RegExp[] = [
  // A complete tool-call fence is removed WITH its body: stripping only the tags
  // would leave the arguments as ordinary prose (В«Ш¬Ш§ШұЩҠ Ш§Щ„ШЁШӯШ«.EZQ 20/4В»), which
  // reads as an answer even though it is a call the model could not make.
  /<\s*(?:[\w.-]+:)?(?:tool_calls?|function_calls?)\b[^>]*>[\s\S]*?<\/\s*(?:[\w.-]+:)?(?:tool_calls?|function_calls?)\s*>/gi,
  // A single invoke block, likewise with its body.
  /<\s*(?:[\w.-]+:)?invoke\b[^>]*>[\s\S]*?<\/\s*(?:[\w.-]+:)?invoke\s*>/gi,
  /<\s*(?:[\w.-]+:)?parameter\b[^>]*>[\s\S]*?<\/\s*(?:[\w.-]+:)?parameter\s*>/gi,
  // Any surviving tag (a stray open/close, a self-closing invoke).
  /<\/?\s*(?:[\w.-]+:)?(?:tool_calls?|function_calls?|invoke|parameter|tool_use)\b[^>]*>/gi,
  // DeepSeek native DSML, observed in production as `<DSML｜｜ invoke ...>`.
  // The LLM layer normally converts this into structured calls; this fallback
  // ensures an unexpected provider shape can never reach WhatsApp as markup.
  /<\s*DSML\s*[｜|]{2}\s*(?:calls?|tool_calls?|invoke|parameter)\b[^>]*>[\s\S]*?<\/\s*DSML\s*[｜|]{2}\s*(?:calls?|tool_calls?|invoke|parameter)\s*>/gi,
  /<\/?\s*DSML\s*[｜|]{2}\s*(?:calls?|tool_calls?|invoke|parameter)\b[^>]*>/gi,
  // DeepSeek / GLM control markers that surface as literal text on the compat API.
  /<[пҪң|]{1,2}[^>]{0,80}[пҪң|]{1,2}>/g,
  /(?:<|&lt;)\s*[пҪң|][^>]{0,120}(?:[пҪң|]|>)/g,
];

/** True when the text still carries an unclosed tool-call fence. */
function hasUnclosedFence(text: string): boolean {
  const opens = (text.match(/<\s*(?:[\w.-]+:)?(?:tool_calls?|function_calls?)\b/gi) ?? []).length;
  const closes = (text.match(/<\/\s*(?:[\w.-]+:)?(?:tool_calls?|function_calls?)\s*>/gi) ?? [])
    .length;
  return opens > closes;
}

/**
 * Normalise DeepSeek/GLM's full-width-pipe control markers to plain tags.
 *
 * These models write the marker with U+FF5C FULLWIDTH VERTICAL LINE instead of
 * angle brackets — `<｜｜tool_calls｜｜>`, `</｜｜parameter>` — so every pattern
 * below (which expects `<name>`) missed them. Live, the operator received a
 * WhatsApp message reading literally:
 *
 *     2026-08-01</｜｜parameter>
 *     EZQ 20/4</｜｜parameter>
 *     rfq</｜｜parameter>
 *
 * i.e. the tool call the model could not make, leaked as prose — and the
 * arguments read like an answer. Mapping the marker onto `<name>` lets ONE set
 * of patterns cover both spellings; a second set of pipe-only patterns would be
 * the same duplication trap that let this leak in the first place.
 */
const PIPE = "[｜|]{1,2}";
/**
 * `<｜｜name attrs｜｜>` · `</｜｜name>` · bare `｜｜name｜｜` → the plain tag.
 *
 * The inner part may carry attributes (`<｜｜invoke name="…"｜｜>`), so the
 * normaliser must not assume a bare name — that assumption is what let the live
 * call leak. Angle brackets are added only when absent, so a tag the model
 * already wrote correctly passes through untouched.
 */
const PIPE_MARKUP_RE = new RegExp(`<\\s*(\\/?)\\s*${PIPE}\\s*`, "g");
const PIPE_CLOSE_RE = new RegExp(`\\s*${PIPE}\\s*>`, "g");
const PIPE_BARE_RE = new RegExp(`(^|[^<\\w])${PIPE}\\s*(\\/?[\\w.-]+)\\s*${PIPE}`, "g");

function normalizePipeMarkup(text: string): string {
  return text
    .replace(PIPE_MARKUP_RE, "<$1")
    .replace(PIPE_CLOSE_RE, ">")
    .replace(PIPE_BARE_RE, "$1<$2>");
}

/**
 * Remove tool-call markup and collapse the whitespace it leaves behind.
 *
 * Kept conservative: only recognisable call syntax is touched, so ordinary prose
 * that mentions a tool by name (В«Ш§ШіШӘШ®ШҜЩ…ШӘ ШЈШҜШ§Ш© ШӯШөШұ Ш§Щ„ШЁШұЩҠШҜВ») is preserved.
 */
export function sanitizeAssistantReply(raw: string): string {
  if (!raw) return raw;
  // Normalise first, so the fence check and every pattern below see one spelling.
  let text = normalizePipeMarkup(raw);
  // A truncated call block can swallow the rest of the message; cut from the
  // opening fence when no matching close exists, then strip the remainder.
  if (hasUnclosedFence(text)) {
    text = text.replace(/<\s*(?:[\w.-]+:)?(?:tool_calls?|function_calls?)\b[\s\S]*$/i, "");
  }
  for (const re of MARKUP_PATTERNS) text = text.replace(re, "");
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True when the reply carried tool-call syntax the operator must not see. */
export function hadToolMarkup(raw: string): boolean {
  if (!raw) return false;
  const text = normalizePipeMarkup(raw);
  return MARKUP_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}
