# The egress proxy: the only way out of the sandbox. Its dependencies are the workspace's own @rei/logging, @rei/network
# and @rei/forward-proxy (plain TypeScript, no dependencies of their own), copied in and linked by hand, so there is nothing to install.
# Build from the repository root:  docker build -f containers/egress/Dockerfile -t rei/egress:dev .
# It listens on 3128 inside exec-net, asks the control plane over a unix socket in the egress-sock volume whether a host
# may be reached, and connects out through its second network (egress-out). Run read-only, no capabilities.

FROM node:26.13.1-alpine3.24
# The socket directory. The image's own "node" user is uid/gid 1000, the same uid the control plane runs as, which is
# what lets the two containers share the socket in the volume.
RUN mkdir /run/egress && chown 1000:1000 /run/egress
WORKDIR /app
COPY packages/logging/package.json ./packages/logging/package.json
COPY packages/logging/src ./packages/logging/src
# A symlink, as npm makes for a workspace: Node will not strip types from a file whose real path is under node_modules.
COPY packages/network/package.json ./packages/network/package.json
COPY packages/network/src ./packages/network/src
COPY packages/forward-proxy/package.json ./packages/forward-proxy/package.json
COPY packages/forward-proxy/src ./packages/forward-proxy/src
RUN mkdir -p node_modules/@rei && ln -s ../../packages/logging node_modules/@rei/logging \
 && ln -s ../../packages/network node_modules/@rei/network \
 && ln -s ../../packages/forward-proxy node_modules/@rei/forward-proxy
WORKDIR /app/apps/egress
COPY apps/egress/package.json ./package.json
COPY apps/egress/src ./src
ENV NODE_ENV=production \
    EGRESS_PORT=3128 \
    EGRESS_DECIDE_SOCKET=/run/egress/decide.sock \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
USER 1000:1000
EXPOSE 3128
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('node:net').connect(Number(process.env.EGRESS_PORT), '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))"
CMD ["node", "src/main.ts"]
