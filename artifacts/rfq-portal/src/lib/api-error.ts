// Extracts a human-readable message from an orval/customFetch ApiError.
// The generated client throws ApiError (not Axios), so the server's JSON
// error body lives in `err.data.error` (not `err.response.data.error`).
// `err.message` is a fallback like "HTTP 500 : <detail>".
export function getApiErrorMessage(err: unknown, fallback = "حدث خطأ غير متوقع"): string {
  const e = err as { data?: { error?: string; message?: string }; message?: string };
  return e?.data?.error ?? e?.data?.message ?? e?.message ?? fallback;
}
