// Spike for ADR 0017 (render isolation). Runs inside a throwaway container on browser-net (see run.sh) and checks, against
// the real browser container, that a page rendered in a disposable browser context:
//   - sends every request (document, script fetches, images, worker fetches, WebSocket, local addresses) to a proxy we
//     name per context, never to the browser's global proxy;
//   - authenticates to that proxy with a per-job token answered over CDP (Fetch.authRequired), so the proxy knows the job;
//   - carries none of the profile's cookies, cannot keep a service worker, cannot download, and leaves nothing behind;
//   - is read back as HTML after its text stops changing.
// No dependencies: node 26 (global WebSocket). Prints one JSON report and exits 0 only when every check holds.
import http from "node:http";
import os from "node:os";

const BROWSER = process.env.BROWSER_ADDR ?? "10.89.232.2:9223";
const TOKEN = `r.spike${Date.now().toString(36)}.not-a-secret`;
const AUTH = `Basic ${Buffer.from(`rei:${TOKEN}`).toString("base64")}`;
const ALLOWED = new Set(["spike-page", "spike-cdn"]);
/** localhost:80 is served by the test site for the service-worker page; any other localhost port is refused. */
const allowed = (url) =>
  ALLOWED.has(url.hostname) || (url.hostname === "localhost" && (url.port === "" || url.port === "80"));
const self = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a && a.family === "IPv4" && !a.internal && a.address.startsWith("10.89.232."))?.address;
if (!self) throw new Error("not on browser-net");

// ---------- the test site (port 80; reached only through the proxy, under two host names) ----------
const site = [];
const PAGE = `<!doctype html><title>Spike app</title><body><div id=app>Loading…</div><div id=probes></div>
<img src="http://spike-cdn/pixel.gif"><video src="http://spike-cdn/clip.mp4" autoplay muted></video>
<style>@font-face { font-family: Spike; src: url(http://spike-cdn/font.woff2); } body { font-family: Spike, sans-serif; }</style>
<script>
const note = (k, v) => { const d = document.createElement('p'); d.id = k; d.textContent = k + '=' + v; probes.append(d); };
setTimeout(() => fetch('http://spike-cdn/api').then(r => r.json()).then(j => { app.textContent = 'Answer: ' + j.answer; }), 400);
new Worker('/worker.js').onmessage = (e) => note('worker', e.data);
navigator.serviceWorker?.register('/sw.js').then(() => note('sw', 'registered'), (e) => note('sw', 'failed:' + e.name));
try { const ws = new WebSocket('ws://spike-cdn/ws'); ws.onerror = () => note('ws', 'error'); ws.onopen = () => note('ws', 'open'); } catch (e) { note('ws', 'threw'); }
fetch('http://10.89.232.10:8787/api/health').then(() => note('control', 'reached'), () => note('control', 'blocked'));
fetch('http://169.254.169.254/latest/meta-data/').then(() => note('metadata', 'reached'), () => note('metadata', 'blocked'));
fetch('http://localhost:9222/json/version').then(() => note('loopback', 'reached'), () => note('loopback', 'blocked'));
note('cookie', JSON.stringify(document.cookie));
const a = document.createElement('a'); a.href = '/file.bin'; a.download = 'file.bin'; document.body.append(a); a.click();
</script>`;
// http://localhost is a secure context (http://spike-page is not, so it has no navigator.serviceWorker at all).
const SW_PAGE = `<!doctype html><title>SW</title><body><p id=out>waiting</p><script>
if (!navigator.serviceWorker) out.textContent = 'sw=unavailable';
else navigator.serviceWorker.register('/sw.js').then(() => { out.textContent = 'sw=registered'; }, (e) => { out.textContent = 'sw=failed:' + e.name; });
</script>`;
http
  .createServer((req, res) => {
    site.push({
      host: req.headers.host,
      path: req.url,
      cookie: req.headers.cookie ?? null,
      sw: req.headers["service-worker"] ?? null,
    });
    const send = (type, body, extra = {}) => {
      res.writeHead(200, { "content-type": type, "access-control-allow-origin": "*", ...extra });
      res.end(body);
    };
    if (req.url === "/") return send("text/html", PAGE, { "set-cookie": "page_cookie=1; Path=/" });
    if (req.url === "/sw-page") return send("text/html", SW_PAGE);
    if (req.url === "/api") return send("application/json", JSON.stringify({ answer: "rendered-by-js" }));
    if (req.url === "/pixel.gif") return send("image/gif", Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
    if (req.url === "/worker.js")
      return send(
        "text/javascript",
        "fetch('http://spike-cdn/from-worker').then(r=>postMessage('fetched:'+r.status),()=>postMessage('blocked'))",
      );
    if (req.url === "/sw.js") return send("text/javascript", "self.addEventListener('fetch',()=>{})");
    if (req.url === "/file.bin")
      return send("application/octet-stream", "x".repeat(1000), {
        "content-disposition": "attachment; filename=file.bin",
      });
    if (req.url === "/from-worker") return send("text/plain", "ok");
    res.writeHead(404).end();
  })
  .listen(80, "0.0.0.0");

// ---------- the per-context proxy (3130): token required, two allowed hosts, everything else refused ----------
const proxy = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url);
  const authed = req.headers["proxy-authorization"] === AUTH;
  const entry = {
    kind: "http",
    host: url.hostname,
    port: url.port,
    path: url.pathname,
    auth: authed ? "token" : req.headers["proxy-authorization"] ? "wrong" : "none",
  };
  proxy.push(entry);
  if (!authed) return res.writeHead(407, { "proxy-authenticate": 'Basic realm="rei-render"' }).end();
  if (!allowed(url)) {
    entry.verdict = "refused";
    return res.writeHead(403).end("refused");
  }
  entry.verdict = "allowed";
  const headers = { ...req.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  const up = http.request(
    { host: "127.0.0.1", port: 80, path: url.pathname + url.search, method: req.method, headers },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  up.on("error", () => res.writeHead(502).end());
  req.pipe(up);
});
server.on("connect", (req, socket) => {
  const authed = req.headers["proxy-authorization"] === AUTH;
  proxy.push({ kind: "connect", host: req.url, auth: authed ? "token" : "none", verdict: "refused" });
  socket.end(
    authed
      ? "HTTP/1.1 403 Forbidden\r\n\r\n"
      : 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="rei-render"\r\n\r\n',
  );
});
server.listen(3130, "0.0.0.0");

