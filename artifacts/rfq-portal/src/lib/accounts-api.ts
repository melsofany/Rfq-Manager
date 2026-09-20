/**
 * Tiny JSON client for the accounting endpoints.
 *
 * These routes are NOT part of the OpenAPI spec, so they are called with a
 * plain `fetch` rather than the generated orval client. This wrapper keeps the
 * session cookie, sets the JSON content-type on writes, and turns a non-OK
 * response into an Error carrying the server's `{error}` message — so callers
 * can keep using `getApiErrorMessage(err, fallback)`.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body != null;
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? body.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Convenience wrappers around `apiFetch` for the common verbs. */
export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "POST", body: body == null ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "PUT", body: body == null ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "PATCH", body: body == null ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => apiFetch<T>(path, { method: "DELETE" }),
};

/** Build a query string from a record, skipping empty values. */
export function queryString(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
