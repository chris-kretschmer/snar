# syntax=docker/dockerfile:1

# ---- Builder: compiles better-sqlite3 against musl (Alpine has no
#      prebuilt binaries for that) – the build toolchain stays entirely in
#      this stage and never ends up in the runtime image ----
# Base image pinned by digest (Dependabot proposes newer digests, see .github/dependabot.yml).
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ---- Runtime: slim image without the build toolchain ----
# tzdata: stats are bucketed in server local time ('localtime'); without
# zone info, TZ=Europe/Berlin would be ignored inside the Alpine container.
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85
RUN apk add --no-cache libstdc++ tzdata \
 && mkdir -p /data && chown -R node:node /data
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
VOLUME /data
EXPOSE 3000
USER node
# /healthz answers only if the database does; the port follows PORT.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1
CMD ["node", "src/server.js"]
