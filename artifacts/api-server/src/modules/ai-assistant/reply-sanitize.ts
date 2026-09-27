/**
 * Strip tool-call markup that a model sometimes emits as PLAIN TEXT.
 *
 * Live: the operator received a WhatsApp message containing literal
 * `<tool_calls>` / `<invoke name="…">` markup instead of an answer. The model had
 * been asked for a tool-free turn, could not call a tool, and so wrote what it
 * wanted to call as prose — and DeepSeek's own special tokens (its
 * `begin_of_sentence` / full-width-pipe control markers) leak through the
 * OpenAI-compatible endpoint the same way.
 *
 * The operator must never see the mechanism. A message that describes the tool
 * call instead of making it is a broken reply, not a partial one, so the markup
 * is removed and — when nothing readable remains — the caller replaces it with an
 * honest notice rather than an empty message.
 */
const MARKUP_PATTERNS: RegExp[] = [
  // A complete tool-call fence is removed WITH its body: stripping only the tags
  // would leave the arguments as ordinary prose («جاري البحث.EZQ 20/4»), which
  // reads as an answer even though it is a call the model could not make.
  /<\s*(?:[\w.-]+:)?(?:tool_calls?|function_calls?)\b[^>]*>[\s\S]*?<\/\s*(?:[\w.-]+:)?(?:tool_calls?|function_calls?)\s*>/gi,
  // A single invoke block, likewise with its body.
  /<\s*(?:[\w.-]+:)?invoke\b[^>]*>[\s\S]*?<\/\s*(?:[\w.-]+:)?invoke\s*>/gi,
  /<\s*(?:[\w.-]+:)?parameter\b[^>]*>[\s\S]*?<\/\s*(?:[\w.-]+:)?parameter\s*>/gi,
  // Any surviving tag (a stray open/close, a self-closing invoke).
  /<\/?\s*(?:[\w.-]+:)?(?:tool_calls?|function_calls?|invoke|parameter|tool_use)\b[^>]*>/gi,
  // DeepSeek / GLM control markers that surface as literal text on the compat API.
  /<[｜|]{1,2}[^>]{0,80}[｜|]{1,2}>/g,
  /(?:<|&lt;)\s*[｜|][^>]{0,120}(?:[｜|]|>)/g,
];

/** True when the text still carries an unclosed tool-call fence. */
function hasUnclosedFence(text: string): boolean {
  const opens = (text.match(/<\s*(?:[\w.-]+:)?(?:tool_calls?|function_calls?)\b/gi) ?? []).length;
  const closes = (text.match(/<\/\s*(?:[\w.-]+:)?(?:tool_calls?|function_calls?)\s*>/gi) ?? [])
    .length;
  return opens > closes;
}

/**
 * Remove tool-call markup and collapse the whitespace it leaves behind.
 *
 * Kept conservative: only recognisable call syntax is touched, so ordinary prose
 * that mentions a tool by name («استخدمت أداة حصر البريد») is preserved.
 */
export function sanitizeAssistantReply(raw: string): string {
  if (!raw) return raw;
  // A truncated call block can swallow the rest of the message; cut from the
  // opening fence when no matching close exists, then strip the remainder.
  let text = raw;
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
  return MARKUP_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(raw);
  });
}
