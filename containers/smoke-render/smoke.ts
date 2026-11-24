// The render checks for the shared reader (ADR 0017's red-team suite, moved with the browsers). Runs inside a throwaway
// container of the reader image on an internal docker network (see run.sh), once per engine: SMOKE_ENGINE=moli|chromium.
// It uses the reader's real engine driver, its real extractor and its real proxy in "render" mode with its real job
// tokens (apps/reader/src/node/jobs.ts: ports, local networks, connection cap, revocation).
//
// The one stand-in is where names resolve: the fixture site lives on this container's own address, so
// `*.fixture.example` resolve here and, when the real decision allows them, are let into that one private address
// (localNetworks "all"). Every other host gets the real decision and the real resolver unchanged, so the attack pages'
// targets (the engine's own DevTools, a gateway address, the metadata address, loopback, a name that rebinds into the
// stack) meet exactly what production does. Prints PASS/FAIL lines and exits 1 if any check failed.
import { execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { createEgressProxy } from "@rei/forward-proxy";
import { createLogger } from "@rei/logging";
import { extractHtml } from "./src/core/extract.ts";
import { type EngineRequest, type RenderEngine, RenderFailure } from "./src/core/render.ts";
import { ChromiumEngine, MoliEngine } from "./src/node/engines.ts";
import { createJobTokens } from "./src/node/jobs.ts";

const ENGINE = process.env.SMOKE_ENGINE ?? "";
if (ENGINE !== "moli" && ENGINE !== "chromium") throw new Error("SMOKE_ENGINE must be moli or chromium");
const DEVTOOLS_PORT = 9222; // the engine is started with this port so the attack page can aim at it
const self = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a && a.family === "IPv4" && !a.internal)?.address;
if (!self) throw new Error("no network address");
const GATEWAY_IP = self.replace(/\.\d+$/, ".1"); // the docker network's own gateway address, a stand-in for a neighbour

// Strings that must never show up in a rendered page.
const SECRET = "INTERNAL-SECRET-7f3a"; // served only at /secret, which only an attack reaches
const PASSWD = "root:x:0:0";

// ---- the fixture site -----------------------------------------------------------------------------------------------
type Hit = { host: string; path: string; cookie: string | null; at: number };
const served: Hit[] = [];
const upgrades: Hit[] = [];
let streamClosedAt = 0;
const ARTICLE = "The ridge trail opens at dawn and closes at dusk in winter. ".repeat(6);
const page = (body: string, title = "Loading", head = "") =>
  `<!doctype html><html><head><title>${title}</title>${head}</head><body><div id="root"></div>${body}</body></html>`;

