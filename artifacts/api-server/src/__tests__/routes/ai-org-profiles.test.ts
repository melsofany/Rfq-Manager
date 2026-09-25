import { describe, it, expect } from "vitest";
import {
  numberShape,
  deriveDocumentFormats,
  matchesFormat,
  guessFormatKind,
  orgSlug,
  acronymOf,
  domainOf,
  domainLabel,
  normalizeOrgText,
  matchOrgProfile,
  mergeProfile,
  profileSearchTerms,
  renderOrgProfilesBlock,
  learnProfileFromMail,
  learnProfileFromUser,
  classifyByProfiles,
  inferIdentityFromMail,
  type OrgProfile,
} from "../../modules/ai-assistant/org-profiles";

/**
 * The operator asked the assistant to learn a counterparty «بالتحليل والمنطق ثم من
 * المستخدم» — the stated examples being EDC's RFQ format (`26R…`) and PO format
 * (`P26E…`). These tests pin the INFERENCE, because that is the part that makes
 * the rule generalise instead of memorising one document number.
 */

/** The exact numbers from the operator's message plus EDC live samples. */
const EDC = [
  { number: "26R011936", kind: "rfq" as const },
  { number: "26R011954", kind: "rfq" as const },
  { number: "26R011900", kind: "rfq" as const },
  { number: "P26E11407", kind: "po" as const },
  { number: "P26E14630", kind: "po" as const },
  { number: "P26E11255", kind: "po" as const },
  { number: "P26E09609", kind: "po" as const },
];

describe("numberShape", () => {
  it("splits a PO number into literals and digit runs", () => {
    const shape = numberShape("P26E11407");
    expect(shape?.literals).toEqual(["P", "E"]);
    expect(shape?.runs).toEqual([2, 5]);
  });

  it("splits an RFQ number whose first character is a digit", () => {
    const shape = numberShape("26R011936");
    expect(shape?.literals).toEqual(["", "R"]);
    expect(shape?.runs).toEqual([2, 6]);
  });

  it("rejects a value with no letters (not a document number)", () => {
    expect(numberShape("123456")).toBeNull();
  });

  it("rejects a value with no digits", () => {
    expect(numberShape("EDC")).toBeNull();
  });

  it("treats the two EDC formats as DIFFERENT shapes", () => {
    expect(numberShape("P26E11407")?.key).not.toBe(numberShape("26R011936")?.key);
  });
});

describe("deriveDocumentFormats — the analytical half", () => {
  it("generalises EDC's PO format into a regex, not a memorised number", () => {
    const rules = deriveDocumentFormats(EDC);
    const po = rules.find((r) => r.kind === "po");
    // The whole point: the rule must match a PO number never seen before.
    expect(po?.pattern).toBe("^P\\d{2}E\\d{5}$");
    expect(matchesFormat("P26E99999", po!)).toBe(true);
    // …and must NOT match an RFQ number.
    expect(matchesFormat("26R011936", po!)).toBe(false);
  });

  it("generalises EDC's RFQ format into its own rule", () => {
    const rules = deriveDocumentFormats(EDC);
    const rfq = rules.find((r) => r.kind === "rfq");
    expect(rfq?.pattern).toBe("^\\d{2}R\\d{6}$");
    expect(matchesFormat("26R999999", rfq!)).toBe(true);
  });

  it("keeps the wording's kind over the letter heuristic", () => {
    // `26R…` starts with a digit, so only the mail's own wording identifies it
    // as an RFQ. The letter heuristic must never override that.
    const rules = deriveDocumentFormats([
      { number: "26R011936", kind: "rfq" },
      { number: "26R011954", kind: "rfq" },
    ]);
    expect(rules[0].kind).toBe("rfq");
  });

  it("does NOT promote a format seen only once", () => {
    // One example cannot distinguish a format from a coincidence, and a wrong
    // rule in the prompt is worse than no rule at all.
    const rules = deriveDocumentFormats([{ number: "XY2600001", kind: "other" }]);
    expect(rules).toHaveLength(0);
    // …but an explicit minSupport of 1 makes it available when the user insists.
    expect(deriveDocumentFormats([{ number: "XY2600001" }], 1)).toHaveLength(1);
  });

  it("allows a growing serial width but keeps the literals strict", () => {
    const rules = deriveDocumentFormats([
      { number: "P26E90001", kind: "po" },
      { number: "P26E1000017", kind: "po" },
    ]);
    const po = rules[0];
    expect(matchesFormat("P26E500000", po)).toBe(true);
    // A different literal is a different format.
    expect(matchesFormat("P26X500000", po)).toBe(false);
  });

  it("orders the strongest-supported rule first", () => {
    const rules = deriveDocumentFormats([
      ...EDC,
      { number: "AB12345", kind: "other" },
      { number: "AB12399", kind: "other" },
    ]);
    expect(rules[0].evidence).toBeGreaterThanOrEqual(rules[1].evidence);
  });

  it("ignores numbers that are not document-shaped", () => {
    const rules = deriveDocumentFormats([
      { number: "123456" },
      { number: "123456" },
      { number: "EDC" },
    ]);
    expect(rules).toHaveLength(0);
  });
});

