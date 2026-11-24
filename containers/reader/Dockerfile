# The shared web reader: fetches a page through its own forward proxy, extracts the text, and (from ticket 2 on) renders
# pages that need JavaScript. Debian (glibc) rather than Alpine, because the Moli engine is a glibc binary.
# Build from the repository root:  docker build -f containers/reader/Dockerfile -t rei/reader:dev .
# Run read-only; /data (render attempts) is the only writable volume, and /tmp (browser profiles) a tmpfs. It listens on 8790 for the gateway,
# the only service on its network, and connects out through a second network.

# ---- production dependencies of the reader workspace only --------------------------------------------------------------
FROM node:26.13.1-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/logging/package.json packages/logging/
COPY packages/network/package.json packages/network/
COPY packages/forward-proxy/package.json packages/forward-proxy/
COPY apps/reader/package.json apps/reader/
COPY apps/server/package.json apps/server/
COPY apps/gateway/package.json apps/gateway/
COPY apps/egress/package.json apps/egress/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund -w @rei/reader && npm cache clean --force

# ---- Moli: the pinned release binary, checked against its published checksum -----------------------------------------------
FROM node:26.13.1-trixie-slim AS moli
ARG TARGETARCH
ARG MOLI_VERSION=1.1.25
ARG MOLI_SHA256_ARM64=95c094a0214431193ee93142dec91cc7affbea79e9b35094213b8b9230ccd134
ARG MOLI_SHA256_AMD64=04c73204626054c9ec0064f7fc00abb0dcfa7f8b9c3ec9df5de8e2afc301087f
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      arm64) triple=aarch64-unknown-linux-gnu; sha="$MOLI_SHA256_ARM64" ;; \
      amd64) triple=x86_64-unknown-linux-gnu; sha="$MOLI_SHA256_AMD64" ;; \
      *) echo "no Moli build for $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /moli.tgz "https://github.com/lexmount/moli/releases/download/v${MOLI_VERSION}/moli-${triple}.tar.gz"; \
    echo "${sha}  /moli.tgz" | sha256sum -c -; \
    mkdir /moli && tar -xzf /moli.tgz -C /moli --strip-components=1; \
    test -x /moli/moli

# ---- runtime ------------------------------------------------------------------------------------------------------
FROM node:26.13.1-trixie-slim
# libfontconfig1: Moli's one shared-library dependency that the slim base lacks. chromium: Debian's own package, the
# fallback engine (arm64 and amd64).
RUN apt-get update \
 && apt-get install -y --no-install-recommends libfontconfig1 chromium ca-certificates \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man /var/cache/apt \
 && groupadd -g 1200 reader \
 && useradd -u 1200 -g reader -M -d /nonexistent -s /usr/sbin/nologin reader \
 && mkdir /data && chown 1200:1200 /data && chmod 700 /data
COPY --from=moli /moli/moli /usr/local/bin/moli
COPY --from=moli /moli/LICENSE-APACHE /moli/LICENSE-MIT /usr/share/licenses/moli/
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Workspace packages are symlinked by npm ci; Node will not strip types from a file whose real path is under
# node_modules, so the packages are copied to where the links point.
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/protocol/src ./packages/protocol/src
COPY packages/logging/package.json ./packages/logging/package.json
COPY packages/logging/src ./packages/logging/src
COPY packages/network/package.json ./packages/network/package.json
COPY packages/network/src ./packages/network/src
COPY packages/forward-proxy/package.json ./packages/forward-proxy/package.json
COPY packages/forward-proxy/src ./packages/forward-proxy/src
COPY apps/reader/package.json ./apps/reader/package.json
COPY --chown=1200:1200 apps/reader/src ./apps/reader/src
WORKDIR /app/apps/reader
ENV NODE_ENV=production \
    READER_DATA=/data \
    READER_PORT=8790 \
    READER_MOLI_PATH=/usr/local/bin/moli \
    READER_CHROMIUM_PATH=/usr/bin/chromium \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
USER 1200:1200
VOLUME /data
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.READER_PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/main.ts"]
