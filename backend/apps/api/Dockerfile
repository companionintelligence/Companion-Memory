# ──────────────────────────────────────────────────
# Stage 1 — builder
#
# Compiles the API from source inside the image. The
# previous single-stage build copied a dist/ that had
# been compiled on the host, so a local image and a
# production image were produced by two different
# processes. Nothing from this stage reaches the
# runtime image except dist/.
# ──────────────────────────────────────────────────
FROM node:22.15.1-slim AS builder

# Both .yarnrc.yml files in this repo pin `nodeLinker: pnp`, and a nested
# rc file outranks the root one. A YARN_* environment variable outranks
# every rc file — that override is the only reason a node-modules install
# wins here. Keep this alongside any .yarnrc.yml copy.
ENV YARN_NODE_LINKER=node-modules

RUN corepack enable && corepack prepare yarn@4.9.1 --activate

WORKDIR /app

# Manifests first. This layer changes only when a dependency changes, so
# the install below is reused across source-only rebuilds.
COPY .yarnrc.yml ./
COPY package.json ./
COPY yarn.lock ./

COPY backend/apps/api/package.json ./backend/apps/api/package.json
COPY backend/apps/api/.yarnrc.yml ./backend/apps/api/.yarnrc.yml
# @ci/tool-core is a workspace DEPENDENCY of @ci/be-api, so `workspaces focus`
# cannot resolve without its manifest present. Its own devDependencies
# (jest, eslint) are not focused and are not needed: `tsc --build` below runs
# the API's compiler over the referenced project.
COPY backend/packages/tool-core/package.json ./backend/packages/tool-core/package.json

# The full (non-production) dependency set for this one workspace:
# typescript and tsc-alias are devDependencies. Deliberately not
# `--immutable` — yarn.lock also covers workspaces that are absent from
# this build context, so yarn has to be free to narrow the resolution.
RUN yarn workspaces focus @ci/be-api

# Sources last. tsconfig.json compiles `src` and `scripts` (see its
# `include`) and it DOES extend the repo-root presets, so those two files
# are part of the build context whether or not they look like source.
# Without them tsc fails at config-load time with a message about a
# missing extends target, before it reads a single .ts file.
#
# It also now REFERENCES @ci/tool-core, a composite project. `tsc --build`
# builds that first and compiles the API against its emitted .d.ts, which
# is what keeps this image's dist/ laid out as dist/src/... — the path the
# CMD at the bottom names. Its sources therefore belong in this stage.
COPY tsconfig.base.json tsconfig.node.json ./
COPY backend/packages/tool-core/tsconfig.json backend/packages/tool-core/tsconfig.build.json ./backend/packages/tool-core/
COPY backend/packages/tool-core/src ./backend/packages/tool-core/src
COPY backend/apps/api/tsconfig.json ./backend/apps/api/tsconfig.json
COPY backend/apps/api/src ./backend/apps/api/src
COPY backend/apps/api/scripts ./backend/apps/api/scripts

WORKDIR /app/backend/apps/api

# `tsc --build && tsc-alias` — see the `build` script in package.json.
RUN yarn build

# ──────────────────────────────────────────────────
# Stage 2 — runtime
# ──────────────────────────────────────────────────
FROM node:22.15.1-slim AS runtime

ENV YARN_NODE_LINKER=node-modules
ENV NODE_ENV=production

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    tini \
    curl \
    ca-certificates \
    # The import domain shells out to both. `unzip` streams the 40-50GB Google
    # Takeout / Apple Photos splits that cannot fit the in-memory extractor, and
    # without it every archive at or above 1GB throws. `ffmpeg` ships `ffprobe`,
    # the only source of container creation time, QuickTime GPS, bitrate and
    # codec for video — and the sole capture-time source for sidecar-less
    # Takeout videos, which otherwise fall back to archive mtime and land in the
    # wrong place on the timeline. It also backs the media-dimensions and
    # video-thumbnail stages outside import. `poppler-utils` ships `pdftotext`,
    # which the Hulu importer needs: that export is a PDF and nothing else.
    unzip \
    ffmpeg \
    poppler-utils \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libexpat1 \
    libxcb1 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    libwayland-client0 \
    && rm -rf /var/lib/apt/lists/*

# TARGETARCH is set by BuildKit (amd64 on x86 builders, arm64 on arm builders);
# fall back to dpkg for non-BuildKit builds. dbmate ships both architectures.
ARG TARGETARCH
RUN ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" && \
    curl -fsSL "https://github.com/amacneil/dbmate/releases/download/v2.27.0/dbmate-linux-${ARCH}" \
        -o /usr/local/bin/dbmate && \
    chmod +x /usr/local/bin/dbmate

RUN corepack enable && corepack prepare yarn@4.9.1 --activate

WORKDIR /app

COPY .yarnrc.yml ./
COPY package.json ./
COPY yarn.lock ./

COPY backend/apps/api/package.json ./backend/apps/api/package.json
COPY backend/apps/api/.yarnrc.yml ./backend/apps/api/.yarnrc.yml
COPY backend/packages/tool-core/package.json ./backend/packages/tool-core/package.json

RUN yarn workspaces focus --production @ci/be-api

# The Makefile's `distribute-license` step puts LICENSE.md where the build
# context can see it. Copied after the install so a license change does not
# invalidate the dependency layer.
COPY LICENSE.md /LICENSE.md

COPY --from=builder /app/backend/apps/api/dist ./backend/apps/api/dist
# @ci/tool-core resolves to its own dist/ at runtime (package.json `main`), so
# the compiled package has to come across too — the API's dist holds only a
# require() of the workspace, not a copy of it.
COPY --from=builder /app/backend/packages/tool-core/dist ./backend/packages/tool-core/dist
COPY backend/apps/api/config ./backend/apps/api/config
COPY backend/apps/api/db ./backend/apps/api/db
COPY backend/apps/api/bin ./backend/apps/api/bin
COPY --chmod=755 backend/apps/api/entrypoint.sh ./backend/apps/api/entrypoint.sh

WORKDIR /app/backend/apps/api

EXPOSE 3030

# ──────────────────────────────────────────────────
# Environment Variables
#
# Secrets are loaded from a shared secrets file or
# from environment variables set by Docker Compose.
# Non-secret config (hosts, ports) lives in the
# application layer (config/default.json).
#
# Required (no default — will not start without these):
#   AUTH_CSRF_TOKEN_SECRET     CSRF token signing secret
#   AUTH_FIELD_ENCRYPTION_KEY  Symmetric key for field-level encryption
#   AUTH_REFRESH_TOKEN_SECRET  JWT refresh token signing secret
#   AUTH_SESSION_PEPPER        Pepper for session hash derivation
#   AUTH_TOKEN_SECRET          JWT access token signing secret
#   DATABASE_PASSWORD          PostgreSQL password
#   OBJECT_STORE_PASSWORD      MinIO / S3 secret key
#   OBJECT_STORE_USERNAME      MinIO / S3 access key
#
# Optional:
#   SECRETS_FILE               Path to secrets file [/run/secrets/.env.secrets]
# ──────────────────────────────────────────────────

ENTRYPOINT ["/usr/bin/tini", "--", "./entrypoint.sh"]
CMD ["node", "dist/src/main.js"]
