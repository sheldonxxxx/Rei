// Live end-to-end for outside events (ADR 0019): signs and sends events to the running stack, then checks the answers,
// the runs and the lines in the home chat. Nothing is mocked; it needs the stack up (`./rei redeploy` first).
//
//   REI_EVENTS_SECRET=whsec_... node tests/e2e/events-live.mjs [--source feed] [--notify "Feed watcher"] [--gather "Feed digest"]
//
// The source and its triggers are made beforehand: `./rei sources add feed`, then an agent creates a trigger that posts a
// message on `items.new` (--notify) and, optionally, one that runs a prompt (--gather), which shows events gathering into
// one waiting run. The sign-in is the saved development login (containers/.secrets/dev-login.json); the script signs in
// as its own device and signs that device out again. No secret, token or cookie is printed.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const source = arg("source", "feed");
const notifyName = arg("notify", "Feed watcher");
const gatherName = arg("gather", "");
const secret = process.env.REI_EVENTS_SECRET;
assert(secret?.startsWith("whsec_"), "Set REI_EVENTS_SECRET to the source's secret (whsec_...).");
const login = JSON.parse(readFileSync(new URL("../../containers/.secrets/dev-login.json", import.meta.url), "utf8"));
const base = login.url;

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push([name, "pass"]);
    console.log(`pass  ${name}`);
  } catch (error) {
    results.push([name, "FAIL"]);
    console.log(`FAIL  ${name}\n      ${error.message.split("\n")[0]}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
};

// ---- signed-in calls -----------------------------------------------------------------------------------------------
const session = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-rei-client": "cli/1" },
  body: JSON.stringify({ password: login.password, deviceLabel: "events-live e2e" }),
}).then((r) => r.json());
assert(session.token, "sign-in failed");
const api = async (path) =>
  (
    await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${session.token}`, "x-rei-client": "cli/1" } })
  ).json();

// ---- signed events -------------------------------------------------------------------------------------------------
const sign = (key, id, ts, body) =>
  `v1,${createHmac("sha256", Buffer.from(key.slice(6), "base64"))
    .update(`${id}.${ts}.${body}`)
    .digest("base64")}`;
