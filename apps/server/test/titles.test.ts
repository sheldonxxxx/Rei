import { afterEach, describe, expect, it } from "vitest";
import { cleanTitle } from "../src/pi/titles.ts";
import { until } from "./helpers/client.ts";
import { type FakeGateway, startFakeGateway } from "./helpers/fake-gateway.ts";
import { STANDIN, startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, detail, say, settled } from "./helpers/sessions.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
let gateway: FakeGateway | undefined;
afterEach(async () => {
  await server?.destroy();
  await gateway?.close();
  server = undefined;
  gateway = undefined;
});
const s = (): TestServer => server!;
const isTitleCall = (raw: string) => raw.includes("You write titles for chats");
const titleCalls = () => gateway!.seen.filter((c) => isTitleCall(c.raw));
const put = (body: unknown) => s().client.call("PUT", "/api/settings/titles", { body });

async function start() {
  gateway = await startFakeGateway({
    bearer: STANDIN,
    behavior: (seen) => ({ kind: "text", text: isTitleCall(seen.raw) ? '"Quokka care tips."' : "Quokkas like shade." }),
  });
  server = await startSignedIn({ gatewayUrl: gateway.url, titles: true });
}

describe("chat titles", () => {
  it("a chat you start is first titled with its message, then with what the model writes after the first reply", async () => {
    await start();
    const id = await chat(s());
    await say(s(), id, "How do I look after a quokka?");
    await settled(s(), id, 1);
    const titled = await until(
      async () => ((await detail(s(), id)).session.title === "Quokka care tips" ? true : undefined),
      10_000,
      "the generated title",
    );
    expect(titled).toBe(true);
    expect(titleCalls()).toHaveLength(1);
    expect(titleCalls()[0]!.json).toMatchObject({ model: "gpt-6-luna" }); // the default title model
    // the call carried the first message and the reply
    expect(titleCalls()[0]!.raw).toContain("How do I look after a quokka?");
    expect(titleCalls()[0]!.raw).toContain("Quokkas like shade.");
  });

  it("titles a chat once: a later reply does not ask again", async () => {
    await start();
    const id = await chat(s());
    await say(s(), id, "first");
    await settled(s(), id, 1);
    await until(
      async () => ((await detail(s(), id)).session.title === "Quokka care tips" ? true : undefined),
      10_000,
      "the generated title",
    );
    await say(s(), id, "second");
    await settled(s(), id, 2);
    expect(titleCalls()).toHaveLength(1);
  });

  it("uses the model set in Settings", async () => {
    await start();
    expect((await s().client.get("/api/settings/titles")).body).toEqual({
      enabled: true,
      model: null,
      default: "gpt-6-luna",
    });
    expect((await put({ model: "gpt-5.6-sol" })).body).toEqual({
      enabled: true,
      model: "gpt-5.6-sol",
      default: "gpt-6-luna",
    });
    const id = await chat(s());
    await say(s(), id, "hello");
    await settled(s(), id, 1);
    await until(() => (titleCalls().length > 0 ? true : undefined), 10_000, "the title call");
    expect(titleCalls()[0]!.json).toMatchObject({ model: "gpt-5.6-sol" });
    expect((await put({ model: null })).body.model).toBeNull();
  });

  it("off keeps the first message as the title and makes no model call", async () => {
    await start();
    expect((await put({ enabled: false })).body.enabled).toBe(false);
    const id = await chat(s());
    await say(s(), id, "Keep this title please");
    await settled(s(), id, 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(titleCalls()).toHaveLength(0);
    expect((await detail(s(), id)).session.title).toBe("Keep this title please");
  });

  it("a failed title call leaves the first-message title", async () => {
    gateway = await startFakeGateway({
      bearer: STANDIN,
      behavior: (seen) =>
        isTitleCall(seen.raw)
          ? { kind: "status", status: 400, body: JSON.stringify({ error: { message: "no such model" } }) }
          : { kind: "text", text: "ok" },
    });
    server = await startSignedIn({ gatewayUrl: gateway.url, titles: true });
    const id = await chat(s());
    await say(s(), id, "Plain old title");
    await settled(s(), id, 1);
    await until(() => (titleCalls().length > 0 ? true : undefined), 10_000, "the title call");
    await new Promise((r) => setTimeout(r, 300));
    expect((await detail(s(), id)).session.title).toBe("Plain old title");
  });

  it("shows each title as a background task, with the reason when it fails and a retry that fixes it", async () => {
    let broken = true;
    gateway = await startFakeGateway({
      bearer: STANDIN,
      behavior: (seen) =>
        isTitleCall(seen.raw)
          ? broken
            ? { kind: "status", status: 400, body: JSON.stringify({ error: { message: "no such model" } }) }
            : { kind: "text", text: "Quokka care tips" }
          : { kind: "text", text: "Quokkas like shade." },
    });
    server = await startSignedIn({ gatewayUrl: gateway.url, titles: true });
    const id = await chat(s());
    await say(s(), id, "How do I look after a quokka?");
    await settled(s(), id, 1);
    const jobs = async () =>
      (await s().client.get(`/api/background?kind=session.title&sessionId=${id}`)).body.jobs as {
        id: string;
        status: string;
        diagnostic: string | null;
        payload: string;
        result: string | null;
      }[];
    const failed = await until(
      async () => (await jobs()).find((j) => j.status === "failed"),
      30_000,
      "the failed title task",
    );
    expect(failed.diagnostic).toMatch(/^MODEL_CALL_FAILED: .*no such model/);
    expect((await detail(s(), id)).session.title).toBe("How do I look after a quokka?");
    broken = false;
    expect((await s().client.call("POST", `/api/background/${failed.id}/retry`)).body).toEqual({ retried: true });
    const done = await until(
      async () => (await jobs()).find((j) => j.status === "succeeded"),
      10_000,
      "the retried title task",
    );
    expect(JSON.parse(done.result!)).toEqual({ title: "Quokka care tips" });
    // The copy of the first exchange is gone once the title is set.
    expect(done.payload).not.toContain("quokka");
    expect((await detail(s(), id)).session.title).toBe("Quokka care tips");
  });

  it("refuses a bad setting and needs a signed-in client", async () => {
    await start();
    for (const body of [
      { enabled: "yes" },
      { model: "" },
      { model: "two words" },
      { model: 5 },
      { model: "m".repeat(101) },
    ]) {
      const res = await put(body);
      expect([res.status, res.body.error.code], JSON.stringify(body)).toEqual([400, "bad_request"]);
    }
    expect((await s().client.raw("GET", "/api/settings/titles", { cookie: false })).status).toBe(401);
  });

  it("cleanTitle keeps one plain line", () => {
    expect(cleanTitle('"Quokka care tips."')).toBe("Quokka care tips");
    expect(cleanTitle("Title: Trip to Kyoto\nextra")).toBe("Trip to Kyoto");
    expect(cleanTitle("**Plan**")).toBe("Plan");
    expect(cleanTitle("  \n ")).toBeUndefined();
    expect(cleanTitle("x".repeat(80))!.length).toBe(60);
  });
});