describe("guessFormatKind", () => {
  it("reads the letters out of the pattern", () => {
    expect(guessFormatKind("^P\\d{2}E\\d{5}$")).toBe("po");
    expect(guessFormatKind("^\\d{2}R\\d{6}$")).toBe("rfq");
    expect(guessFormatKind("^INV-\\d{4}-\\d{6}$")).toBe("invoice");
  });
});

describe("identity", () => {
  it("gives one slug to both spellings of the company name", () => {
    // «شركة» is corporate filler — it says nothing about WHICH company this is,
    // which is exactly why it must not separate the two spellings.
    expect(orgSlug("شركة الحفر المصرية")).toBe(orgSlug("الحفر المصرية"));
  });

  it("keeps two different companies apart", () => {
    expect(orgSlug("شركة الحفر المصرية")).not.toBe(orgSlug("شركة النور للتوريدات"));
  });

  it("folds Arabic spelling variants", () => {
    expect(normalizeOrgText("شركة")).toBe(normalizeOrgText("شركه"));
  });

  it("recognises a short all-caps acronym", () => {
    expect(acronymOf("EDC")).toBe("EDC");
    expect(acronymOf("Egyptian Drilling Company")).toBe("EDC");
    // An Arabic name has no Latin acronym to derive.
    expect(acronymOf("شركة الحفر")).toBeNull();
  });

  it("extracts a domain and its identity label, sub-domains included", () => {
    expect(domainOf("PO <noreply@edc-egypt.com>")).toBe("edc-egypt.com");
    expect(domainLabel("edc-egypt.com")).toBe("edcegypt");
    // A sub-domain must agree with its apex.
    expect(domainLabel("mail.edc-egypt.com")).toBe(domainLabel("edc-egypt.com"));
  });
});

describe("matchOrgProfile", () => {
  const edc = mergeProfile(null, {
    slug: "EDC",
    nameAr: "شركة الحفر المصرية",
    nameEn: "Egyptian Drilling Company",
    aliases: ["EDC"],
    domains: ["edc-egypt.com"],
  });

  it("matches by Arabic name", () => {
    expect(matchOrgProfile("إيه أخبار شركة الحفر المصرية؟", [edc])?.slug).toBe("EDC");
  });

  it("matches by acronym", () => {
    expect(matchOrgProfile("طلبات EDC الجديدة", [edc])?.slug).toBe("EDC");
  });

  it("matches by mail domain", () => {
    expect(matchOrgProfile("noreply@edc-egypt.com", [edc])?.slug).toBe("EDC");
  });

  it("returns null rather than guessing", () => {
    expect(matchOrgProfile("طلبات شركة النور", [edc])).toBeNull();
  });

  it("prefers the longest matching term", () => {
    const other = mergeProfile(null, { slug: "المصرية", aliases: ["المصرية"] });
    expect(matchOrgProfile("شركة الحفر المصرية", [other, edc])?.slug).toBe("EDC");
  });

  it("exposes the acronym and domain label as search terms", () => {
    const terms = profileSearchTerms(edc);
    expect(terms).toContain("edc");
    expect(terms).toContain("edcegypt");
  });
});

