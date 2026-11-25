// One permission table for every kind of session (docs/chat-permissions.md): a trigger's run decides each call as a
// chat on the same level does. What stays special to a trigger is its allow list and that a run cannot wait for you in a
// script. Raising a level is a `configure` change, so Strict and Standard ask once before anything runs on YOLO.

import type { ProfileName, TaintLabel, Trigger } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateTool } from "../src/pi/policy-ext.ts";
import type { TriggerFields } from "../src/triggers/spec.ts";
import { checkAllow } from "../src/triggers/spec.ts";
import { approve, decide, effects, pending, setProfile, tool, waitPending } from "./helpers/approvals.ts";
import { until } from "./helpers/client.ts";
import { chat, childrenOf, detail, homeChat, say, settled, stepPayloads } from "./helpers/sessions.ts";
import { html, startWebServer, type WebServer } from "./helpers/web.ts";

let server: WebServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const start = async (): Promise<WebServer> => (server = await startWebServer());

const PAGE = "https://a.example/kyoto";
const agentOf = (s: WebServer) => s.host.plane.store.defaultAgentId()!;
const triggers = (s: WebServer) => s.host.plane.triggers;
const makeTrigger = (s: WebServer, over: Partial<TriggerFields> = {}): Trigger =>
  triggers(s).store.create({
    agentId: agentOf(s),
    createdBySessionId: null,
    fields: {
      name: "Research",
      start: { kind: "schedule", schedule: { kind: "daily", times: ["09:00"], timeZone: "UTC" } },
      action: { kind: "prompt", prompt: "hello" },
      landing: "new",
      report: "on_change",
      latenessMinutes: 120,
      catchUp: "once",
      overlap: "skip",
      profile: "standard",
      allow: [],
      ...over,
    },
  });
const runNow = async (s: WebServer, t: Trigger) => {
  expect((await s.client.post(`/api/triggers/${t.id}/run`, {})).status).toBe(200);
  return until(
    () => triggers(s).store.runsOfTrigger(t.id).at(-1)?.session_id ?? undefined,
    20_000,
    "the trigger run's session",
  );
};
const lastRun = (s: WebServer, t: Trigger) => triggers(s).store.get(t.id)!.lastRun;
const finished = (s: WebServer, t: Trigger) =>
  until(
    () => {
      const run = lastRun(s, t);
      return run && run.status !== "running" && run.status !== "waiting" ? run : undefined;
    },
    20_000,
    "the trigger run to finish",
  );
const taintOf = (s: WebServer, id: string): string[] => JSON.parse(s.host.plane.store.getSessionRow(id)!.taint);
const approvalsOf = (s: WebServer, id: string) =>
  s.host.plane.store.db.all<{ id: string }>("SELECT id FROM approvals WHERE session_id = ?", id);

/** Reads the inbox (private data and outside content), then searches and fetches a public page. */
const RESEARCH = `${tool("demo_read_inbox")} ${tool("web_search", { query: "kyoto in autumn" })} ${tool("web_fetch", { url: PAGE })}`;
const trigger = {
  name: "Morning check",
  start: { kind: "schedule", schedule: { kind: "daily", times: ["09:00"], timeZone: "UTC" } },
  action: { kind: "prompt", prompt: "Check my notes." },
};

