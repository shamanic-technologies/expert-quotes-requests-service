# Stage 1: Builder
FROM node:20-slim AS builder

WORKDIR /app

# pnpm pinned to 9: pnpm 10+ fails the install with ERR_PNPM_IGNORED_BUILDS
# (esbuild install script not approved). Same pin as the rest of the fleet.
RUN npm install -g pnpm@9

COPY package.json pnpm-lock.yaml* ./

RUN pnpm install --frozen-lockfile || pnpm install

COPY . .

RUN pnpm build

# Stage 2: Production
FROM node:20-slim

WORKDIR /app

RUN npm install -g pnpm@9

COPY package.json pnpm-lock.yaml* ./

RUN pnpm install --prod --frozen-lockfile || pnpm install --prod

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/openapi.json ./openapi.json

ENV NODE_OPTIONS="--dns-result-order=ipv4first"

CMD ["node", "--import", "./dist/instrument.js", "dist/index.js"]
