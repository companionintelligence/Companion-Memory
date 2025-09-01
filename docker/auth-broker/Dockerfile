FROM node:22-alpine AS base

# Install pnpm for Alpine
RUN apk add --no-cache libc6-compat && \
    corepack enable && \
    corepack prepare yarn@stable --activate

WORKDIR /app

# Copy package files
COPY package.json .yarnrc.yml yarn.lock ./
COPY .yarn ./.yarn

# Copy auth-broker specific files
COPY backend/apps/auth-broker/package.json ./backend/apps/auth-broker/
COPY backend/tsconfig.json ./backend/

# Install dependencies
RUN yarn install --immutable

# Development stage
FROM base AS development
WORKDIR /app
COPY backend/apps/auth-broker ./backend/apps/auth-broker
EXPOSE 3001
CMD ["yarn", "workspace", "@ci/auth-broker", "dev"]

# Build stage
FROM base AS build
COPY backend/apps/auth-broker ./backend/apps/auth-broker
RUN yarn workspace @ci/auth-broker build

# Production stage
FROM node:22-alpine AS production
RUN apk add --no-cache dumb-init && \
    corepack enable && \
    corepack prepare yarn@stable --activate

WORKDIR /app
USER node

# Copy built application
COPY --from=build --chown=node:node /app/backend/apps/auth-broker/dist ./
COPY --from=base --chown=node:node /app/node_modules ./node_modules
COPY --from=base --chown=node:node /app/backend/apps/auth-broker/package.json ./package.json

EXPOSE 3001
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "main.js"]