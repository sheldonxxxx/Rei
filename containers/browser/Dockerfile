# The agent computer's browser: one headed Chromium on a virtual display (Xvfb, no window manager, no VNC), with your
# persistent profile. The control plane drives it over the DevTools protocol and you
# watch and take over a session's window from the PWA through that window's own screencast, so nothing here serves a desktop.
# Debian's own chromium package (arm64 and amd64).
# Build from the repository root:  docker build -f containers/browser/Dockerfile -t rei/browser:dev containers/browser
# compose runs it hardened on the browser-net network: the egress proxy's browser listener is its only way out.

FROM debian:trixie-slim@sha256:89c1ea91e897f0fe0a3731595330bc45b8bdef4047464a07116f891a94054b31
# fonts: Latin, CJK (Cantonese, Mandarin and Japanese pages) and colour emoji, or the page picture is full of boxes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium xvfb socat tini ca-certificates procps \
      fonts-dejavu-core fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man /var/cache/apt \
 && useradd --create-home --uid 1000 --shell /usr/sbin/nologin browser \
 && mkdir /profile && chown 1000:1000 /profile
COPY entrypoint.sh wake.sh /usr/local/bin/
RUN chmod 755 /usr/local/bin/entrypoint.sh /usr/local/bin/wake.sh
USER 1000:1000
ENV DISPLAY=:99 HOME=/home/browser
EXPOSE 9223
# Chromium only binds the DevTools port to loopback; socat answers on 9223 for the control plane and starts Chromium on
# a connection (wake.sh), and entrypoint.sh stops it after BROWSER_IDLE_STOP_S with no client. The check must not wake it,
# so it looks only at the display and the forwarder, never at Chromium.
HEALTHCHECK --interval=10s --timeout=4s --start-period=20s --retries=3 \
  CMD bash -c '[ -S /tmp/.X11-unix/X99 ] && pgrep -f "TCP-LISTEN:922[3]" >/dev/null' || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
