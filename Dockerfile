# syntax=docker/dockerfile:1

# ============================================================================
# Cortoba RFQ Manager — production image
#
# The deployment unit is the API server, which also serves the built portal
# from `artifacts/rfq-portal/dist/public` (see app.ts). One image, one port:
# the same process the Render service runs today, so local and hosted behave
# identically.
#
# Build is two-stage so the runtime layer carries no compilers, no dev
# dependencies and no source — only the bundled server, the portal's static
# files, and the external packages esbuild deliberately left unbundled.
# ============================================================================

# ── Stage 1: build ─────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# pnpm's store is on the same layer as the install, so it can be pruned after.
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# Manifests first: dependency installation is the slow, rarely-changing step,
# so it is cached until a lockfile actually changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY artifacts/api-server/package.json artifacts/api-server/
COPY artifacts/rfq-portal/package.json artifacts/rfq-portal/
COPY lib/api-client-react/package.json lib/api-client-react/
COPY lib/api-spec/package.json lib/api-spec/
COPY lib/api-zod/package.json lib/api-zod/
COPY lib/db/package.json lib/db/
COPY scripts/package.json scripts/

# `--ignore-scripts` blocks lifecycle hooks from executing during install;
# only the packages on pnpm's `onlyBuiltDependencies` allowlist are then built
# explicitly. This keeps a compromised transitive dependency from running code
# at install time.
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json tsconfig.json ./
COPY lib ./lib
COPY artifacts ./artifacts
COPY scripts ./scripts

# Compile the shared libs, bundle the server, and build the portal. The portal
# build is what `app.ts` serves in production, so it must exist in the image.
RUN pnpm run typecheck:libs \
    && pnpm --filter @workspace/api-server run build \
    && pnpm --filter @workspace/rfq-portal run build

# ── Stage 2: runtime ───────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10 --activate

# curl is used by the container HEALTHCHECK below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the manifests plus the built output cross into the runtime image. The
# server bundle keeps some dependencies external (bcrypt, express-session,
# googleapis, …), so production dependencies must still be installed here.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY artifacts/api-server/package.json artifacts/api-server/
COPY artifacts/rfq-portal/package.json artifacts/rfq-portal/
COPY lib/api-client-react/package.json lib/api-client-react/
COPY lib/api-spec/package.json lib/api-spec/
COPY lib/api-zod/package.json lib/api-zod/
COPY lib/db/package.json lib/db/
COPY scripts/package.json scripts/

RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
    && pnpm store prune

COPY --from=build /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=build /app/artifacts/rfq-portal/dist ./artifacts/rfq-portal/dist
# The compiled libs are runtime dependencies of the unbundled externals.
COPY --from=build /app/lib ./lib

# The image runs as an unprivileged user; nothing in the app writes to disk
# except through the database, so ownership only needs to cover the code.
RUN useradd --system --uid 10001 --create-home appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8080

# Render injects PORT; 8080 matches the value the service already uses.
ENV PORT=8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/api/healthz" || exit 1

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
