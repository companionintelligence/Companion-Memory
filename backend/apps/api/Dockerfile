FROM node:22.15.1-slim

ENV YARN_NODE_LINKER=node-modules
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y tini git && apt-get clean

RUN apt-get update && \
    apt-get install -y curl && \
    curl -fsSL https://github.com/amacneil/dbmate/releases/download/v2.27.0/dbmate-linux-amd64 \
        -o /usr/local/bin/dbmate && \
    chmod +x /usr/local/bin/dbmate

# Install Playwright system dependencies
RUN apt-get update && \
    apt-get install -y \
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

RUN corepack enable && corepack prepare yarn@4.9.1 --activate

WORKDIR /app

COPY .yarnrc.yml ./
COPY package.json ./
COPY yarn.lock ./

# Create MCP servers directory and copy source files
COPY mcp-servers ./mcp-servers

# Build web-search server
RUN if [ -d "./mcp-servers/web-search" ] && [ -f "./mcp-servers/web-search/package.json" ]; then \
        cd ./mcp-servers/web-search && \
        npm ci --production=false && \
        npm run build && \
        PLAYWRIGHT_BROWSERS_PATH=/app/mcp-servers/web-search/playwright-browsers npx playwright install --with-deps; \
    fi

COPY backend/apps/api/package.json ./backend/apps/api/package.json
COPY backend/apps/api/.yarnrc.yml ./backend/apps/api/.yarnrc.yml

RUN yarn workspaces focus --production @ci/be-api

COPY backend/apps/api/dist ./backend/apps/api/dist
COPY backend/apps/api/config ./backend/apps/api/config
COPY backend/apps/api/db ./backend/apps/api/db

WORKDIR /app/backend/apps/api

EXPOSE 3030

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/main.js"]
