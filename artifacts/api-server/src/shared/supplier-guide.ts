/**
 * The supplier pricing guide — ONE path, so the three places that hand it out
 * cannot disagree.
 *
 * The guide is published by the portal as a static file and is referenced from
 * the WhatsApp greeting (as the document header), the greeting email (as an
 * attachment) and the RFQ email (as a link). Three hand-written copies of the
 * URL would drift, and a guide that 404s is worse than no guide: the supplier
 * is told a document exists that he cannot open.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Public path of the guide, as served by the portal's `public/` folder. */
export const SUPPLIER_GUIDE_PATH = "/supplier-pricing-guide.pdf";

/**
 * Absolute path of the bundled guide.
 *
 * Two candidates, as `payslip-pdf.ts` does: the esbuild bundle copies
 * `src/assets/*` to `dist/assets/*`, while a source run (tests, `tsx`) resolves
 * two levels up from the module. Returning the first EXISTING one is what makes
 * both work; guessing a single path breaks one of them.
 */
export function supplierGuidePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "assets", "supplier-pricing-guide.pdf"),
    resolve(here, "..", "..", "assets", "supplier-pricing-guide.pdf"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/**
 * The guide bytes, or null when the file is missing.
 *
 * Null rather than a throw, and never a placeholder: a greeting must still go
 * out when the guide is absent (the message itself is the important part), but
 * it must NOT claim to attach a guide it does not have. The caller drops the
 * document header and says so in the log.
 */
export function loadSupplierGuide(): Buffer | null {
  try {
    return readFileSync(supplierGuidePath());
  } catch {
    return null;
  }
}

/** Public URL of the guide, for the email link. */
export function supplierGuideUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${SUPPLIER_GUIDE_PATH}`;
}
