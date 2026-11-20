/**
 * Reading an application's documents.
 *
 * Every extraction is PERSISTED (`supplier_applications.ocr_results`), keyed by
 * document id, so a reviewer who reopens a file does not pay for a second model
 * call. That matters twice over: the media model is metered, and a reviewer who
 * waits 20 seconds every time he clicks a tab stops using the screen.
 *
 * A document is re-read only when its bytes change (a new upload replaces the
 * row) — the cache key includes the document id and the byte length, so a
 * same-id re-upload cannot be served the old reading.
 */
import { pool } from "@workspace/db";
import { logger } from "../../shared/logger";
import { extractDocumentText, isReadableDocumentMime } from "../ai-assistant/llm";
import { GEMINI_BASE_URL, GEMINI_MEDIA_MODEL, isAiConfigured } from "../ai-assistant/config";
import { parseExtraction, SUPPLIER_DOC_PROMPT, type DocumentExtraction } from "./ocr";

/** The slots the portal uploads, in the order the reviewer wants them. */
export const DOC_SLOT_LABELS: Record<string, string> = {
  commercial_register: "السجل التجاري",
  tax_card: "البطاقة الضريبية",
  vat_certificate: "شهادة التسجيل الضريبي",
  bank_letter: "خطاب البنك",
  national_id_card: "بطاقة الرقم القومي",
  previous_invoice: "فاتورة ضريبية سابقة",
  previous_work: "أعمال سابقة",
  purchase_order: "أمر توريد",
  contract: "عقد",
  quotation: "عرض سعر",
  catalog: "كتالوج",
  agency_certificate: "شهادة وكالة / توزيع",
  additional: "مستند إضافي",
};

export function docLabel(slot: string | null | undefined): string {
  const key = (slot ?? "").trim();
  return DOC_SLOT_LABELS[key] ?? (key || "مستند");
}

/** Slots whose contents are expected to prove an identity field. */
export const IDENTITY_SLOTS = ["commercial_register", "tax_card", "vat_certificate"] as const;

/** Slots that prove TRADE ACTIVITY rather than identity. */
export const ACTIVITY_SLOTS = [
  "previous_invoice",
  "previous_work",
  "purchase_order",
  "contract",
  "quotation",
  "catalog",
  "agency_certificate",
] as const;

interface CachedReading {
  /** Byte length at read time — a re-upload with different bytes invalidates. */
  size: number;
  extraction: DocumentExtraction;
  readAt: string;
}

type OcrCache = Record<string, CachedReading>;

async function loadCache(applicationId: number): Promise<OcrCache> {
  const { rows } = await pool.query<{ ocr_results: OcrCache | null }>(
    `SELECT ocr_results FROM supplier_applications WHERE id = $1`,
    [applicationId],
  );
  return rows[0]?.ocr_results ?? {};
}

async function saveCache(applicationId: number, cache: OcrCache): Promise<void> {
  await pool.query(`UPDATE supplier_applications SET ocr_results = $2::jsonb WHERE id = $1`, [
    applicationId,
    JSON.stringify(cache),
  ]);
}

export interface DocumentReading {
  id: number;
  slot: string;
  label: string;
  originalName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  extraction: DocumentExtraction;
  /** True when this call actually contacted the model. */
  freshlyRead: boolean;
}

/**
 * Read every readable document of an application.
 *
 * `force` re-reads even when a cache entry exists — the reviewer's «أعد الفحص»
 * button. Unreadable slots are still returned with `unreadable: true`, because
 * the console must show the reviewer WHICH file it could not read rather than
 * silently omitting it.
 */
/**
 * How many documents are read at once.
 *
 * Measured live: one vision call takes 4–41s depending on which model in the
 * chain answers, so eight documents read SEQUENTIALLY would hold the reviewer
 * for minutes — long enough that he stops using the screen. A small cap keeps
 * the wall clock near the slowest single call without opening eight streams at
 * a metered endpoint.
 */
const READ_CONCURRENCY = 4;

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function readApplicationDocuments(
  applicationId: number,
  opts: { force?: boolean; docIds?: number[] } = {},
): Promise<DocumentReading[]> {
  const { rows } = await pool.query<{
    id: number;
    slot: string;
    original_name: string;
    mime_type: string | null;
    size_bytes: number | null;
    content: string;
  }>(
    `SELECT id, slot, original_name, mime_type, size_bytes, content
       FROM supplier_application_documents
      WHERE application_id = $1
      ORDER BY uploaded_at ASC, id ASC`,
    [applicationId],
  );

  const wanted = opts.docIds?.length ? rows.filter((r) => opts.docIds!.includes(r.id)) : rows;
  const cache = await loadCache(applicationId);
  const readings: DocumentReading[] = [];
  let cacheChanged = false;

  const results = await mapLimit(wanted, READ_CONCURRENCY, async (row) => {
    const key = String(row.id);
    const size = row.size_bytes ?? Math.floor((row.content?.length ?? 0) * 0.75);
    const cached = cache[key];
    if (cached && cached.size === size && !opts.force) {
      return {
        id: row.id,
        slot: row.slot,
        label: docLabel(row.slot),
        originalName: row.original_name,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        extraction: cached.extraction,
        freshlyRead: false,
      } satisfies DocumentReading;
    }
    const extraction = await readOne(row.content, row.mime_type);
    cache[key] = { size, extraction, readAt: new Date().toISOString() };
    cacheChanged = true;
    return {
      id: row.id,
      slot: row.slot,
      label: docLabel(row.slot),
      originalName: row.original_name,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      extraction,
      freshlyRead: true,
    } satisfies DocumentReading;
  });
  readings.push(...results);

  if (cacheChanged) {
    try {
      await saveCache(applicationId, cache);
    } catch (err) {
      // A failed cache write costs a future re-read, not a wrong answer.
      logger.warn({ err, applicationId }, "OCR cache write failed (non-fatal)");
    }
  }
  return readings;
}

/** Read one document. Never throws — a failure becomes an `unreadable` reading. */
async function readOne(
  contentBase64: string,
  mimeType: string | null,
): Promise<DocumentExtraction> {
  const failure: DocumentExtraction = {
    companyName: null,
    taxRegistration: null,
    commercialRegister: null,
    activity: null,
    issuedAt: null,
    expiresAt: null,
    items: [],
    brands: [],
    issuer: null,
    invoiceValue: null,
    unreadable: true,
    confidence: null,
    rawText: null,
  };
  if (!isAiConfigured) return failure;
  if (!contentBase64) return failure;
  const mime = (mimeType ?? "").toLowerCase();
  if (!isReadableDocumentMime(mime)) return failure;

  try {
    const buffer = Buffer.from(contentBase64, "base64");
    const text = await extractDocumentText(
      buffer,
      mime,
      GEMINI_BASE_URL,
      GEMINI_MEDIA_MODEL,
      SUPPLIER_DOC_PROMPT,
    );
    if (!text) return failure;
    // The model is asked for JSON; `parseExtraction` accepts a fenced or
    // embedded block and marks a reply with no JSON as unreadable rather than
    // reporting «no differences» for a file nobody actually read.
    return parseExtraction(text);
  } catch (err) {
    logger.warn({ err }, "supplier document OCR failed");
    return failure;
  }
}

/** Re-exported so the route and the prompt stay in one place. */
export { SUPPLIER_DOC_PROMPT };
