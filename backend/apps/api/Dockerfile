FROM node:22.15.1-slim

ENV YARN_NODE_LINKER=node-modules
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y tini && apt-get clean

RUN apt-get update && \
    apt-get install -y curl && \
    curl -fsSL https://github.com/amacneil/dbmate/releases/download/v2.27.0/dbmate-linux-amd64 \
        -o /usr/local/bin/dbmate && \
    chmod +x /usr/local/bin/dbmate

RUN corepack enable && corepack prepare yarn@4.9.1 --activate

WORKDIR /app

COPY .yarnrc.yml ./
COPY package.json ./
COPY yarn.lock ./
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
