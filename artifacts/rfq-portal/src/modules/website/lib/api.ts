/**
 * Shared types + API helpers for the website management page.
 *
 * The page edits a JSONB content document owned by the API. These types mirror
 * `lib/db/src/schema/website.ts` so the editor stays typed end to end.
 */

export interface WebsiteServiceItem {
  ar: string;
  en: string;
}

export interface WebsiteContent {
  hero: { headline: string; subheadline: string; ctaLabel: string; ctaUrl: string };
  about: { heading: string; headingEn: string; paragraphs: string[] };
  services: { heading: string; headingEn: string; items: WebsiteServiceItem[] };
  contact: {
    phone1: string;
    phone2: string;
    email: string;
    addressAr: string;
    addressEn: string;
    mapEmbedUrl: string;
  };
  social: { facebook: string; linkedin: string; whatsapp: string; instagram: string };
  seo: { title: string; description: string };
  announcement: { enabled: boolean; text: string; linkLabel: string; linkUrl: string };
}

export interface WebsiteSettingsView {
  enabled: boolean;
  maintenanceMode: boolean;
  maintenanceMessage: string | null;
  content: WebsiteContent;
  updatedBy: number | null;
  updatedAt: string | null;
  deployConfigured: boolean;
  deployConfigProblems: string[];
}

export interface WebsiteDeployStatus {
  configured: boolean;
  serviceId: string | null;
  status: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  url: string | null;
  error?: string;
}

export interface WebsiteDeployRow {
  id: number;
  serviceId: string;
  renderDeployId: string | null;
  status: string;
  trigger: string;
  commitSha: string | null;
  message: string | null;
  error: string | null;
  requestedBy: number | null;
  createdAt: string;
}

export async function apiGet<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  const body = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw Object.assign(new Error(body.error || `HTTP ${r.status}`), { data: body });
  return body as T;
}

export async function apiSend<T>(url: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { data });
  return data as T;
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString("en-GB");
  } catch {
    return s;
  }
}