// ---------- a minimal CDP client (flat sessions) ----------
const version = await (await fetch(`http://${BROWSER}/json/version`)).json();
const wsUrl = version.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${BROWSER}`);
const ws = new WebSocket(wsUrl);
await new Promise((ok, fail) => {
  ws.onopen = ok;
  ws.onerror = fail;
});
let nextId = 1;
const pending = new Map();
const handlers = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { ok, fail } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? fail(new Error(`${msg.error.message}`)) : ok(msg.result);
  } else if (msg.method) for (const h of handlers) h(msg);
};
const send = (method, params = {}, sessionId) =>
  new Promise((ok, fail) => {
    const id = nextId++;
    pending.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const on = (fn) => handlers.push(fn);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const events = [];
const checks = {};

// A cookie in the user's profile (default context) for the test host: the render must never send it. Removed at the end.
await send("Storage.setCookies", {
  cookies: [{ name: "profile_secret", value: "1", domain: "spike-page", path: "/" }],
});

// The disposable context: its own proxy, nothing from the profile.
const { browserContextId } = await send("Target.createBrowserContext", {
  disposeOnDetach: true,
  proxyServer: `http://${self}:3130`,
  proxyBypassList: "<-loopback>",
});
await send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId, eventsEnabled: true });
on(
  (m) =>
    m.method?.startsWith("Browser.download") && events.push({ download: m.method, state: m.params.state ?? "begin" }),
);

