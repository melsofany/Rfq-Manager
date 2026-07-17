/**
 * Augment Express to type route params as `Record<string, string>`.
 * In Express 5 / @types/express@5 the default is `string | string[]`
 * which causes TS2345/TS2769 everywhere params are forwarded to
 * Drizzle `eq()` or `parseInt()`. Route params in practice are always
 * a single string, so this augmentation is safe.
 */
declare namespace Express {
  interface Request {
    params: Record<string, string>;
  }
}
