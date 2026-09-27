/**
 * The scan report — the ten questions the operator asks of every job.
 *
 * These are the guards that matter: a sample must never be reported as a total
 * (`percent === 100` only when the scan really covered everything asked for), an
 * empty census must not read as complete, and the STOP REASON must be derived
 * from the counters rather than guessed. Each of these reproduces a live defect:
 * a reply that said «الحد 400» when the real ceiling was the clock, and a job
 * that recorded `complete: true` over an event that read no mail.
 */
import { describe, it, expect } from "vitest";
import {
  buildScanReport,
  deriveStopReason,
  describeStopReason,
  renderScanReport,
  scanReportProgress,
  type ScanReportInput,
} from "../../modules/ai-assistant/scan-report";

/** A complete, exhaustive census — the only shape allowed to report 100%. */
function full(overrides: Partial<ScanReportInput> = {}): ScanReportInput {
  return {
    query: "من EDC · موضوع «EDC PO No»",
    matched: 334,
    examined: 3704,
    opened: 334,
    pdfs: 332,
    results: 853,
    pages: 688,
    remaining: 0,
    reachedEnd: true,
    truncatedReason: null,
    unreadable: 0,
    startedAt: 0,
    now: 89_000,
    deadline: null,
    ...overrides,
  };
}

describe("scan report", () => {
  it("reports 100% for a census that covered everything asked for", () => {
    const r = buildScanReport(full());
    expect(r.complete).toBe(true);
    expect(r.percent).toBe(100);
    expect(r.stopReason).toBe("complete");
  });

  it("never reports 100% for a truncated census, only the real share", () => {
    // 381 of 480 opened: the live shape that was described as a complete scan.
    const r = buildScanReport(
      full({ matched: 480, opened: 381, remaining: 99, reachedEnd: false }),
    );
    expect(r.complete).toBe(false);
    expect(r.percent).toBe(79);
    expect(r.percent).not.toBe(100);
    expect(r.remaining).toBe(99);
  });

  it("caps at 99% when every message was opened but a document was unreadable", () => {
    // All matched messages read, but one PDF had no text layer: the coverage is
    // not clean, so this is NOT a 100% census.
    const r = buildScanReport(full({ unreadable: 1 }));
    expect(r.complete).toBe(false);
    expect(r.percent).toBe(99);
  });

  it("does not call an empty census complete when nothing was examined", () => {
    const r = buildScanReport(
      full({ matched: 0, opened: 0, pdfs: 0, results: 0, examined: 0, reachedEnd: true }),
    );
    expect(r.complete).toBe(false);
    expect(r.percent).toBe(0);
    // `examined === 0` is the connection case, not the search-term case.
    expect(r.stopReason).toBe("error");
  });

  it("calls a zero-match census complete when the mailbox WAS examined", () => {
    const r = buildScanReport(
      full({ matched: 0, opened: 0, pdfs: 0, results: 0, examined: 4399, reachedEnd: true }),
    );
    // The search ran over the whole mailbox and found nothing: that is a real,
    // finished answer — but it is still 0%, never 100.
    expect(r.complete).toBe(true);
    expect(r.percent).toBe(0);
    expect(r.stopReason).toBe("complete");
  });

  it("names the real stop reason for each shape", () => {
    expect(deriveStopReason(full({ reachedEnd: false, truncatedReason: "time" }), false)).toBe(
      "time",
    );
    expect(deriveStopReason(full({ reachedEnd: false, truncatedReason: "count" }), false)).toBe(
      "count",
    );
    expect(
      deriveStopReason(
        full({ matched: 0, opened: 0, pdfs: 0, results: 0, examined: 1910, reachedEnd: false }),
        false,
      ),
    ).toBe("no-match");
    expect(
      deriveStopReason(
        full({ matched: 100, opened: 40, pdfs: 0, results: 0, reachedEnd: false }),
        false,
      ),
    ).toBe("no-readable-files");
    expect(deriveStopReason(full({ cancelled: true }), false)).toBe("cancelled");
  });

  it("times the run from the session's own start, not the last window", () => {
    const r = buildScanReport(full({ startedAt: 1_000, now: 90_000, deadline: 120_000 }));
    expect(r.elapsedMs).toBe(89_000);
    expect(r.remainingMs).toBe(30_000);
  });

  it("renders every one of the ten answers, in order, with the caveat last", () => {
    const text = renderScanReport(
      buildScanReport(full({ matched: 480, opened: 381, remaining: 99, reachedEnd: false })),
    );
    expect(text).toContain("البحث عن: من EDC");
    expect(text).toContain("رسائل مطابقة: 480");
    expect(text).toContain("رسائل فُحصت: 3704");
    expect(text).toContain("رسائل فُتحت: 381");
    expect(text).toContain("ملفات PDF فُتحت: 332");
    expect(text).toContain("نتائج استُخرجت: 853");
    expect(text).toContain("الوقت المستغرق: 89 ثانية");
    expect(text).toContain("الحالة: جزئي");
    expect(text).toContain("سبب التوقف:");
    // The status line precedes the reason, so nothing is read without it.
    expect(text.indexOf("الحالة:")).toBeLessThan(text.indexOf("سبب التوقف:"));
  });

  it("flattens to progress keeping the legacy keys and adding the missing ones", () => {
    const p = scanReportProgress(buildScanReport(full()));
    // Legacy keys the dashboard and old rows already read.
    expect(p.scanned).toBe(3704);
    expect(p.items).toBe(853);
    expect(p.attachments).toBe(332);
    // The fields that were missing before.
    expect(p.elapsedSeconds).toBe(89);
    expect(p.remaining).toBe(0);
    expect(p.complete).toBe(true);
    expect(p.stopReason).toBe("complete");
    expect(String(p.stopReasonLabel)).toContain("اكتمل");
  });

  it("describes a connection failure differently from a wrong search term", () => {
    const conn = buildScanReport(
      full({ matched: 0, opened: 0, pdfs: 0, results: 0, examined: 0, reachedEnd: true }),
    );
    const term = buildScanReport(
      full({ matched: 0, opened: 0, pdfs: 0, results: 0, examined: 4399, reachedEnd: true }),
    );
    expect(describeStopReason(conn)).toContain("تعذّر الوصول");
    expect(describeStopReason(term)).toContain("4399");
    expect(describeStopReason(term)).not.toContain("الاتصال");
  });
});
