/** Shared helpers for the email settings and mailbox pages. */

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body as T;
}
