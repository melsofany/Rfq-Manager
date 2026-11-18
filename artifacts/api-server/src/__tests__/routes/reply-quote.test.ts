import { describe, it, expect } from "vitest";
import { matchQuotedMessage, wamidToken } from "../../modules/communications/reply-quote";

/**
 * The ids below are REAL, taken from the production `whatsapp_chats` rows that
 * produced the «رسالة غير موجودة» report (reply 14932 quoting the interactive
 * list message «طلبات التسعير»). Using the live shapes rather than invented
 * ones is what makes the token tests meaningful: a hand-made id can be made to
 * pass any split.
 */
const QUOTED_MISSING = "wamid.HBgMMjAxMDk0NjQxNTA1FQIAERgSMUNDOUMwRkJGRDM4NTFGNjdGAA==";
const OUTBOUND_14930 = "wamid.HBgMMjAxMDk0NjQxNTA1FQIAERgSNDAzRjBGNzVFNEE5NzYzRTFGAA==";
const OUTBOUND_14931 = "wamid.HBgMMjAxMDk0NjQxNTA1FQIAERgSREMzOUVDNDZBOEEyOUQxRERGAA==";
const INBOUND_14932 = "wamid.HBgMMjAxMDk0NjQxNTA1FQIAEhgUMkEzRDMxMTk5QzgwQkJEODcxRTEA";

/**
 * Build a wamid the way Meta does: ASCII phone, a few scope bytes, then the
 * token as ASCII hex text. Two scope values yield two DIFFERENT complete ids
 * that decode to the SAME token — exactly the phone-scoped vs BSUID-scoped case
 * Chatwoot's finder documents. Constructed rather than hand-typed so the shared
 * token is a fact, not an assumption.
 */
function buildWamid(tokenHex: string, scope: "phone" | "bsuid" | "third"): string {
  // Byte-for-byte the shape Meta sends (verified against live rows): a 3-byte
  // header, the ASCII phone, then the scope bytes. Only the scope differs
  // between the two forms, so the token is provably the same. The scope marker
  // is what delimits the token's start (`\x12`/`\x20` are not hex digits), and
  // the NUL terminates it — the two anchors the real extraction relies on.
  const phone = "201094641505";
  const head = "\x1c\x18\x0c" + phone;
  const scopeBytes =
    scope === "phone"
      ? "\x15\x02\x00\x11\x18\x12"
      : scope === "bsuid"
        ? "\x15\x02\x00\x12\x18\x20"
        : "\x15\x02\x00\x13\x18\x20";
  return `wamid.${Buffer.from(head + scopeBytes + tokenHex + "\x00", "latin1").toString("base64")}`;
}

describe("wamidToken", () => {
  it("derives a token from a real wamid", () => {
    expect(wamidToken(OUTBOUND_14930)).toBe("403f0f75e4a9763e1f");
  });

  it("gives the same token for the phone- and BSUID-scoped forms of one message", () => {
    const phoneScoped = buildWamid("403F0F75E4A9763E1F", "phone");
    const bsuidScoped = buildWamid("403F0F75E4A9763E1F", "bsuid");
    // The complete ids differ; the token is what survives the difference.
    expect(phoneScoped).not.toBe(bsuidScoped);
    expect(wamidToken(phoneScoped)).toBe("403f0f75e4a9763e1f");
    expect(wamidToken(bsuidScoped)).toBe("403f0f75e4a9763e1f");
  });

  it("returns null for a non-wamid, an empty value, and undecodable input", () => {
    expect(wamidToken(null)).toBeNull();
    expect(wamidToken("")).toBeNull();
    expect(wamidToken("abc-123")).toBeNull();
    expect(wamidToken("wamid.!!!!")).toBeNull();
  });
});

describe("matchQuotedMessage", () => {
  const candidates = [
    { id: 14930, waMessageId: OUTBOUND_14930 },
    { id: 14931, waMessageId: OUTBOUND_14931 },
    { id: 14932, waMessageId: INBOUND_14932 },
  ];

  it("prefers an exact match", () => {
    expect(matchQuotedMessage(OUTBOUND_14931, candidates)?.id).toBe(14931);
  });

  it("finds a message whose id differs but whose token agrees", () => {
    // Same token as OUTBOUND_14930, different complete id — the lookup an
    // exact-match-only implementation misses.
    const sameTokenOtherScope = buildWamid("403F0F75E4A9763E1F", "bsuid");
    expect(sameTokenOtherScope).not.toBe(OUTBOUND_14930);
    expect(wamidToken(sameTokenOtherScope)).toBe(wamidToken(OUTBOUND_14930));
    expect(matchQuotedMessage(sameTokenOtherScope, candidates)?.id).toBe(14930);
  });

  it("returns undefined for a message that was never stored", () => {
    // The live failure: reply 14932 quotes this id and NO row carries it.
    expect(matchQuotedMessage(QUOTED_MISSING, candidates)).toBeUndefined();
  });

  it("refuses an ambiguous token instead of guessing", () => {
    // Two DIFFERENT messages sharing a token cannot both be the target.
    // Attributing the quote to the wrong one would show the operator another
    // item's price or specification, which is worse than showing none.
    const twin = { id: 99, waMessageId: buildWamid("403F0F75E4A9763E1F", "bsuid") };
    expect(twin.waMessageId).not.toBe(OUTBOUND_14930);
    expect(wamidToken(twin.waMessageId)).toBe(wamidToken(OUTBOUND_14930));
    // NEITHER candidate is the exact id, and both share the token -> the
    // resolver must return nothing rather than pick one arbitrarily.
    expect(matchQuotedMessage(OUTBOUND_14930, [twin])).toBeDefined();
    const twin2 = { id: 100, waMessageId: buildWamid("403F0F75E4A9763E1F", "phone") };
    expect(twin2.waMessageId).not.toBe(twin.waMessageId);
    const ambiguous = matchQuotedMessage(buildWamid("403F0F75E4A9763E1F", "third"), [twin, twin2]);
    expect(ambiguous).toBeUndefined();
    // An exact match still wins even when a twin exists.
    expect(matchQuotedMessage(OUTBOUND_14930, [twin, candidates[0]])?.id).toBe(14930);
  });

  it("ignores candidates with no id", () => {
    const withNulls = [{ id: 1, waMessageId: null }, ...candidates];
    expect(matchQuotedMessage(OUTBOUND_14931, withNulls)?.id).toBe(14931);
  });

  it("returns undefined for a null or empty target", () => {
    expect(matchQuotedMessage(null, candidates)).toBeUndefined();
    expect(matchQuotedMessage(undefined, candidates)).toBeUndefined();
    expect(matchQuotedMessage("", candidates)).toBeUndefined();
  });
});
