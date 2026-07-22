FROM node:22.15.1-slim

ENV YARN_NODE_LINKER=node-modules
ENV NODE_ENV=production

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    tini \
    curl \
    ca-certificates \
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

COPY LICENSE.md /LICENSE.md
COPY .yarnrc.yml ./
COPY package.json ./
COPY yarn.lock ./

COPY backend/apps/api/package.json ./backend/apps/api/package.json
COPY backend/apps/api/.yarnrc.yml ./backend/apps/api/.yarnrc.yml

RUN yarn workspaces focus --production @ci/be-api

COPY backend/apps/api/dist ./backend/apps/api/dist
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
