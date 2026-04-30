FROM node:22.15.1-slim

ENV YARN_NODE_LINKER=node-modules
ENV NODE_ENV=production

RUN apt-get update && \
    apt-get install -y --no-install-recommends tini ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare yarn@4.9.1 --activate

WORKDIR /app

COPY LICENSE /LICENSE
COPY .yarnrc.yml ./
COPY package.json ./
COPY yarn.lock ./

COPY backend/apps/mcp/package.json ./backend/apps/mcp/package.json

RUN yarn workspaces focus --production @ci/be-mcp

COPY backend/apps/mcp/dist ./backend/apps/mcp/dist
COPY --chmod=755 backend/apps/mcp/entrypoint.sh ./backend/apps/mcp/entrypoint.sh

WORKDIR /app/backend/apps/mcp

EXPOSE 3091

ENTRYPOINT ["/usr/bin/tini", "--", "./entrypoint.sh"]
CMD ["node", "dist/src/main.js"]
