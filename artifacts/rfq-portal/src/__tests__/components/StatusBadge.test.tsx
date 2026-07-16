import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "@/components/StatusBadge";

// Mock the LanguageContext — t() returns the key so the component falls back to raw status
vi.mock("@/contexts/LanguageContext", () => ({
  useLanguage: () => ({
    lang: "en",
    setLang: vi.fn(),
    t: (key: string) => key, // returns key unchanged → triggers fallback to raw status
    dir: "ltr" as const,
    isAr: false,
  }),
}));

// Helper: render and return the badge element
function renderBadge(status: string) {
  render(<StatusBadge status={status} />);
  // When t(key) === key, label falls back to the raw status value
  return screen.getByText(status);
}

describe("StatusBadge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Renders all known statuses ───────────────────────────────────────────
  it.each([
    ["DRAFT", "text-gray-600"],
    ["SENT", "text-blue-700"],
    ["QUOTED", "text-orange-700"],
    ["FAILED", "text-red-700"],
    ["SUCCESS", "text-green-700"],
  ])("renders %s with class containing %s", (status, expectedClass) => {
    const badge = renderBadge(status);
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain(expectedClass);
  });

  it("renders lowercase draft status", () => {
    const badge = renderBadge("draft");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain("text-gray-600");
  });

  it("falls back to gray style for unknown status", () => {
    const badge = renderBadge("UNKNOWN");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain("bg-gray-100");
    expect(badge.className).toContain("text-gray-600");
  });

  // ── Structural checks ────────────────────────────────────────────────────
  it("renders a <span> element", () => {
    const badge = renderBadge("DRAFT");
    expect(badge.tagName).toBe("SPAN");
  });

  it("always has base layout classes", () => {
    const badge = renderBadge("SENT");
    expect(badge.className).toContain("inline-flex");
    expect(badge.className).toContain("rounded");
    expect(badge.className).toContain("text-xs");
  });
});
