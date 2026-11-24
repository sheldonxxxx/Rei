// Run in the existing Linux Docker buildchain: node tests/e2e/mcp-deployed-images.mjs
// Tests immutable deployed images, never mounts source or persistent app data into the fixture.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";

const job = "job_" + randomBytes(12).toString("hex");
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const inspect = (...names) => JSON.parse(docker("inspect", ...names));
const liveNames = ["rei-control-1", "dodai-gateway-1", "rei-edge-1"];
// Test the images the live stack runs now.
const [controlLive, gatewayLive] = inspect(liveNames[0], liveNames[1]);
const images = { control: controlLive.Image, gateway: gatewayLive.Image };
const liveSnapshot = () =>
  inspect(...liveNames).map((c) => ({
    name: c.Name,
    image: c.Image,
    started: c.State.StartedAt,
    health: c.State.Health.Status,
    mounts: c.Mounts,
    networks: Object.keys(c.NetworkSettings.Networks).sort(),
  }));
const before = liveSnapshot();
assert.equal(before[0].image, images.control);
assert.equal(before[1].image, images.gateway);
assert(before.every((c) => c.health === "healthy"));
const volumesBefore = docker("volume", "ls", "-q").split("\n").sort();
const statusBefore = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
// Detect concurrent edits; a second coding run must not change the tested working tree silently.
const sourceDigest = () => {
  const h = createHash("sha256");
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = dir + "/" + name;
      if (statSync(p).isDirectory()) walk(p);
      else h.update(p).update(readFileSync(p));
    }
  };
  for (const dir of ["apps/server/src", "apps/gateway/src", "packages/protocol/src"]) walk(dir);
  return h.digest("hex");
};
const sourceBefore = sourceDigest();
const suffix = randomBytes(6).toString("hex");
const network = "rei-e2e-1bfa-" + suffix;
const label = "cc.rei.fixture=" + job + ":" + suffix;
const names = [];
let networkCreated = false;