// Every attack the page can try on its own, each written to the page as `name=outcome`. Nothing here may succeed.
const ATTACKS = `
const out = [];
const note = (name, value) => { out.push(name + '=' + value); root.textContent = out.join(' | '); };
const read = async (name, url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000), credentials: 'include' });
    note(name, 'status ' + r.status + ' ' + (await r.text()).slice(0, 200));
  } catch (e) { note(name, 'failed'); }
};
const socket = (name, url) => new Promise((done) => {
  try {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { note(name, 'no answer'); done(); }, 4000);
    ws.onopen = () => { clearTimeout(t); note(name, 'OPEN'); ws.close(); done(); };
    ws.onerror = () => { clearTimeout(t); note(name, 'failed'); done(); };
  } catch (e) { note(name, 'failed'); done(); }
});
(async () => {
  await Promise.all([
    read('devtools', 'http://127.0.0.1:${DEVTOOLS_PORT}/json/version'),
    read('devtools80', 'http://${GATEWAY_IP}/json/version'),
    read('control', 'http://${GATEWAY_IP}:8790/healthz'),
    read('metadata', 'http://169.254.169.254/latest/meta-data/'),
    read('metadata-name', 'http://metadata.attack.example/latest/meta-data/'),
    read('rebind', 'http://rebind.attack.example/secret'),
    read('loopback', 'http://127.0.0.1/secret'),
    read('localhost', 'http://localhost/secret'),
    read('loopback-devtools', 'http://localhost:${DEVTOOLS_PORT}/json/version'),
    read('ipv6-loopback', 'http://[::1]/secret'),
    read('port', 'http://api.fixture.example:8080/secret'),
    read('file', 'file:///etc/passwd'),
    socket('ws-fixture', 'ws://ws.fixture.example/'),
    socket('ws-control', 'ws://${GATEWAY_IP}:8790/'),
    read('container-name', 'http://reader/healthz'),
    read('container-name-gw', 'http://gateway/'),
    new Promise((done) => {
      // A worker is not reached by the page's document-start script: its WebSocket must be stopped another way.
      const code = "try { const ws = new WebSocket('ws://ws.fixture.example/worker'); ws.onopen = () => postMessage('OPEN'); ws.onerror = () => postMessage('failed'); } catch (e) { postMessage('failed'); }";
      const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      const t = setTimeout(() => { note('ws-worker', 'no answer'); done(); }, 4000);
      w.onmessage = (m) => { clearTimeout(t); note('ws-worker', m.data); done(); };
    }),
  ]);
  note('cookie', document.cookie === '' ? 'none' : 'PRESENT ' + document.cookie);
  note('serviceWorker', navigator.serviceWorker ? 'PRESENT' : 'absent');
  note('rtc', typeof RTCPeerConnection === 'undefined' && typeof webkitRTCPeerConnection === 'undefined' ? 'absent' : 'PRESENT');
  const a = document.createElement('a'); a.href = 'http://app.fixture.example/redteam-download.bin'; a.download = 'redteam-download.bin';
  document.body.appendChild(a); a.click();
  note('done', 'yes');
})();`;