describe("mergeProfile — learning accumulates, never resets", () => {
  const first = mergeProfile(null, {
    slug: "EDC",
    nameAr: "شركة الحفر المصرية",
    domains: ["edc-egypt.com"],
    documentFormats: deriveDocumentFormats(EDC),
    evidenceCount: 7,
    sources: ["mail"],
  });

  it("keeps what mail taught when the user adds an alias", () => {
    const merged = mergeProfile(first, {
      aliases: ["الحفر المصرية"],
      sources: ["user"],
      notes: "طلبات التسعير تبدأ بـ 26R",
    });
    expect(merged.slug).toBe("EDC");
    expect(merged.aliases).toContain("الحفر المصرية");
    expect(merged.domains).toEqual(["edc-egypt.com"]);
    // Both formats survive the merge.
    expect(merged.documentFormats).toHaveLength(2);
    expect(merged.notes).toContain("26R");
  });

  it("raises evidence rather than duplicating a rule that is re-learned", () => {
    const again = mergeProfile(first, {
      documentFormats: deriveDocumentFormats(EDC),
    });
    const patterns = again.documentFormats.map((f) => f.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it("records that mail AND the user both contributed", () => {
    const merged = mergeProfile(first, { sources: ["user"] });
    expect(merged.sources).toEqual(expect.arrayContaining(["mail", "user"]));
    // Combining two independent sources is a stronger claim than either alone.
    expect(merged.confidence).toBeGreaterThan(first.confidence);
  });

  it("keeps a user-taught meaning attached to the rule", () => {
    const taught = mergeProfile(first, {
      documentFormats: [
        {
          kind: "rfq",
          pattern: "^\\d{2}R\\d{6}$",
          example: "26R011936",
          evidence: 3,
          meaning: "26 = السنة و R = طلب تسعير",
        },
      ],
    });
    const rfq = taught.documentFormats.find((f) => f.kind === "rfq");
    expect(rfq?.meaning).toContain("طلب تسعير");
  });

  it("never lowers confidence on a later, thinner sighting", () => {
    const thin = mergeProfile(first, { sources: ["mail"], evidenceCount: 1 });
    expect(thin.confidence).toBeGreaterThanOrEqual(first.confidence);
  });
});

describe("renderOrgProfilesBlock", () => {
  const profile = mergeProfile(null, {
    slug: "EDC",
    nameAr: "شركة الحفر المصرية",
    nameEn: "Egyptian Drilling Company",
    aliases: ["EDC"],
    domains: ["edc-egypt.com"],
    mailboxes: ["info"],
    documentFormats: deriveDocumentFormats(EDC),
    notes: "أوامر الشراء تصل إلى صندوق info",
  });

  it("renders the identity, the formats and the pattern", () => {
    const block = renderOrgProfilesBlock([profile]);
    expect(block).toContain("شركة الحفر المصرية");
    expect(block).toContain("EDC");
    expect(block).toContain("edc-egypt.com");
    expect(block).toContain("^P\\d{2}E\\d{5}$");
    expect(block).toContain("أمر شراء");
    expect(block).toContain("طلب تسعير");
  });

  it("renders nothing when there is nothing learned", () => {
    expect(renderOrgProfilesBlock([])).toBe("");
  });

  it("tells the model not to force an unknown number into a known pattern", () => {
    const block = renderOrgProfilesBlock([profile]);
    expect(block).toContain("غير معروف");
  });

  it("stays bounded so it cannot crowd out the conversation", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      mergeProfile(null, { slug: `ORG${i}`, documentFormats: deriveDocumentFormats(EDC) }),
    );
    const block = renderOrgProfilesBlock(many);
    expect(block.split("\n").length).toBeLessThan(120);
  });
});

describe("profile round-trip through a stored record", () => {
  it("survives serialisation as JSON", () => {
    const profile: OrgProfile = mergeProfile(null, {
      slug: "EDC",
      documentFormats: deriveDocumentFormats(EDC),
      evidenceCount: 7,
      sources: ["mail"],
    });
    const back = JSON.parse(JSON.stringify(profile)) as OrgProfile;
    expect(matchOrgProfile("EDC PO", [back])?.slug).toBe("EDC");
    expect(matchesFormat("P26E99999", back.documentFormats[0])).toBe(true);
  });
});

describe("learnProfileFromMail — the analytical path, no model call", () => {
  /** Realistic EDC mail: subjects carry the acronym, senders one domain. */
  const mail = [
    {
      number: "26R011936",
      kind: "rfq" as const,
      from: "EDC RFQ <noreply@edc-egypt.com>",
      subject: "EDC RFQ No 26R011936",
      mailbox: "info",
    },
    {
      number: "26R011954",
      kind: "rfq" as const,
      from: "EDC RFQ <noreply@edc-egypt.com>",
      subject: "EDC RFQ No 26R011954",
      mailbox: "info",
    },
    {
      number: "P26E11407",
      kind: "po" as const,
      from: "EDC PO <noreply@edc-egypt.com>",
      subject: "EDC PO No P26E11407",
      mailbox: "info",
    },
    {
      number: "P26E14630",
      kind: "po" as const,
      from: "EDC PO <noreply@edc-egypt.com>",
      subject: "EDC PO No P26E14630",
      mailbox: "info",
    },
  ];

  it("learns both of the operator's stated EDC formats from mail alone", () => {
    const profile = learnProfileFromMail(mail);
    const patterns = profile?.documentFormats.map((f) => f.pattern) ?? [];
    expect(patterns).toContain("^\\d{2}R\\d{6}$");
    expect(patterns).toContain("^P\\d{2}E\\d{5}$");
  });

  it("uses the acronym in the subjects as the identity", () => {
    expect(learnProfileFromMail(mail)?.slug).toBe("EDC");
  });

  it("learns the mail domain and the mailbox", () => {
    const profile = learnProfileFromMail(mail);
    expect(profile?.domains).toEqual(["edc-egypt.com"]);
    expect(profile?.mailboxes).toEqual(["info"]);
  });

  it("records the source as mail, not user", () => {
    expect(learnProfileFromMail(mail)?.sources).toEqual(["mail"]);
  });

  it("learns nothing from a single document (no coincidence in the prompt)", () => {
    expect(
      learnProfileFromMail([
        { number: "QQ12345", kind: "other", from: "x <x@nowhere.com>", subject: "hello" },
      ]),
    ).toBeNull();
  });

  it("still learns identity when no format recurs", () => {
    const profile = learnProfileFromMail([
      { number: "QQ12345", from: "ACME <a@acme.com>", subject: "ACME order", mailbox: "info" },
      { number: "ZZ99999", from: "ACME <b@acme.com>", subject: "ACME report", mailbox: "info" },
    ]);
    expect(profile?.slug).toBe("ACME");
    expect(profile?.documentFormats).toEqual([]);
  });

  it("ignores prose words that appear only once", () => {
    const profile = learnProfileFromMail([
      { number: "26R011936", kind: "rfq", from: "a@edc-egypt.com", subject: "Urgent EDC RFQ" },
      { number: "26R011954", kind: "rfq", from: "a@edc-egypt.com", subject: "EDC RFQ again" },
    ]);
    expect(profile?.aliases).not.toContain("urgent");
    expect(profile?.aliases).not.toContain("again");
  });
});

describe("learnProfileFromUser — the operator teaches", () => {
  it("turns a single authoritative example into a rule", () => {
    // The user's statement outranks mail's "seen twice" heuristic.
    const profile = learnProfileFromUser({
      slug: "EDC",
      text: "أوامر شراء EDC تبدأ بـ P ثم 26 ثم E",
      examples: [{ number: "P26E11407", kind: "po" }],
    });
    expect(profile?.documentFormats[0].pattern).toBe("^P\\d{2}E\\d{5}$");
    expect(profile?.sources).toEqual(["user"]);
  });

  it("keeps a note the operator gave", () => {
    const profile = learnProfileFromUser({
      slug: "EDC",
      text: "أوامر الشراء",
      notes: "كل الطلبات تصل إلى صندوق info",
    });
    expect(profile?.notes).toContain("info");
  });
});

describe("classifyByProfiles", () => {
  const edc = mergeProfile(null, {
    slug: "EDC",
    documentFormats: deriveDocumentFormats(EDC),
  });

  it("names the kind and owner of a number it has never seen", () => {
    const hit = classifyByProfiles("P26E99999", [edc]);
    expect(hit?.profile.slug).toBe("EDC");
    expect(hit?.rule.kind).toBe("po");
  });

  it("answers null rather than forcing an unknown number into a pattern", () => {
    expect(classifyByProfiles("XYZ-77", [edc])).toBeNull();
  });
});
