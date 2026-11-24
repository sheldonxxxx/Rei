# The policy gateway (D30): the only container that holds credentials and the only one with internet access.
# Build from the repository root:  docker build -f containers/gateway/Dockerfile -t rei/gateway:dev .
# Run (read-only root filesystem; /data is the only writable path):
#   docker run --rm --read-only -v rei-gateway-data:/data \
#     -e REI_STANDIN="$(head -c 24 /dev/urandom | base64)" -p 8780:8780 rei/gateway:dev
# Sign in once, with the gateway stopped (publishes the OAuth callback port; see apps/gateway/src/cli.ts). In the compose
# stack, sign in from the web app instead:
#   docker run --rm -it -p 127.0.0.1:1455:1455 -v rei-gateway-data:/data rei/gateway:dev node src/cli.ts login

# ---- production dependencies of the gateway workspace only (the lockfile pins every version) --------------------------
FROM node:24.22.1-alpine3.24 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/logging/package.json packages/logging/
COPY apps/gateway/package.json apps/gateway/
COPY apps/server/package.json apps/server/
COPY apps/egress/package.json apps/egress/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund -w @rei/gateway && npm cache clean --force
# pi-ai lists SDKs for providers the gateway never uses (about 40 MB). Drop them, and fail the build if the modules the
# gateway does use stop loading without them.
RUN rm -rf node_modules/@anthropic-ai node_modules/@google node_modules/@aws-sdk node_modules/@smithy \
 && node --input-type=module -e "const m = await import('@earendil-works/pi-ai/models'); const p = await import('@earendil-works/pi-ai/providers/openai'); const ms = m.createModels(); ms.setProvider(p.openaiProvider()); await import('@earendil-works/pi-ai/api/openai-responses'); if (!ms.getModels('openai').length) process.exit(1);"

# ---- runtime ------------------------------------------------------------------------------------------------------
FROM node:24.22.1-alpine3.24
# A dedicated unix user, distinct from the control plane's, so neither can read the other's files.
RUN addgroup -g 1100 -S gateway \
 && adduser -u 1100 -G gateway -S -H -h /nonexistent -s /sbin/nologin gateway \
 && mkdir /data && chown 1100:1100 /data && chmod 700 /data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/protocol/src ./packages/protocol/src
COPY packages/logging/package.json ./packages/logging/package.json
COPY packages/logging/src ./packages/logging/src
COPY apps/gateway/package.json ./apps/gateway/package.json
COPY --chown=1100:1100 apps/gateway/src ./apps/gateway/src
WORKDIR /app/apps/gateway
ENV NODE_ENV=production \
    GATEWAY_DATA=/data \
    GATEWAY_PORT=8780 \
    GATEWAY_IN_CONTAINER=1
USER 1100:1100
VOLUME /data
EXPOSE 8780
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${GATEWAY_PORT}/healthz" || exit 1
CMD ["node", "src/main.ts"]