describe("a trigger's run uses the chat's table", () => {
  it("Standard: after reading private data and outside content, searches and fetches public pages without asking", async () => {
    const s = await start();
    s.web.page(PAGE, html("<html><body><p>Maples in Kyoto.</p></body></html>"));
    const t = makeTrigger(s, { action: { kind: "prompt", prompt: RESEARCH } });
    const id = await runNow(s, t);
    expect((await finished(s, t)).status).toBe("succeeded");
    expect(taintOf(s, id).sort()).toEqual(["external", "private"]);
    expect(s.search.requests).toHaveLength(1);
    expect(s.web.calls.map((c) => c.url)).toEqual([PAGE]);
    expect(approvalsOf(s, id)).toEqual([]);
    expect(await pending(s)).toEqual([]);
  });

  it("Strict: the same search asks, offers web and 'for this trigger', and runs once approved", async () => {
    const s = await start();
    const t = makeTrigger(s, {
      profile: "strict",
      action: { kind: "prompt", prompt: tool("web_search", { query: "kyoto in autumn" }) },
    });
    const id = await runNow(s, t);
    const [a] = await waitPending(s, id, 1);
    expect(a).toMatchObject({ tool: "web_search", lengths: ["once", "session", "web_session", "trigger"] });
    expect(lastRun(s, t)!.status).toBe("waiting");
    expect(s.search.requests).toEqual([]);
    expect((await decide(s, a!.id, { decision: "approve", length: "once" })).status).toBe(200);
    expect((await finished(s, t)).status).toBe("succeeded");
    expect(s.search.requests).toHaveLength(1);
  });

  it("YOLO: a trigger may run on YOLO, and a send after private reads runs without asking", async () => {
    const s = await start();
    const t = makeTrigger(s, {
      profile: "yolo",
      action: {
        kind: "prompt",
        prompt: `${tool("demo_read_inbox")} ${tool("demo_send_message", { to: "sam", text: "hi" })}`,
      },
    });
    const id = await runNow(s, t);
    expect((await finished(s, t)).status).toBe("succeeded");
    expect((await detail(s, id)).session.profile).toBe("yolo");
    expect(effects(s).map((e) => e.tool)).toContain("demo_send_message");
    expect(approvalsOf(s, id)).toEqual([]);
  });

  it("gives every tool the same decision in a chat and in a trigger's run, at every level and taint", async () => {
    const s = await start();
    const chatId = await chat(s);
    await say(s, chatId, "hello");
    await settled(s, chatId, 1);
    const t = makeTrigger(s);
    const runId = (
      await s.host.plane.store.createTriggerSession({
        agentId: agentOf(s),
        triggerId: t.id,
        title: t.name,
        profile: "standard",
      })
    ).session.id;
    const catalog = s.host.plane.catalog;
    const argsFor: Record<string, object> = {
      web_search: { query: "kyoto" },
      web_fetch: { url: PAGE },
      demo_send_message: { to: "sam", text: "hi" },
    };
    const names = catalog.names().filter((name) => !catalog.get(name)!.mcpPolicy);
    expect(names).toEqual(expect.arrayContaining(["web_search", "web_fetch", "demo_send_message", "create_trigger"]));
    const levels: ProfileName[] = ["strict", "standard", "yolo"];
    const taints: TaintLabel[][] = [[], ["external"], ["private"], ["external", "private"]];
    for (const profile of levels)
      for (const taint of taints) {
        const rowOf = (id: string) => ({
          ...s.host.plane.store.getSessionRow(id)!,
          profile,
          taint: JSON.stringify(taint),
        });
        for (const name of names) {
          const args = argsFor[name] ?? {};
          const inChat = evaluateTool(s.host.plane.approvals, rowOf(chatId), catalog.get(name)!, args as never);
          const inRun = evaluateTool(s.host.plane.approvals, rowOf(runId), catalog.get(name)!, args as never);
          expect(inRun.decision, `${name} at ${profile} with [${taint.join(", ")}]`).toEqual(inChat.decision);
        }
      }
  });

  it("reads a stored relaxed trigger as Standard: its run is Standard and researches without asking", async () => {
    const s = await start();
    s.web.page(PAGE, html("<html><body><p>Maples in Kyoto.</p></body></html>"));
    const t = makeTrigger(s, { action: { kind: "prompt", prompt: RESEARCH } });
    s.host.plane.store.db.run("UPDATE triggers SET profile = 'relaxed' WHERE id = ?", t.id);
    expect(triggers(s).store.get(t.id)!.profile).toBe("standard");
    expect((await s.client.get(`/api/triggers/${t.id}`)).body.trigger.profile).toBe("standard");
    const id = await runNow(s, t);
    expect((await finished(s, t)).status).toBe("succeeded");
    expect((await detail(s, id)).session.profile).toBe("standard");
    expect(approvalsOf(s, id)).toEqual([]);
  });
});

