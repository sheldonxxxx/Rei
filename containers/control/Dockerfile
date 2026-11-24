# The control plane (app server): password + TOTP login, agents and sessions, the Pi session trees, and the built PWA.
# It holds no model credentials: it sends a stand-in token to the gateway, which swaps in the real one (D30).
# It also drives the sandbox: ssh (openssh-client) into the exec container with pi-env, and answers the egress proxy's
# "may this host be reached?" over a unix socket.
# Build from the repository root, after building the web app (npm run build -w @rei/web):
#   docker build -f containers/control/Dockerfile -t rei/control:dev .
# Run (read-only root filesystem; /data is the only writable path):
#   docker run --rm --read-only --tmpfs /tmp -v rei-control-data:/data \
#     -e GATEWAY_URL=http://gateway:8780 -e REI_STANDIN=<the gateway's token> -p 8787:8787 rei/control:dev
# The first start prints "Rei setup code: ..." in the log (also in /data/setup-code.txt); open the PWA and use it once.
# Offline smoke test (no gateway): add  -e REI_MODEL_MODE=faux  and drop GATEWAY_URL.
# HOME is /tmp (the only writable place besides /data) because ssh keeps its state under it. The sandbox settings
# (REI_EXEC and friends) come from containers/compose.yaml; without them the agent gets no coding tools.
# The health check calls the address the server listens on: compose binds it to the internal network's address, so
# that the sandbox, which shares exec-net with this container, finds nothing listening there.

# ---- production dependencies of the server workspace only (the lockfile pins every version) -------------------------
FROM node:26.13.1-alpine3.24 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/logging/package.json packages/logging/
COPY packages/network/package.json packages/network/
COPY apps/server/package.json apps/server/
COPY apps/gateway/package.json apps/gateway/
COPY apps/egress/package.json apps/egress/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund -w @rei/server && npm cache clean --force
# pi-ai lists SDKs for providers this server never uses (about 40 MB). Drop them, and fail the build if the modules the
# server does use stop loading without them.
# Code mode runs scripts in a worker thread with QuickJS (WebAssembly): the engine, its worker file and the wasm must
# survive the production install; the server runs unbundled, so the packages find them by their own paths.
# pi-env ships its daemon for eight platforms (about 17 MB). The sandbox is Linux, so keep linux x64 and arm64 and fail
# the build if either goes missing (pi-env picks the one matching the exec container, not this one).
RUN rm -rf node_modules/@anthropic-ai node_modules/@google node_modules/@aws-sdk node_modules/@smithy \
 && node --input-type=module -e "const m = await import('@earendil-works/pi-ai/models'); const p = await import('@earendil-works/pi-ai/providers/openai'); await import('@earendil-works/pi-ai/providers/faux'); const ms = m.createModels(); ms.setProvider(p.openaiProvider()); await import('@earendil-works/pi-ai/api/openai-responses'); await import('@earendil-works/pi-ai/utils/event-stream'); await import('@earendil-works/pi-durable'); await import('@earendil-works/pi-env'); await import('@earendil-works/pi-durable/codemode'); await import('@earendil-works/pi-codemode'); await import('hono'); await import('@hono/node-server'); if (!ms.getModels('openai').length) process.exit(1);" \
 && test -f node_modules/quickjs-wasi/quickjs.wasm && test -f node_modules/@earendil-works/pi-codemode/dist/runtime/worker.js \
 && cd node_modules/@earendil-works/pi-env/bin \
 && rm -rf pi-env-darwin-* pi-env-android-* pi-env-windows-* \
 && test -x pi-env-linux-x64/pi-env && test -x pi-env-linux-arm64/pi-env && test "$(ls | wc -l)" = 2

# ---- runtime ------------------------------------------------------------------------------------------------------
FROM node:26.13.1-alpine3.24
# A dedicated unix user, distinct from the gateway's (1100), so neither can read the other's files.
# (The base image's own "node" user owns uid/gid 1000, so it goes first.)
RUN deluser --remove-home node && delgroup node 2>/dev/null; \
    addgroup -g 1000 -S control \
 && adduser -u 1000 -G control -S -H -h /nonexistent -s /sbin/nologin control \
 && mkdir /data && chown 1000:1000 /data && chmod 700 /data
# ssh into the sandbox. /run/egress holds the unix socket the egress proxy asks for decisions on (a volume shared with
# the egress container, whose user is also uid 1000); creating it here gives an empty volume the right owner.
RUN apk add --no-cache openssh-client \
 && mkdir /run/egress && chown 1000:1000 /run/egress
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY --chown=1000:1000 packages/protocol/src ./packages/protocol/src
COPY --chown=1000:1000 packages/protocol/catalog ./packages/protocol/catalog
COPY --chown=1000:1000 packages/protocol/vendor ./packages/protocol/vendor
COPY packages/logging/package.json ./packages/logging/package.json
COPY --chown=1000:1000 packages/logging/src ./packages/logging/src
COPY packages/network/package.json ./packages/network/package.json
COPY --chown=1000:1000 packages/network/src ./packages/network/src
COPY apps/server/package.json ./apps/server/package.json
COPY --chown=1000:1000 apps/server/src ./apps/server/src
COPY apps/web/dist ./web
WORKDIR /app/apps/server
ENV NODE_ENV=production \
    REI_DATA=/data \
    REI_HOST=0.0.0.0 \
    REI_PORT=8787 \
    REI_WEB_DIST=/app/web \
    HOME=/tmp \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
USER 1000:1000
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null "http://${REI_HOST}:${REI_PORT}/api/health" || exit 1
CMD ["node", "src/main.ts"]