async function send({ id = randomUUID(), type = "items.new", ref, skew = 0, key = secret, path = source, body } = {}) {
  const text = body ?? JSON.stringify({ type, ref: ref ?? `item_${id.slice(0, 8)}` });
  const ts = String(Math.floor(Date.now() / 1000) + skew);
  const res = await fetch(`${base}/api/events/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": ts,
      "webhook-signature": sign(key, id, ts, text),
    },
    body: text,
  });
  return { status: res.status, id, body: await res.json().catch(() => ({})) };
}

const triggerNamed = async (name) => (await api("/api/triggers")).triggers.find((t) => t.name === name);
const runsOf = async (t) => (await api(`/api/triggers/${t.id}`)).runs;
const homeTexts = async () => {
  const agents = (await api("/api/agents")).agents;
  const home = agents.find((a) => a.homeSessionId)?.homeSessionId;
  const detail = await api(`/api/sessions/${home}`);
  return detail.messages.flatMap((m) => (m.role === "trigger" && m.trigger ? [m.trigger.text] : []));
};

const notify = await triggerNamed(notifyName);
assert(notify, `No trigger named "${notifyName}". Make it first (see the header of this file).`);
assert.equal(notify.start.kind, "event");
const message = notify.action.message;

await check("a normal event: 202, one run that succeeded with that event, and its line in the home chat", async () => {
  const before = (await runsOf(notify)).length;
  const ref = `item_${randomUUID().slice(0, 8)}`;
  const sent = await send({ ref });
  assert.equal(sent.status, 202);
  assert.deepEqual(sent.body, { accepted: true });
  const runs = await until(async () => {
    const r = await runsOf(notify);
    return r.length === before + 1 && r[0].status === "succeeded" ? r : undefined;
  }, "the run to succeed");
  assert.deepEqual(
    runs[0].events.map((e) => e.ref),
    [ref],
  );
  const lines = await until(async () => {
    const t = await homeTexts();
    return t.includes(message) ? t : undefined;
  }, "the home-chat line");
  assert(lines.includes(message));
});

await check("a duplicate (same webhook-id): 200 duplicate, and no new run", async () => {
  const first = await send({});
  assert.equal(first.status, 202);
  await sleep(1500);
  const before = (await runsOf(notify)).length;
  const again = await send({ id: first.id });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { duplicate: true });
  await sleep(1500);
  assert.equal((await runsOf(notify)).length, before);
});

await check("a stale timestamp (10 minutes old) is refused with 401 and starts nothing", async () => {
  const before = (await runsOf(notify)).length;
  const res = await send({ skew: -600 });
  assert.equal(res.status, 401);
  assert.equal(res.body.error?.code, "stale_timestamp");
  await sleep(1000);
  assert.equal((await runsOf(notify)).length, before);
});

await check("a wrong signature is 401, an unknown source 404, a body with extra fields 400", async () => {
  const wrong = await send({ key: `whsec_${Buffer.from("not the secret, but 32 bytes long!").toString("base64")}` });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error?.code, "bad_signature");
  assert.equal((await send({ path: "nobody-here" })).status, 404);
  const extra = await send({ body: JSON.stringify({ type: "items.new", ref: "x", note: "free text" }) });
  assert.equal(extra.status, 400);
});

await check("a burst of 10 events loses none: every event ends up on a run", async () => {
  const before = new Set((await runsOf(notify)).map((r) => r.id));
  const refs = Array.from({ length: 10 }, (_, i) => `burst_${randomUUID().slice(0, 6)}_${i}`);
  const answers = await Promise.all(refs.map((ref) => send({ ref })));
  assert(
    answers.every((a) => a.status === 202),
    "every event is accepted",
  );
  await until(async () => {
    const mine = (await runsOf(notify)).filter((r) => !before.has(r.id));
    const got = new Set(mine.flatMap((r) => r.events.map((e) => e.ref)));
    return refs.every((r) => got.has(r)) && mine.every((r) => r.status === "succeeded") ? true : undefined;
  }, "every burst event to appear on a run");
});

if (gatherName) {
  await check(`a burst while a prompt run is going gathers into one waiting run (${gatherName})`, async () => {
    const t = await triggerNamed(gatherName);
    assert(t, `No trigger named "${gatherName}".`);
    const busy = (r) => ["running", "queued", "waiting"].includes(r.status);
    // Earlier checks sent events to this trigger too: let their runs finish, so this burst starts from quiet.
    await until(async () => ((await runsOf(t)).some(busy) ? undefined : true), "earlier runs to finish", 300_000);
    const tag = randomUUID().slice(0, 6);
    const refs = Array.from({ length: 8 }, (_, i) => `gather_${tag}_${i}`);
    for (const ref of refs) assert.equal((await send({ ref })).status, 202);
    const mine = () =>
      runsOf(t).then((runs) => runs.filter((r) => r.events.some((e) => e.ref.startsWith(`gather_${tag}`))));
    const now = await mine();
    assert(now.length <= 2, `expected at most 2 runs for the burst, got ${now.length}`);
    assert(now.length === 2 && now.some((r) => r.status === "queued"), "the second run waits while the first is going");
    await until(
      async () => {
        const done = await mine();
        return done.length === now.length && !done.some(busy) ? done : undefined;
      },
      "the gathered runs to finish",
      300_000,
    );
    const all = await mine();
    const got = all.flatMap((r) => r.events.map((e) => e.ref));
    assert.deepEqual([...got].sort(), [...refs].sort());
    assert(
      all.every((r) => r.status === "succeeded"),
      "the runs succeeded",
    );
  });
}

await check("the sources list shows the source with its last event and types, and no secret", async () => {
  const body = await api("/api/event-sources");
  const s = body.sources.find((x) => x.id === source);
  assert(s && s.lastEventAt !== null && s.types.includes("items.new"));
  assert(!JSON.stringify(body).includes(secret));
});

await fetch(`${base}/api/auth/logout`, {
  method: "POST",
  headers: { authorization: `Bearer ${session.token}`, "x-rei-client": "cli/1" },
}).catch(() => {});
const failed = results.filter(([, r]) => r !== "pass");
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