describe("raising a trigger's level", () => {
  it("Standard asks once before creating a YOLO trigger, and the card says YOLO", async () => {
    const s = await start();
    const id = await chat(s);
    await say(s, id, tool("create_trigger", { ...trigger, profile: "yolo" }));
    const [a] = await waitPending(s, id, 1);
    expect(a).toMatchObject({ tool: "create_trigger", actionClass: "configure", lengths: ["once"] });
    expect(a!.preview).toMatchObject({ kind: "trigger", op: "create", profile: "yolo" });
    expect(triggers(s).store.list()).toEqual([]);
    await approve(s, id);
    expect(triggers(s).store.list()).toMatchObject([{ name: trigger.name, profile: "yolo" }]);
  });

  it("Strict asks too, and a new trigger defaults to the agent's level without lowering YOLO", async () => {
    const s = await start();
    expect(
      (await s.client.call("PATCH", `/api/agents/${agentOf(s)}`, { body: { defaultProfile: "yolo" } })).status,
    ).toBe(200);
    const id = await chat(s);
    await setProfile(s, id, "strict");
    await say(s, id, tool("create_trigger", trigger));
    const [a] = await waitPending(s, id, 1);
    expect(a).toMatchObject({ tool: "create_trigger", lengths: ["once"] });
    expect(a!.preview).toMatchObject({ profile: "yolo" });
    expect(triggers(s).store.list()).toEqual([]);
  });

  it("asks before a change to YOLO and shows the level before and after", async () => {
    const s = await start();
    const t = makeTrigger(s);
    const id = await chat(s);
    await say(s, id, tool("update_trigger", { id: t.id, profile: "yolo" }));
    const [a] = await waitPending(s, id, 1);
    expect(a).toMatchObject({ tool: "update_trigger", actionClass: "configure", lengths: ["once"] });
    expect(a!.preview).toMatchObject({ op: "update", profile: "yolo", before: { profile: "standard" } });
    expect(triggers(s).store.get(t.id)!.profile).toBe("standard");
    await approve(s, id);
    expect(triggers(s).store.get(t.id)!.profile).toBe("yolo");
  });

  it("a Standard trigger's own run cannot raise itself: the change asks and 'for this trigger' is not offered", async () => {
    const s = await start();
    const t = makeTrigger(s);
    triggers(s).store.update(
      t.id,
      {
        ...triggers(s).store.fields(triggers(s).store.row(t.id)!),
        action: { kind: "prompt", prompt: tool("update_trigger", { id: t.id, profile: "yolo" }) },
      },
      { log: false },
    );
    const id = await runNow(s, t);
    const [a] = await waitPending(s, id, 1);
    expect(a).toMatchObject({ tool: "update_trigger", lengths: ["once"] });
    expect(triggers(s).store.get(t.id)!.profile).toBe("standard");
  });

  it("an allow list cannot hold a trigger change, and a script cannot call one", async () => {
    const s = await start();
    const id = await chat(s);
    expect(
      (await s.client.call("PUT", "/api/settings/behavior", { body: { codeMode: { enabled: true } } })).status,
    ).toBe(200);
    const t = makeTrigger(s);
    await say(
      s,
      id,
      tool("codemode", {
        code: `try { await tools.update_trigger({ id: ${JSON.stringify(t.id)}, profile: "yolo" }); console.log("changed"); } catch (e) { console.log("refused"); }`,
      }),
    );
    await settled(s, id, 1);
    expect(stepPayloads(s, id).at(-1)).toContain("refused");
    expect(triggers(s).store.get(t.id)!.profile).toBe("standard");
    for (const name of ["create_trigger", "update_trigger", "delete_trigger"])
      expect(() => checkAllow([{ tool: name }], s.host.plane.catalog)).toThrow(/always asks \(configure\)/);
  });

  it("a worker starts on its parent's level and cannot pick another", async () => {
    const s = await start();
    const home = homeChat(s);
    await setProfile(s, home, "strict");
    await say(s, home, `[spawn: hello]`);
    const worker = await until(async () => (await childrenOf(s, home))[0], 20_000, "the worker");
    expect(worker.profile).toBe("strict");
  });

  it("the API reads relaxed as Standard for chats, agents and triggers, and refuses an unknown level", async () => {
    const s = await start();
    const id = await chat(s);
    await setProfile(s, id, "strict");
    expect((await setProfile(s, id, "relaxed")).body.session.profile).toBe("standard");
    const agent = await s.client.call("PATCH", `/api/agents/${agentOf(s)}`, { body: { defaultProfile: "relaxed" } });
    expect(agent.body.agent.defaultProfile).toBe("standard");
    const created = await s.client.call("POST", "/api/triggers", {
      body: { agentId: agentOf(s), ...trigger, profile: "relaxed" },
    });
    expect(created.status).toBe(201);
    expect(created.body.trigger.profile).toBe("standard");
    const tid = created.body.trigger.id as string;
    const patch = (profile: string) => s.client.call("PATCH", `/api/triggers/${tid}`, { body: { profile } });
    expect((await patch("yolo")).body.trigger.profile).toBe("yolo");
    expect((await patch("relaxed")).body.trigger.profile).toBe("standard");
    expect((await patch("admin")).status).toBe(400);
    expect((await s.client.call("PATCH", `/api/sessions/${id}`, { body: { profile: "admin" } })).status).toBe(400);
  });
});
