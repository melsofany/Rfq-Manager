// Resolves the public origin used to build supplier pricing links (emailed /
// WhatsApped to suppliers). Priority:
//   1) BASE_URL env var (explicit override)
//   2) REPLIT_DOMAINS env var (legacy)
//   3) The incoming request's protocol + host (works behind Render's proxy as
//      long as `trust proxy` is set) — the safe default so links don't point
//      at localhost.
//   4) localhost:PORT last-resort fallback.
export function resolvePublicBaseUrl(req?: {
  protocol?: string;
  get?: (name: string) => string | undefined;
}): string {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, "");

  if (process.env.REPLIT_DOMAINS) {
    return `https://${process.env.REPLIT_DOMAINS.split(",")[0]}`;
  }

  const proto = req?.protocol ?? "http";
  const host = req?.get?.("host");
  if (host) return `${proto}://${host}`;

  return `http://localhost:${process.env.PORT ?? 10000}`;
}