async function fixtureMain() {
  const assert = (await import("node:assert/strict")).default;
  const { createServer } = await import("node:http");
  const { readFileSync } = await import("node:fs");
  const { randomBytes } = await import("node:crypto");
  const { DatabaseSync } = await import("node:sqlite");
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, what) => {
    for (let i = 0; i < 400; i++) {
      const v = await fn();
      if (v) return v;
      await pause(50);
    }
    throw new Error("Timed out: " + what);
  };
  let cookie;
  const api = async (method, path, body, options = {}) => {
    const headers = { "content-type": "application/json" };
    if (options.auth !== false && cookie) headers.cookie = cookie;
    if (method !== "GET" && options.csrf !== false) headers["x-rei"] = "1";
    const r = await fetch("http://127.0.0.1:8787" + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const ok = async (method, path, body, status = 200) => {
    const r = await api(method, path, body);
    assert.equal(r.status, status, method + " " + path + ": " + r.body?.error?.code);
    return r.body;
  };
  const report = (name, evidence) => console.log(JSON.stringify({ check: name, ...evidence }));
  await until(async () => {
    try {
      return (await api("GET", "/api/health")).status === 200;
    } catch {
      return false;
    }
  }, "control health");
  assert.equal((await api("GET", "/api/connectors")).status, 401);
  const auth = await ok("GET", "/api/auth/state");
  assert.equal(auth.setupRequired, true);
  const password = randomBytes(32).toString("hex");
  const setupCode = readFileSync("/data/setup-code.txt", "utf8").trim();
  await ok("POST", "/api/auth/setup", { setupCode, password });
  assert.equal((await ok("GET", "/api/auth/state")).signedIn, true);
  assert.equal((await api("POST", "/api/sessions", {}, { csrf: false })).status, 403);
  assert.equal((await api("GET", "/api/connectors", undefined, { auth: false })).status, 401);
  report("supported authenticated setup", { setup: 200, anonymous: 401, missingCsrf: 403 });

  const tools = [
    { name: "read", description: "Fixture read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    { name: "write", description: "Fixture write", inputSchema: { type: "object" } },
    {
      name: "delete",
      description: "Fixture delete",
      inputSchema: { type: "object" },
      annotations: { destructiveHint: true, readOnlyHint: true },
    },
  ];
  const effects = [];
  let lists = 0,
    sequence = 0;
  const lastList = new Map();
  const provider = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      let text = "";
      for await (const c of req) text += c;
      const m = JSON.parse(text);
      if (m.method?.startsWith("notifications/")) {
        res.writeHead(202);
        res.end();
        return;
      }
      let sid = req.headers["mcp-session-id"];
      if (m.method === "initialize") sid = "fixture-" + ++sequence;
      const reply = (result, error) => {
        res.writeHead(200, { "content-type": "application/json", ...(sid ? { "mcp-session-id": sid } : {}) });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...(error ? { error } : { result }) }));
      };
      switch (m.method) {
        case "initialize":
          reply({
            protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "isolated-fixture", version: "1" },
          });
          break;
        case "tools/list":
          lists++;
          lastList.set(sid, true);
          reply({ tools });
          break;
        case "tools/call":
          effects.push({ name: m.params.name, args: m.params.arguments, freshSession: !!sid && lastList.has(sid) });
          lastList.delete(sid);
          reply({ content: [{ type: "text", text: "fixture effect " + effects.length }] });
          break;
        default:
          reply(null, { code: -32601, message: "Method not found" });
      }
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise((r) => provider.listen(8799, "0.0.0.0", r));
  let connector;
  const db = new DatabaseSync("/data/app.sqlite"); // This container's tmpfs fixture DB only.
  try {
    connector = (
      await ok("POST", "/api/connectors", { name: "Disposable MCP", url: "http://control-fixture:8799/mcp" })
    ).connector;
    assert.equal(connector.mcpProfile, "always_ask");
    const cpath = "/api/connectors/" + connector.id;
    const profile = async (value) => {
      connector = (await ok("GET", "/api/connectors")).connectors.find((c) => c.id === connector.id);
      connector = (
        await ok("PUT", cpath + "/profile", {
          profile: value,
          providerIdentity: connector.providerIdentity,
          expectedRevision: connector.mcpProfileRevision,
          ...(value === "yolo" ? { confirmYolo: true } : {}),
        })
      ).connector;
    };
    const pending = async (id) => (await ok("GET", "/api/approvals")).approvals.filter((a) => a.sessionId === id);
    const detail = (id) => ok("GET", "/api/sessions/" + id);
    const settle = async (id, n) => {
      try {
        return await until(async () => {
          const d = await detail(id);
          return d.runs.length >= n && d.runs.every((r) => !["queued", "running"].includes(r.status)) ? d : false;
        }, "session settled");
      } catch (e) {
        const d = await detail(id);
        report("fixture run diagnostic", {
          runs: d.runs.map((r) => ({ status: r.status, error: r.errorCode })),
          steps: db.prepare("SELECT type,status,error_code FROM steps WHERE session_id=?").all(id),
          approvals: (await pending(id)).map((a) => ({ tool: a.tool, status: a.status })),
        });
        throw e;
      }
    };
    const directive = (name, args) => "[tool: " + name + " " + JSON.stringify(args) + "]";
    // A connector tool's name, as the server names it: `<connector slug>__<tool>` (see apps/server/src/mcp/connector-tools.ts).
    let connectorName = connector.name;
    const slug = () =>
      connectorName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 24)
        .replace(/_+$/, "");
    const toolName = (tool) => slug() + "__" + tool;
    const callText = (tool, tag) => directive(toolName(tool), { fixtureCase: tag });
    const send = async (text) => {
      const id = (await ok("POST", "/api/sessions", {})).session.id;
      const body = { requestId: crypto.randomUUID(), text };
      const sent = await ok("POST", "/api/sessions/" + id + "/messages", body);
      await settle(id, 1);
      return { id, body, sent };
    };
    const ask = async (tool, tag) => {
      const before = effects.length;
      const s = await send(callText(tool, tag));
      const a = await until(async () => (await pending(s.id))[0], "MCP approval");
      assert.equal(a.tool, toolName(tool));
      assert.deepEqual(a.lengths, ["once"]);
      assert.equal(effects.length, before);
      return { ...s, approval: a };
    };
    const decide = async (s, decision = "approve") => {
      const n = (await detail(s.id)).runs.length;
      await ok("POST", "/api/approvals/" + s.approval.id + "/decide", { decision, length: "once" });
      // Denial appends a notification entry; only approval enqueues a new agent run.
      await settle(s.id, n + (decision === "approve" ? 1 : 0));
    };
    const approveEffect = async (s) => {
      const n = effects.length;
      await decide(s);
      assert.equal(effects.length, n + 1);
      const row = db.prepare("SELECT grant_length, consumed_at FROM approvals WHERE id=?").get(s.approval.id);
      assert.equal(row.grant_length, "once");
      assert.notEqual(row.consumed_at, null);
    };
    const auto = async (tool, tag) => {
      const n = effects.length;
      const s = await send(callText(tool, tag));
      assert.equal(effects.length, n + 1);
      assert.equal((await pending(s.id)).length, 0);
      return s;
    };
    const inventory = (await ok("GET", cpath + "/tools?refresh=1")).tools;
    assert.equal(inventory.find((t) => t.name === "read").effectiveClass, "read_external");
    assert.equal(inventory.find((t) => t.name === "delete").effectiveClass, "irreversible");
    const first = await ask("read", "always-once");
    await approveEffect(first);
    const count = effects.length;
    const repeat = await ok("POST", "/api/sessions/" + first.id + "/messages", first.body);
    assert.equal(repeat.runId, first.sent.runId);
    await pause(250);
    assert.equal(effects.length, count);
    assert.equal(
      (await api("POST", "/api/approvals/" + first.approval.id + "/decide", { decision: "approve", length: "once" }))
        .status,
      409,
    );
    const again = await ask("read", "new-call-needs-new-approval");
    await decide(again, "deny");
    assert.equal(effects.length, count);
    report("Always Ask and replay", {
      approvalClass: first.approval.actionClass,
      lengths: first.approval.lengths,
      effects: count,
      duplicateApproval: 409,
      duplicateRequestEffects: 0,
      deniedEffects: 0,
    });

    await profile("read_only");
    const read = await auto("read", "readonly-auto");
    assert.deepEqual((await detail(read.id)).session.taint.sort(), ["external", "private"]);
    for (const tool of ["write", "delete"]) {
      const s = await ask(tool, "readonly-" + tool);
      await approveEffect(s);
    }
    report("Read-only", {
      read: "automatic",
      write: "once approval",
      destructiveCollision: "irreversible, once approval",
      effects: effects.length,
      taint: ["external", "private"],
    });
    const staleProfile = {
      profile: "read_only",
      providerIdentity: connector.providerIdentity,
      expectedRevision: connector.mcpProfileRevision,
    };
    assert.equal((await api("PUT", cpath + "/profile", { ...staleProfile, profile: "yolo" })).status, 400);
    await profile("yolo");
    assert.equal((await api("PUT", cpath + "/profile", staleProfile)).status, 409);
    await auto("delete", "yolo-delete");
    report("YOLO consent", {
      noConfirmation: 400,
      staleRevision: 409,
      destructive: "automatic",
      effects: effects.length,
    });

    await profile("always_ask");
    const revision = await ask("read", "stale-profile");
    const n = effects.length;
    await profile("read_only");
    await profile("always_ask");
    await decide(revision);
    assert.equal(effects.length, n);
    const schema = await ask("read", "stale-schema");
    tools[0].inputSchema = { type: "object", properties: { newer: { type: "boolean" } } };
    await ok("GET", cpath + "/tools?refresh=1");
    await decide(schema);
    assert.equal(effects.length, n);
    const identity = await ask("read", "stale-identity");
    await ok("PATCH", cpath, { name: "Disposable renamed" });
    connectorName = "Disposable renamed";
    await decide(identity);
    assert.equal(effects.length, n);
    report("stale pending authorizations", {
      profileChangeAndRestoreEffects: 0,
      schemaRefreshEffects: 0,
      connectorRenameEffects: 0,
    });

    // A legacy standing rule can only be made as fixture data: the current MCP UI/API never issues one.
    db.prepare(
      "INSERT INTO grants (id,connector,operation,destination,length,approval_id,created_at) VALUES (?,?,?,?,?,?,?)",
    ).run("gnt_fixture_legacy", "mcp", "call", connector.id + ".read", "always", first.approval.id, Date.now());
    const legacy = await ask("read", "legacy-rule-does-not-bypass");
    await ok("DELETE", "/api/grants/gnt_fixture_legacy", undefined);
    assert.notEqual(db.prepare("SELECT revoked_at FROM grants WHERE id='gnt_fixture_legacy'").get().revoked_at, null);
    await decide(legacy, "deny");
    assert.equal(effects.length, n);
    db.prepare("DELETE FROM grants WHERE id='gnt_fixture_legacy'").run();
    report("legacy grants and revocation", { standingRuleBypassEffects: 0, revokeHttp: 200, deniedEffects: 0 });

    const draft = {
      name: "Disposable trigger",
      schedule: { kind: "interval", everyMinutes: 1440, timeZone: "UTC" },
      action: { kind: "prompt", prompt: callText("read", "trigger-allow") },
      allow: [{ tool: toolName("read"), destination: connector.id + ".read" }],
      report: "never",
    };
    const maker = await send(directive("create_trigger", draft));
    maker.approval = await until(async () => (await pending(maker.id))[0], "trigger creation approval");
    await decide(maker);
    const trigger = await until(
      async () => (await ok("GET", "/api/triggers")).triggers.find((t) => t.name === draft.name),
      "created trigger",
    );
    await ok("PATCH", "/api/triggers/" + trigger.id, { paused: true });
    await ok("POST", "/api/triggers/" + trigger.id + "/run", {});
    const triggerApproval = await until(
      async () =>
        (await ok("GET", "/api/approvals")).approvals.find(
          (a) => a.tool === toolName("read") && a.summary.includes("trigger-allow"),
        ),
      "trigger MCP approval",
    );
    assert.equal(effects.length, n);
    assert.deepEqual(triggerApproval.lengths, ["once"]);
    assert.equal((await detail(triggerApproval.sessionId)).session.origin, "trigger");
    await decide({ id: triggerApproval.sessionId, approval: triggerApproval }, "deny");
    await ok("DELETE", "/api/triggers/" + trigger.id, undefined);
    report("background trigger allow", { manualRun: 200, origin: "trigger", stillAsksOnce: true, bypassEffects: 0 });

    // Exercise gateway dispatch's fresh same-connection validation over actual HTTP, beyond policy tests.
    const standin = readFileSync("/data/fixture-standin", "utf8");
    const gw = async (method, path, body) => {
      const r = await fetch("http://gateway-fixture:8780" + path, {
        method,
        headers: { authorization: "Bearer " + standin, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000),
      });
      return { status: r.status, body: await r.json() };
    };
    const gc = (await gw("GET", "/mcp/connectors")).body.connectors[0];
    const gi = Object.fromEntries(["id", "name", "url", "auth", "status", "createdAt"].map((k) => [k, gc[k]]));
    const gt = (await gw("GET", "/mcp/connectors/" + gc.id + "/tools?refresh=1")).body.tools[0];
    tools[0].description = "Definition changed after gateway inspection";
    const rejected = await gw("POST", "/mcp/connectors/" + gc.id + "/call", {
      tool: "read",
      arguments: {},
      expected: { connector: gi, tool: gt },
    });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, "tool_changed");
    assert.equal(effects.length, n);
    assert(effects.every((e) => e.freshSession));
    assert.equal((await ok("GET", "/api/grants")).grants.length, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM grants").get().n, 0);
    assert(db.prepare("SELECT count(*) AS n FROM steps WHERE type='tool.call'").get().n > 0);
    report("gateway freshness and audit", {
      staleDefinition: 409,
      extraEffects: 0,
      sameSessionFreshLists: true,
      totalEffects: effects.length,
      toolsLists: lists,
      standingGrants: 0,
    });
    await ok("DELETE", cpath, undefined, 204);
    connector = null;
    assert.equal((await ok("GET", "/api/connectors")).connectors.length, 0);
    report("fixture API cleanup", {
      connectors: 0,
      triggers: (await ok("GET", "/api/triggers")).triggers.length,
      standingGrants: 0,
    });
  } finally {
    db.close();
    if (connector) await api("DELETE", "/api/connectors/" + connector.id).catch(() => {});
    provider.closeAllConnections();
    await new Promise((r) => provider.close(r));
  }
}

