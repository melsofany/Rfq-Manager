import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import path from "path";
import { existsSync } from "fs";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Required for Render (and any reverse-proxy host) so that Express sees
// req.secure = true for HTTPS connections forwarded by the proxy.
// Without this, express-session refuses to set the Secure cookie because
// the internal Node↔proxy connection is plain HTTP.
app.set("trust proxy", 1);

app.use(pinoHttp({
  logger,
  serializers: {
    req(req) { return { id: req.id, method: req.method, url: req.url?.split("?")[0] }; },
    res(res) { return { statusCode: res.statusCode }; },
  },
}));

app.use(cors({ origin: true, credentials: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || "rfq-dev-secret-change-in-prod",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

// Capture the raw request body for routes that need to verify Meta's
// X-Hub-Signature-256 webhook signature (see routes/whatsapp.ts).
app.use(express.json({
  verify: (req: Request & { rawBody?: string }, _res, buf) => {
    req.rawBody = buf.toString("utf8");
  },
}));
app.use(express.urlencoded({ extended: true }));

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
  const cause = err.cause instanceof Error
    ? { message: err.cause.message, code: (err.cause as NodeJS.ErrnoException).code }
    : err.cause ? String(err.cause) : undefined;
  res.status(500).json({ error: err.message, cause });
});

export default app;