// Every target in the context: requests paused, proxy auth answered with the job token, service-worker scripts failed,
// service-worker targets closed.
const sessions = new Set();
async function arm(sessionId, type) {
  sessions.add(sessionId);
  // No service workers: the API is gone in every frame before any page script runs. (The script fetch of a worker that
  // registers anyway does not pass the page's Fetch interception, and closing its target leaves the registration.)
  if (type === "page" || type === "iframe")
    await send(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source:
          "Object.defineProperty(Navigator.prototype, 'serviceWorker', { get: () => undefined, configurable: false });",
      },
      sessionId,
    ).catch((e) => events.push({ noScriptOn: type, error: e.message }));
  // Dedicated workers have no Fetch domain: their requests go through the context's proxy with the credentials the
  // context already holds (checked below), so a worker is only resumed.
  await send("Fetch.enable", { handleAuthRequests: true, patterns: [{ urlPattern: "*" }] }, sessionId).catch((e) =>
    events.push({ noFetchOn: type, error: e.message }),
  );
  await send(
    "Target.setAutoAttach",
    { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    sessionId,
  ).catch(() => {});
  if (type !== "page") await send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
}
on(async (m) => {
  const sid = m.sessionId;
  if (m.method === "Fetch.authRequired") {
    const proxyChallenge = m.params.authChallenge.source === "Proxy";
    events.push({ auth: m.params.authChallenge.source, url: m.params.request.url });
    await send(
      "Fetch.continueWithAuth",
      {
        requestId: m.params.requestId,
        authChallengeResponse: proxyChallenge
          ? { response: "ProvideCredentials", username: "rei", password: TOKEN }
          : { response: "CancelAuth" },
      },
      sid,
    ).catch(() => {});
  } else if (m.method === "Fetch.requestPaused") {
    const sw = m.params.request.headers?.["Service-Worker"] === "script";
    // Images, media and fonts never add text: they are failed before they leave the browser.
    if (["Image", "Media", "Font"].includes(m.params.resourceType)) {
      events.push({ mediaBlocked: m.params.resourceType, url: m.params.request.url });
      await send("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "BlockedByClient" }, sid).catch(
        () => {},
      );
    } else if (sw) {
      events.push({ swScriptFailed: m.params.request.url });
      await send("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "BlockedByClient" }, sid).catch(
        () => {},
      );
    } else await send("Fetch.continueRequest", { requestId: m.params.requestId }, sid).catch(() => {});
  } else if (m.method === "Target.attachedToTarget") {
    const { sessionId, targetInfo } = m.params;
    events.push({ attached: targetInfo.type });
    if (targetInfo.type === "service_worker") {
      await send("Target.closeTarget", { targetId: targetInfo.targetId }).catch(() => {});
      return;
    }
    await arm(sessionId, targetInfo.type).catch((e) => events.push({ armFailed: targetInfo.type, error: e.message }));
  }
});

const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await arm(sessionId, "page");
await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);
const started = Date.now();
await send("Page.navigate", { url: "http://spike-page/" }, sessionId);

// Stabilization: the body text has not changed for 1 s (polled every 250 ms), at most 20 s.
const text = async () =>
  (
    await send(
      "Runtime.evaluate",
      { expression: "document.body ? document.body.innerText : ''", returnByValue: true },
      sessionId,
    )
  ).result.value ?? "";
