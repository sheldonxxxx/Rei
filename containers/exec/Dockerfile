# The execution plane: where the agent's read/write/edit/bash tools run. An ssh server as an unprivileged user and the
# tools a shell session needs. pi-env's daemon is not baked in: the control plane deploys it over ssh into the home
# directory (a tmpfs), so it matches the control plane's pi-env version after every start.
# Build from the repository root:  docker build -f containers/exec/Dockerfile -t rei/exec:dev .
# compose runs it hardened (read-only root, no capabilities, resource limits) on the exec-net network, which has no
# route to the internet: the egress proxy is the only way out (see containers/compose.yaml).
# The same image runs once as root (exec-keys) to generate the ssh keys into the two key volumes.
#
# Preinstalled for the agent's real work: Node 26 with npm, npx and corepack; uv (uv, uvx, uv tool run) with a Python it
# can use; and common CLI, document, and data tools. The root filesystem is read-only at run time, so everything the
# agent installs goes to its home (uv and npm caches) or /workspace; nothing can be installed system-wide at run time.
# The caches live in /home/agent/.cache, a volume compose mounts there (the rest of the home is a tmpfs), and the
# directory is created here owned by the agent so a fresh volume starts writable.

FROM node:26-trixie-slim AS node

FROM ghcr.io/astral-sh/uv:0.13.9 AS uv

FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server bash curl git python3 jq ripgrep ca-certificates coreutils procps \
      libreoffice-writer libreoffice-calc libreoffice-impress fonts-liberation fonts-noto-cjk \
      sqlite3 poppler-utils unzip zip xz-utils file less make wget \
 && rm -rf /var/lib/apt/lists/* \
 # sshd refuses accounts with a locked password even for key logins; "*" is "no password", not "locked".
 && useradd --create-home --uid 1000 --shell /bin/bash agent \
 && sed -i 's/^agent:!:/agent:*:/' /etc/shadow \
 && mkdir /workspace && chown 1000:1000 /workspace \
 && rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub
# Node 26 from the official image: node, npm, npx, corepack, yarn. The directories are copied whole so npm's relative
# symlinks keep resolving; the official image's /usr/local is otherwise the same as this base.
COPY --from=node /usr/local/bin /usr/local/bin
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
# uv and uvx (uvx is `uv tool run`). Python builds come from uv into a root-owned, world-readable directory so every
# user shares one copy, and uv's cache lives with npm's in /home/agent/.cache, a volume compose mounts there, while the
# rest of the home is the writable tmpfs pi-env is deployed into. The directories are created here owned by the agent so
# a fresh volume starts writable.
COPY --from=uv /uv /uvx /usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_PYTHON_PREFERENCE=managed \
    UV_TOOL_BIN_DIR=/home/agent/.local/bin \
    UV_CACHE_DIR=/home/agent/.cache/uv \
    NPM_CONFIG_CACHE=/home/agent/.cache/npm \
    PATH=/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
RUN env UV_CACHE_DIR=/tmp/uv-cache uv python install 3.13 --default \
 && rm -rf /tmp/uv-cache \
 && install -d -o 1000 -g 1000 -m 0700 /home/agent/.cache /home/agent/.cache/uv /home/agent/.cache/npm \
 && chmod -R a+rX /opt/uv \
 && node -v && npm -v && uv --version && uvx --version && python3 --version
# sshd builds each session's environment itself (UsePAM and PermitUserEnvironment are off), so the ENV above reaches
# `docker exec` and not the agent's shell. The caches are therefore configured in files npm and uv read on their own, or
# npm would cache in ~/.npm, which is the tmpfs. npm's global config file is $PREFIX/etc/npmrc (/usr/local), and uv's
# system config is /etc/uv/uv.toml; uv's default cache dir is already the volume path.
RUN install -d /etc/uv \
 && printf 'cache=/home/agent/.cache/npm\n' > /usr/local/etc/npmrc \
 && printf 'cache-dir = "/home/agent/.cache/uv"\n' > /etc/uv/uv.toml
COPY containers/exec/sshd_config /etc/ssh/sshd_config
COPY containers/exec/keys-init.sh /usr/local/bin/exec-keys-init
RUN chmod 755 /usr/local/bin/exec-keys-init
USER 1000:1000
WORKDIR /workspace
EXPOSE 2222
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/2222' || exit 1
# -D foreground, -e log to stderr (docker logs). Host key and authorized_keys come from the read-only exec-host volume.
CMD ["/usr/sbin/sshd", "-D", "-e", "-f", "/etc/ssh/sshd_config"]
