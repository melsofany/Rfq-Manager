import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import path from "path";
import { existsSync } from "fs";
import { getPool } from "@workspace/db";
import router from "./routes";
import { logger } from "./shared/logger";

const app: Express = express();
const isProd = process.env.NODE_ENV === "production";

// The session secret must come from the environment in production — never
// fall back to a value committed in the repo.
const sessionSecret = process.env.SESSION_SECRET;
if (isProd && !sessionSecret) {
  throw new Error(
    "SESSION_SECRET environment variable is required in production — refusing to start with the built-in fallback.",
  );
}

// Required for Render (and any reverse-proxy host) so that Express sees
// req.secure = true for HTTPS connections forwarded by the proxy.
// Without this, express-session refuses to set the Secure cookie because
// the internal Node↔proxy connection is plain HTTP.
app.set("trust proxy", 1);

// Security headers. CSP and COEP stay disabled: the SPA loads Google Fonts
// and other cross-origin assets, so a strict policy needs a dedicated pass.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

// CORS allowlist: the SPA served by this server (Origin host == Host header),
// any origins listed in ALLOWED_ORIGINS (comma-separated), and requests with
// no Origin header (webhooks, curl). Dev stays permissive for the Vite proxy.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use((req, res, next) => {
  cors({
    credentials: true,
    origin(origin, cb) {
      if (!origin || !isProd) return cb(null, true);
      try {
        if (new URL(origin).host === req.get("host")) return cb(null, true);
      } catch {
        // Malformed Origin header — fall through to the allowlist check.
      }
      return cb(null, allowedOrigins.includes(origin));
    },
  })(req, res, next);
});

// Sessions persist in PostgreSQL when a database is configured (survive
// restarts, shared across instances); otherwise fall back to in-memory for
// local dev only.
let sessionStore: session.Store | undefined;
if (process.env.DATABASE_URL) {
  const PgSession = connectPgSimple(session);
  sessionStore = new PgSession({
    pool: getPool(),
    tableName: "user_sessions",
    createTableIfMissing: true,
  });
} else {
  logger.warn("DATABASE_URL not set — using in-memory sessions (lost on restart)");
}

app.use(
  session({
    store: sessionStore,
    secret: sessionSecret || "rfq-dev-secret-change-in-prod",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd,
      // The SPA is same-origin; "lax" blocks cross-site POSTs carrying the
      // session cookie (CSRF mitigation) while keeping top-level navigation.
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
);

// Capture the raw request body for routes that need to verify Meta's
// X-Hub-Signature-256 webhook signature (see modules/communications/routes.ts).
app.use(
  express.json({
    limit: "50mb",
    verify: (req: Request & { rawBody?: string }, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use("/api", router);

if (process.env.NODE_ENV === "production") {
  const frontendDist = path.resolve(process.cwd(), "artifacts/rfq-portal/dist/public");
  if (existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get(/.*/, (_req, res) => {
      res.sendFile(path.join(frontendDist, "index.html"));
    });
  }
}

app.use((err: Error & { cause?: unknown }, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, "Unhandled error");
  const cause =
    err.cause instanceof Error
      ? { message: err.cause.message, code: (err.cause as NodeJS.ErrnoException).code }
      : err.cause
        ? String(err.cause)
        : undefined;
  res.status(500).json({ error: err.message, cause });
});

export default app;