let last = "";
let stableSince = Date.now();
for (;;) {
  await sleep(250);
  const now = await text();
  if (now !== last) {
    last = now;
    stableSince = Date.now();
  } else if (Date.now() - stableSince >= 1000 && now !== "") break;
  if (Date.now() - started > 20_000) break;
}
const renderMs = Date.now() - started;
const html = (
  await send("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true }, sessionId)
).result.value;
const cookiesInContext = (await send("Storage.getCookies", { browserContextId })).cookies.map((c) => c.name);
await send("Page.navigate", { url: "http://localhost/sw-page" }, sessionId);
let swOut = "";
for (let i = 0; i < 20 && !swOut.startsWith("sw="); i++) {
  await sleep(250);
  swOut = await text();
}
const registrations = events.filter((e) => e.attached === "service_worker").length;

await send("Target.disposeBrowserContext", { browserContextId });
const contextsAfter = (await send("Target.getBrowserContexts")).browserContextIds;
const targetsAfter = (await send("Target.getTargets")).targetInfos.filter(
  (t) => t.browserContextId === browserContextId,
);
// Remove the test cookie from the profile again (an expiry in the past deletes it).
await send("Storage.setCookies", {
  cookies: [{ name: "profile_secret", value: "", domain: "spike-page", path: "/", expires: 1 }],
});
const profileLeft = (await send("Storage.getCookies", {})).cookies
  .filter((c) => c.domain.includes("spike"))
  .map((c) => c.name);
ws.close();

const probe = (k) => new RegExp(`${k}=([^<]*)`).exec(html)?.[1];
const authedHosts = new Set(proxy.filter((p) => p.auth === "token").map((p) => p.host));
checks.renderedByJs = html.includes("Answer: rendered-by-js");
checks.everyRequestReachedThisProxy =
  site.length > 0 &&
  site.every((s) =>
    proxy.some((p) => p.verdict === "allowed" && p.host === s.host?.split(":")[0] && p.path === s.path),
  );
checks.proxyAuthCarriesJobToken = proxy.some((p) => p.auth === "token") && proxy.every((p) => p.auth !== "wrong");
checks.mediaBlocked =
  ["Image", "Media", "Font"].every((t) => events.some((e) => e.mediaBlocked === t)) &&
  !site.some((r) => ["/pixel.gif", "/clip.mp4", "/font.woff2"].includes(r.path));
checks.subresourceHostsSeen = authedHosts.has("spike-page") && authedHosts.has("spike-cdn");
checks.workerFetchThroughProxy =
  proxy.some((p) => p.path === "/from-worker" && p.auth === "token") && probe("worker") === "fetched:200";
checks.localAddressesGoToProxyAndAreRefused =
  ["10.89.232.10", "169.254.169.254"].every((h) => proxy.some((p) => p.host === h && p.verdict === "refused")) &&
  proxy.some((p) => p.host === "localhost" && p.port === "9222" && p.verdict === "refused") &&
  probe("control") === "blocked" &&
  probe("metadata") === "blocked" &&
  probe("loopback") === "blocked";
checks.webSocketGoesToProxy =
  proxy.some((p) => p.kind === "connect" && p.host.startsWith("spike-cdn")) || proxy.some((p) => p.path === "/ws");
checks.noProfileCookieSent = site.every((s) => !s.cookie?.includes("profile_secret"));
checks.serviceWorkerBlocked =
  (swOut === "sw=unavailable" || swOut.startsWith("sw=failed")) &&
  registrations === 0 &&
  !site.some((s) => s.path === "/sw.js");
checks.downloadDenied = !events.some((e) => e.download && e.state === "completed");
checks.contextDisposed = !contextsAfter.includes(browserContextId) && targetsAfter.length === 0;
checks.profileCookieRemoved = profileLeft.length === 0;

const required = [
  "renderedByJs",
  "everyRequestReachedThisProxy",
  "proxyAuthCarriesJobToken",
  "subresourceHostsSeen",
  "mediaBlocked",
  "workerFetchThroughProxy",
  "localAddressesGoToProxyAndAreRefused",
  "webSocketGoesToProxy",
  "noProfileCookieSent",
  "serviceWorkerBlocked",
  "downloadDenied",
  "contextDisposed",
  "profileCookieRemoved",
];
const ok = required.every((k) => checks[k]);
console.log(
  JSON.stringify(
    {
      ok,
      chromium: version.Browser,
      renderMs,
      checks,
      serviceWorker: { swOut, registrations },
      probes: Object.fromEntries(
        ["worker", "sw", "ws", "control", "metadata", "loopback", "cookie"].map((k) => [k, probe(k)]),
      ),
      cookiesInContext,
      events,
      proxy,
      site,
    },
    null,
    2,
  ),
);
process.exit(ok ? 0 : 1);