const pages: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => [string, string] | undefined> = {
  // ---- ticket 09: what a render must do
  "/app": () => [
    "text/html",
    page(`<img src="http://cdn.fixture.example/pixel.gif"><style>@font-face{font-family:F;src:url(http://cdn.fixture.example/f.woff2)}body{font-family:F}</style>
<script>setTimeout(() => fetch('http://api.fixture.example/article').then(r => r.json()).then(j => {
  document.title = j.title; root.innerHTML = '<article><h1>' + j.title + '</h1><p>' + j.text + '</p></article>'; }), 300);</script>`),
  ],
  "/article": () => ["application/json", JSON.stringify({ title: "Trail guide", text: ARTICLE })],
  "/pixel.gif": () => ["image/gif", "GIF89a"],
  "/f.woff2": () => ["font/woff2", "x"],
  "/ticker": () => [
    "text/html",
    page("<script>let n = 0; setInterval(() => { root.textContent = 'tick ' + n++; }, 150);</script>"),
  ],
  "/heavy": () => [
    "text/html",
    page('<p id="static">Static text before the script.</p><script src="http://cdn.fixture.example/big.js"></script>'),
  ],
  "/big.js": () => ["text/javascript", `/*${"x".repeat(400_000)}*/ root.textContent = 'big script ran';`],
  // ---- ticket 10: what a rendered page must not be able to do
  "/attack": () => ["text/html", page(`<script>${ATTACKS}</script>`)],
  "/secret": () => ["text/plain", SECRET],
  // State a render must not leave behind for the next one: a cookie, localStorage and a service worker slot.
  "/setstate": (_req, res) => {
    res.writeHead(200, { "content-type": "text/html", "set-cookie": "left_behind=1; Path=/" });
    res.end(
      page(
        "<script>document.cookie = 'left_behind_js=1; path=/'; localStorage.setItem('left_behind', '1'); root.textContent = 'state set';</script>",
      ),
    );
    return undefined;
  },
  "/readstate": () => [
    "text/html",
    page(
      "<script>root.textContent = 'cookie=' + (document.cookie || 'none') + ' storage=' + (localStorage.getItem('left_behind') ?? 'none');</script>",
    ),
  ],
  "/redteam-download.bin": (_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment" });
    res.end("download");
    return undefined;
  },
  // A file:// document in a frame, and a page that tries to navigate itself to one.
  "/file-frame": () => [
    "text/html",
    page(`<iframe src="file:///etc/passwd"></iframe><script>setTimeout(() => {
  let seen = 'unreadable'; try { seen = document.querySelector('iframe').contentDocument.body.innerText; } catch (e) {}
  root.textContent = 'frame says: ' + (seen || 'nothing'); }, 500);</script>`),
  ],
  "/file-nav": () => [
    "text/html",
    page("<script>setTimeout(() => { location.href = 'file:///etc/passwd'; }, 200);</script>"),
  ],
  // Redirects and navigations to a host the policy does not allow.
  "/leave": () => [
    "text/html",
    page("<script>setTimeout(() => { location.href = 'http://denied.attack.example/'; }, 200);</script>"),
  ],
  "/redirect": (_req, res) => {
    res.writeHead(302, { location: "http://denied.attack.example/landing" });
    res.end();
    return undefined;
  },
  "/refresh": () => [
    "text/html",
    page(
      "<p>Moving…</p>",
      "Moving",
      '<meta http-equiv="refresh" content="0;url=http://denied.attack.example/refresh">',
    ),
  ],
  // A bot check that only appears once its script runs: it must be read as a wall, never as the page's content.
  "/captcha": () => [
    "text/html",
    page(`<script>setTimeout(() => { document.title = 'Just a moment...';
  root.innerHTML = '<div id="challenge-running"><h1>Verify you are human</h1><p>Checking if the site connection is secure. ' +
    'Complete the security check to continue.</p><div class="cf-turnstile" data-sitekey="x"></div></div>'; }, 300);</script>`),
  ],
  // A page that keeps working: a request every 100 ms and a response that never ends.
  "/busy": () => [
    "text/html",
    page(`<script>let n = 0; setInterval(() => { fetch('http://api.fixture.example/beacon?n=' + n++).catch(() => {}); root.textContent = 'beat ' + n; }, 100);
fetch('http://api.fixture.example/stream').then(r => r.body.getReader()).then(async (rd) => { for (;;) { const { done } = await rd.read(); if (done) break; } }).catch(() => {});</script>`),
  ],
  "/beacon": () => ["text/plain", "ok"],
  "/stream": (req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
    const timer = setInterval(() => res.write("."), 100);
    req.socket.on("close", () => {
      clearInterval(timer);
      streamClosedAt = Date.now();
    });
    return undefined;
  },
};
const site = http.createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0]!;
  served.push({ host: String(req.headers.host ?? ""), path, cookie: req.headers.cookie ?? null, at: Date.now() });
  const make = pages[path];
  if (!make) return void res.writeHead(404).end();
  const answer = make(req, res);
  if (!answer) return;
  res.writeHead(200, { "content-type": answer[0], "access-control-allow-origin": "*" });
  res.end(answer[1]);
});
site.on("upgrade", (req, socket) => {
  upgrades.push({ host: String(req.headers.host ?? ""), path: req.url ?? "", cookie: null, at: Date.now() });
  socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
});
await new Promise<void>((r) => site.listen(80, "0.0.0.0", r));

// ---- the real job tokens and the real proxy ------------------------------------------------------------------------
const quiet = createLogger({ service: "reader", write: () => {} });
const tokens = {
  normal: createJobTokens(),
  small: createJobTokens({ limits: { maxConnections: 200, maxBytes: 20_000 } }),
};
const issuer = new Map<string, keyof typeof tokens>(); // token -> the set that issued it

const FIXTURE = /\.fixture\.example$/;
const asked: { token: string; host: string; port: number; source?: string; decision: string }[] = [];
const proxy = createEgressProxy({
  source: "render",
  decide: async (request, signal) => {
    const token = "token" in request ? request.token : "";
    const answer = await tokens[issuer.get(token) ?? "normal"].decide(request, signal);
    asked.push({ ...(request as never), decision: answer.decision });
    // The fixture site is on this container's private address; let the allowed fixture names into it, nothing else.
    if (answer.decision === "allow" && FIXTURE.test(request.host)) return { ...answer, localNetworks: "all" };
    return answer;
  },
  resolve: async (host) => {
    if (FIXTURE.test(host)) return [self];
    if (host === "rebind.attack.example") return [self]; // a public-looking name that resolves into the stack
    if (host === "metadata.attack.example") return ["169.254.169.254"];
    if (host === "denied.attack.example") return [self];
    return []; // the network has no route out and no DNS: nothing else resolves
  },
  refuse: [],
  log: quiet,
});
await new Promise<void>((r) => proxy.listen(0, "0.0.0.0", r));
const proxyAddress = `${self}:${(proxy.address() as AddressInfo).port}`;

