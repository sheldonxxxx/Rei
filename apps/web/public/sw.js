// Service worker: caches the app shell only. /api (REST and the SSE streams) is never cached and never touched.
const CACHE = "rei-shell-v0.0.1-engawa";
// Push and notification clicks: the handlers live in their own file so tests can load them (see push-handlers.js).
importScripts("/push-handlers.js");

const SHELL = ["/", "/manifest.webmanifest", "/theme-init.js", "/rei-icon-32.png", "/rei-icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("push", (event) => self.reiPush.onPush(event, self));
self.addEventListener("notificationclick", (event) => self.reiPush.onNotificationClick(event, self));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/api") return; // never cache the API or streams
  if ((req.headers.get("accept") || "").includes("text/event-stream")) return;

  if (req.mode === "navigate") {
    // Network first so a new deploy shows up; fall back to the cached shell when offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("/", copy));
          }
          return res;
        })
        .catch(() => caches.match("/").then((r) => r || Response.error())),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    // Hashed build output is immutable: cache first.
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Other shell files (icons, manifest): stale-while-revalidate.
  if (SHELL.includes(url.pathname)) {
    event.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => hit || Response.error());
        return hit || net;
      }),
    );
  }
});
