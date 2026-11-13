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
import admsRouter from "./modules/hr/adms";
import {
  proxyChatwootRequest,
  chatwootProxyTarget,
  chatwootProxyMount,
  chatwootConsoleGuard,
  chatwootOwnsPath,
  chatwootRequiresAuth,
} from "./modules/chatwoot/proxy";
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

// ─── Chatwoot console, served on OUR origin under a path prefix ──────────────
//
// Mounted HERE — before the body parsers — because the console uploads files
// and posts forms: `express.json()` would consume the stream and the proxy
// would forward an empty body. It is also the reason the mount sits outside
// `/api`: the console's own `/api/v1` must never collide with Cortoba's router.
//
// Serving the console from our own origin is not a preference. `onrender.com`
// is on the Public Suffix List, so the gateway and the Chatwoot service are
// DIFFERENT SITES; a console framed from the second into the first is a
// third-party frame and its session cookie is refused. First-party hosting is
// what makes the embedded login work, and it lets the Chatwoot service itself
// stay PRIVATE with no public entry point.
const chatwootConsoleBase = chatwootProxyMount();
const chatwootTarget = chatwootProxyTarget();
if (chatwootTarget && chatwootConsoleBase) {
  // At the root, `app.use("/")` would match EVERY request, so the console is
  // filtered to its own path space and everything else falls through to the API
  // and the SPA. `chatwootOwnsPath` is the single description of that space.
  const handler = (req: Request, res: Response, next: NextFunction): void => {
    proxyChatwootRequest(req, res, {
      target: chatwootTarget,
      prefix: chatwootConsoleBase,
    }).catch(next);
  };
  const guard = chatwootConsoleGuard();
  const gate = (req: Request, res: Response, next: NextFunction): void => {
    if (!chatwootOwnsPath(req.path)) return next();
    // Static assets carry no business data and are requested dozens of times per
    // page. Charging the guard — a database lookup — to each one returned 401
    // for the console's own JS and made every screen slow. Supplier data still
    // goes through the guard.
    if (!chatwootRequiresAuth(req.path)) return handler(req, res, next);
    guard(req, res, () => handler(req, res, next));
  };
  app.use(chatwootConsoleBase, gate);
  logger.info(
    { target: chatwootTarget, at: chatwootConsoleBase },
    "Chatwoot console proxy mounted",
  );
}

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

// ZKTeco ADMS push endpoints, mounted at the ROOT.
//
// `/iclock/*` is hard-coded in the firmware — a device never sends the `/api`
// prefix — so mounting the router only under `/api` meant the device's
// handshake landed on the SPA fallback and received HTML instead of its config.
// The router is declared AFTER the global parsers because those leave
// `req.body` undefined for a Content-Type they do not match, and the router
// reads the raw tab-separated payload itself with its own `express.text`
// (`type: () => true`), so no ZKTeco body labelling can defeat it.
app.use(admsRouter);

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