// ---- running a render the way the reader does ------------------------------------------------------------------------
const engine: RenderEngine & { contextCount?: () => Promise<number> } =
  ENGINE === "moli"
    ? new MoliEngine({
        binary: process.env.READER_MOLI_PATH ?? "/usr/local/bin/moli",
        proxy: proxyAddress,
        port: DEVTOOLS_PORT,
      })
    : new ChromiumEngine({
        binary: process.env.READER_CHROMIUM_PATH ?? "/usr/bin/chromium",
        proxy: proxyAddress,
        port: DEVTOOLS_PORT,
      });
let failures = 0;
const report = (what: string, ok: boolean, detail?: unknown) => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  [${ENGINE}] ${what}${!ok && detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`,
  );
  if (!ok) failures++;
};
/** Fixture hosts pass; anything else is refused, like a host the caller did not allow. */
const fixturesOnly = (url: string) => {
  try {
    const u = new URL(url);
    if ((u.protocol === "http:" || u.protocol === "https:") && FIXTURE.test(u.hostname)) return undefined;
    return `The page sends the browser to ${u.hostname || u.protocol}, which is not allowed.`;
  } catch {
    return "The page sent the browser to an address that cannot be fetched.";
  }
};
type Extra = Partial<EngineRequest> & { small?: boolean };
const render = async (url: string, extra: Extra = {}) => {
  const set = extra.small ? "small" : "normal";
  const deadlineMs = extra.deadlineMs ?? 20_000;
  const job = tokens[set].open({ kind: "render", deadlineMs: deadlineMs + 5_000 });
  issuer.set(job.token, set);
  const started = Date.now();
  try {
    const result = await engine.render({
      url,
      token: job.token,
      deadlineMs,
      maxHtmlChars: 5 * 1024 * 1024,
      checkNavigation: fixturesOnly,
      signal: new AbortController().signal,
      ...extra,
    });
    return { ...result, token: job.token, started };
  } finally {
    job.revoke();
  }
};
const failure = async (url: string, extra: Extra = {}) => {
  try {
    const result = await render(url, extra);
    return { result, error: undefined as unknown };
  } catch (error) {
    return { result: undefined, error };
  }
};
// Warm the engine (Chromium starts once and stays up) so the context count below means something.
await render("http://app.fixture.example/article").catch(() => undefined);
const before = (await engine.contextCount?.()) ?? 0;

console.log("-- rendering (what a render must do)");
{
  const result = await render("http://app.fixture.example/app");
  const extracted = extractHtml(result.html, result.finalUrl);
  report(
    "a JS-only page is rendered and read by the extractor",
    extracted.quality === "success" && extracted.text.includes("The ridge trail opens at dawn"),
    { quality: extracted.quality, text: extracted.text.slice(0, 120) },
  );
  report("it is read once its text settles", result.ended === "stable" && result.ms < 10_000, result);
  report(
    "the page and its API call on another host went through the render listener with the job's token",
    ["app.fixture.example", "api.fixture.example"].every((h) =>
      asked.some((a) => a.host === h && a.token === result.token && a.source === "render" && a.decision === "allow"),
    ),
  );
  report(
    "images and fonts were failed in the browser and never requested",
    // Chromium requests them and the render fails them; Moli never fetches images or fonts at all.
    (ENGINE === "moli" || result.blockedMedia >= 2) &&
      !served.some((s) => s.path === "/pixel.gif" || s.path === "/f.woff2"),
    { blockedMedia: result.blockedMedia },
  );
}
{
  const started = Date.now();
  const result = await render("http://app.fixture.example/ticker", { deadlineMs: 2_000 });
  report(
    "a page that never settles is read at the deadline",
    result.ended === "deadline" && Date.now() - started < 6_000 && result.html.includes("tick"),
    { ended: result.ended, ms: Date.now() - started },
  );
}
{
  const result = await render("http://app.fixture.example/heavy", { small: true, deadlineMs: 5_000 });
  report(
    "the job's byte budget cuts its traffic, and the page is read with what it had",
    !result.html.includes("big script ran") && result.html.includes("Static text before the script."),
    { html: result.html.slice(0, 200) },
  );
}

console.log("-- red team (what a rendered page must not be able to do)");
{
  const mark = asked.length;
  const servedMark = served.length;
  const result = await render("http://app.fixture.example/attack");
  const text = extractHtml(result.html, result.finalUrl).text;
  const outcome = (name: string) => new RegExp(`${name}=([^|]*)`).exec(text)?.[1]?.trim() ?? "missing";
  report("the attack page ran all of its attempts", outcome("done") === "yes", text.slice(0, 400));
  for (const [name, what] of [
    ["devtools", "the browser's DevTools endpoint"],
    ["devtools80", "the browser container on port 80"],
    ["control", "the control plane"],
    ["metadata", "the cloud metadata address"],
    ["metadata-name", "a name that resolves to the metadata address"],
    ["rebind", "a public-looking name that resolves into the stack (DNS rebinding)"],
    ["loopback", "loopback"],
    ["localhost", "localhost"],
    ["loopback-devtools", "the browser's own loopback DevTools port"],
    ["ipv6-loopback", "IPv6 loopback"],
    ["port", "a port other than 80 and 443"],
    ["file", "file:// from a script"],
    ["container-name", "a container by its name (control)"],
    ["container-name-gw", "a container by its name (gateway)"],
  ] as const)
    report(`a rendered page cannot reach ${what}`, !/^status 2/.test(outcome(name)), { [name]: outcome(name) });
  report(
    "nothing internal or local leaked into the rendered page",
    !result.html.includes(SECRET) && !result.html.includes(PASSWD),
  );
  const reached = served.slice(servedMark).filter((s) => s.path === "/secret");
  report("the fixture's internal-only path was never served to the attack", reached.length === 0, reached);
  const local = asked
    .slice(mark)
    .filter((a) => a.decision === "allow" && !FIXTURE.test(a.host) && !/attack\.example$/.test(a.host));
  report("the control plane allowed no local or literal-address destination", local.length === 0, local);
  report(
    "WebSockets are not opened from a rendered page",
    ["ws-fixture", "ws-control", "ws-worker"].every((n) => outcome(n) !== "OPEN") && upgrades.length === 0,
    { fixture: outcome("ws-fixture"), control: outcome("ws-control"), worker: outcome("ws-worker"), upgrades },
  );
  report("service workers are not available", outcome("serviceWorker") === "absent", outcome("serviceWorker"));
  report("WebRTC is not available (it would send UDP around the proxy)", outcome("rtc") === "absent", outcome("rtc"));
  report("the page sees no cookies", outcome("cookie") === "none", outcome("cookie"));
  report(
    "no cookie was sent to the fixture before the page set any",
    served.filter((s) => s.path === "/secret" || s.path === "/article").every((s) => !s.cookie),
    served.filter((s) => s.cookie),
  );
  // The download is checked by run.sh in the browser container (nothing named redteam-download.bin may exist).
}
{
  const { result, error } = await failure("http://app.fixture.example/file-frame");
  report(
    "a file:// frame shows nothing",
    !!result && !result.html.includes(PASSWD) && !String(error ?? "").includes(PASSWD),
    { error: String(error), html: result?.html.slice(0, 200) },
  );
}
{
  const { result, error } = await failure("http://app.fixture.example/file-nav");
  report(
    "a navigation to file:// is stopped or shows nothing",
    (error instanceof RenderFailure || !!result) && !result?.html.includes(PASSWD),
    { error: String(error), html: result?.html.slice(0, 200) },
  );
}
for (const [path, how] of [
  ["/leave", "a script navigation"],
  ["/redirect", "an HTTP redirect"],
  ["/refresh", "a meta refresh"],
] as const) {
  const { error } = await failure(`http://app.fixture.example${path}`);
  report(
    `${how} to a denied host ends the render with the policy's message`,
    error instanceof RenderFailure &&
      error.outcome === "navigation_stopped" &&
      error.message.includes("denied.attack.example") &&
      error.message.includes("not allowed"),
    { error: String(error) },
  );
}
report(
  "the denied host was never asked for or reached",
  !asked.some((a) => a.host === "denied.attack.example") &&
    !served.some((s) => s.host.startsWith("denied.attack.example")),
);
{
  const result = await render("http://app.fixture.example/captcha");
  const extracted = extractHtml(result.html, result.finalUrl);
  report(
    "a bot check that appears after its script runs is read as a wall, not as content",
    extracted.quality === "blocked",
    {
      quality: extracted.quality,
      text: extracted.text.slice(0, 120),
    },
  );
}
{
  const job = tokens.normal.open({ kind: "render", deadlineMs: 25_000 });
  issuer.set(job.token, "normal");
  const controller = new AbortController();
  let abortedAt = 0;
  const during = (async () => {
    while (!served.some((s) => s.path === "/stream")) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 800));
    abortedAt = Date.now();
    controller.abort();
    job.revoke(); // what the reader does in its finally
  })();
  let error: unknown;
  try {
    await engine.render({
      url: "http://app.fixture.example/busy",
      token: job.token,
      deadlineMs: 20_000,
      maxHtmlChars: 1_000_000,
      checkNavigation: fixturesOnly,
      signal: controller.signal,
    });
  } catch (e) {
    error = e;
  }
  await during;
  const ended = Date.now();
  await new Promise((r) => setTimeout(r, 1_500));
  const late = served.filter((s) => s.path === "/beacon" && s.at > abortedAt + 300);
  report(
    "cancelling ends the render at once",
    error instanceof RenderFailure && error.outcome === "cancelled" && ended - abortedAt < 2_000,
    { error: String(error), ms: ended - abortedAt },
  );
  report("a cancelled page sends nothing more", late.length === 0, { late: late.length });
  report("its open response is cut", streamClosedAt > 0 && streamClosedAt - abortedAt < 2_000, {
    closedAfter: streamClosedAt - abortedAt,
  });
  const reuse = await tokens.normal.decide(
    { source: "render", token: job.token, host: "api.fixture.example", port: 80 },
    new AbortController().signal,
  );
  report("its token is refused afterwards", reuse.decision === "deny", reuse);
}
{
  const servedMark = served.length;
  let error: unknown;
  try {
    await engine.render({
      url: "http://app.fixture.example/app",
      token: "j.unknown-not-a-secret",
      deadlineMs: 3_000,
      maxHtmlChars: 1_000_000,
      checkNavigation: fixturesOnly,
      signal: new AbortController().signal,
    });
  } catch (e) {
    error = e;
  }
  report("a forged token reaches nothing", served.length === servedMark, {
    error: String(error),
    served: served.slice(servedMark),
  });
}
{
  // State left between renders: the first sets a cookie and localStorage, the second must see neither.
  await render("http://app.fixture.example/setstate");
  const second = await render("http://app.fixture.example/readstate");
  const text = extractHtml(second.html, second.finalUrl).text;
  report("a render sees nothing a previous render stored", /cookie=none storage=none/.test(text), text.slice(0, 200));
}
await new Promise((r) => setTimeout(r, 500));
if (engine.contextCount) {
  const after = await engine.contextCount();
  report("every render context was disposed", after === before, { before, after });
}
const leftovers = execFileSync("sh", ["-c", "find / -xdev -name 'redteam-download.bin*' 2>/dev/null || true"], {
  encoding: "utf8",
}).trim();
report("the attack page's download was denied (nothing saved)", leftovers === "", leftovers);
if (ENGINE === "moli") {
  const running = execFileSync("sh", ["-c", "ps -eo comm | grep -c '^moli$' || true"], { encoding: "utf8" }).trim();
  report("no Moli process is left after the renders", running === "0", running);
}
(engine as { close?: () => void }).close?.();
console.log(
  failures === 0 ? `[${ENGINE}] All render checks passed.` : `[${ENGINE}] ${failures} render check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