try {
  docker("network", "create", "--internal", "--label", label, network);
  networkCreated = true;
  const net = JSON.parse(docker("network", "inspect", network))[0];
  assert.equal(net.Internal, true);
  const token = randomBytes(32).toString("hex"); // Independent throwaway token, only memory and fixture tmpfs.
  for (const service of ["gateway", "control"]) {
    const name = network + "-" + service;
    const uid = service === "control" ? 1000 : 1100;
    const env =
      service === "control"
        ? {
            REI_DATA: "/data",
            REI_PORT: "8787",
            REI_HOST: "0.0.0.0",
            REI_MODEL_MODE: "faux",
            REI_FAUX_TPS: "100000",
            REI_BROWSER: "off",
            REI_EXEC: "off",
            REI_DEMO_TOOLS: "0",
            REI_COMMIT_MS: "100",
            REI_PARKED_POLL_MS: "100",
            GATEWAY_URL: "http://gateway-fixture:8780",
          }
        : { GATEWAY_DATA: "/data", GATEWAY_PORT: "8780", GATEWAY_MCP_DEV_HOSTS: "control-fixture" };
    const bootstrap =
      "import{existsSync,mkdirSync}from'node:fs';while(!existsSync('/data/fixture-standin'))await new Promise(r=>setTimeout(r,25));mkdirSync('/data/tmp',{recursive:true});await import('./src/main.ts');";
    // Normal setup announces its throwaway code; do not retain container stdout/stderr logs.
    docker(
      "run",
      "-d",
      "--pull=never",
      "--log-driver",
      "none",
      "--name",
      name,
      "--label",
      label,
      "--network",
      network,
      "--network-alias",
      service + "-fixture",
      "--read-only",
      "--tmpfs",
      `/data:rw,nosuid,nodev,size=512m,uid=${uid},gid=${uid},mode=0700`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--memory",
      "1g",
      "-e",
      "REI_STANDIN_FILE=/data/fixture-standin",
      "-e",
      "TMPDIR=/data/tmp",
      ...Object.entries(env).flatMap(([k, v]) => ["-e", k + "=" + v]),
      "--entrypoint",
      "node",
      images[service],
      "--input-type=module",
      "-e",
      bootstrap,
    );
    names.push(name);
    execFileSync(
      "docker",
      [
        "exec",
        "-i",
        name,
        "node",
        "--input-type=module",
        "-e",
        "import{writeFileSync}from'node:fs';let s='';for await(const c of process.stdin)s+=c;writeFileSync('/data/fixture-standin',s,{mode:0o600});",
      ],
      { input: token, stdio: ["pipe", "pipe", "pipe"] },
    );
    const c = inspect(name)[0];
    assert.equal(c.Image, images[service]);
    assert.equal(c.HostConfig.ReadonlyRootfs, true);
    assert.equal(c.HostConfig.LogConfig.Type, "none");
    assert.deepEqual(Object.keys(c.NetworkSettings.Networks), [network]);
    assert.equal(Object.keys(c.HostConfig.PortBindings ?? {}).length, 0);
    assert(c.Mounts.every((m) => m.Type === "tmpfs"));
    assert(c.HostConfig.Tmpfs["/data"]);
    console.log(
      JSON.stringify({
        fixture: service,
        image: c.Image,
        storage: "tmpfs only",
        network: "internal only",
        publishedPorts: 0,
      }),
    );
  }
  const code =
    "(" + fixtureMain.toString() + ")().catch(e=>{console.error('E2E assertion failed: '+e.stack);process.exitCode=1})";
  const child = spawn(
    "docker",
    ["exec", "-i", names[1], "node", "--disable-warning=ExperimentalWarning", "--input-type=module"],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  child.stdin.end(code);
  const timer = setTimeout(() => child.kill("SIGTERM"), 180000);
  const result = await new Promise((r) => child.once("exit", (code) => r(code)));
  clearTimeout(timer);
  assert.equal(result, 0, "authenticated image E2E process");
} finally {
  for (const name of names.reverse()) {
    const c = inspect(name)[0];
    assert.equal(c.Config.Labels["cc.rei.fixture"], label.split("=")[1]);
    assert(c.Mounts.every((m) => m.Type === "tmpfs"));
    docker("rm", "-f", name);
  }
  if (networkCreated) {
    const n = JSON.parse(docker("network", "inspect", network))[0];
    assert.equal(n.Labels["cc.rei.fixture"], label.split("=")[1]);
    assert.equal(Object.keys(n.Containers).length, 0);
    docker("network", "rm", network);
  }
  assert.equal(docker("ps", "-aq", "--filter", "label=" + label), "");
  assert.equal(docker("network", "ls", "-q", "--filter", "label=" + label), "");
  assert.deepEqual(docker("volume", "ls", "-q").split("\n").sort(), volumesBefore);
  assert.deepEqual(liveSnapshot(), before);
  assert.equal(sourceDigest(), sourceBefore, "concurrent source change detected");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }), statusBefore);
  console.log(
    "CLEANUP PASS: fixture containers/network/secret tmpfs gone; volume list and live images/starts/health/mounts unchanged; working tree preserved",
  );
}
