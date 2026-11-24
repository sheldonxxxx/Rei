import { AVATAR_IMAGE_MAX_CHARS } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeAvatar } from "../src/util/avatar.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

// 1x1 transparent png.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("normalizeAvatar", () => {
  it.each([
    ["bot:sprout", "bot:sprout"],
    ["bot:some-new-bot-2", "bot:some-new-bot-2"],
    ["🦊", "🦊"],
    ["  ✦ ", "✦"],
    ["AI", "AI"],
    ["12345678", "12345678"],
    ["👨‍👩‍👧", "👨‍👩‍👧"],
    [PNG, PNG],
    ["data:image/webp;base64,AAAA", "data:image/webp;base64,AAAA"],
    ["data:image/jpeg;base64,QQ==", "data:image/jpeg;base64,QQ=="],
  ])("accepts %j", (input, stored) => {
    expect(normalizeAvatar(input)).toBe(stored);
  });

  it.each([
    "",
    "   ",
    "123456789",
    "a\nb",
    "a\u0000",
    "bot:",
    "bot:Upper",
    "bot:has space",
    `bot:${"a".repeat(33)}`,
    "data:",
    "data:text/html;base64,AAAA",
    "data:image/svg+xml;base64,AAAA",
    "data:image/gif;base64,AAAA",
    "data:image/png;base64,",
    "data:image/png;base64,AAA",
    "data:image/png;base64,AA=A",
    "data:image/png;base64,not base64!",
    "data:image/png,AAAA",
    "data:image/png;base64,AAAA\n",
  ])("rejects %j", (input) => {
    expect(normalizeAvatar(input)).toBeNull();
  });

  it("rejects things that are not text and a data URL that is too long", () => {
    for (const value of [undefined, null, 5, {}, ["bot:cat"]]) expect(normalizeAvatar(value)).toBeNull();
    // The prefix is 22 characters, so the longest payload that is whole base64 quads ends 2 under the limit.
    const payload = (chars: number) => "A".repeat(chars - "data:image/png;base64,".length);
    expect(normalizeAvatar(`data:image/png;base64,${payload(AVATAR_IMAGE_MAX_CHARS - 2)}`)).not.toBeNull();
    expect(normalizeAvatar(`data:image/png;base64,${payload(AVATAR_IMAGE_MAX_CHARS + 2)}`)).toBeNull();
  });
});

describe("PATCH /api/agents/:id", () => {
  const agentId = async (s: TestServer): Promise<string> => (await s.client.get("/api/agents")).body.defaultAgentId;

  it("seeds the default agent with the sprout bot", async () => {
    server = await startSignedIn();
    const { agents } = (await server.client.get("/api/agents")).body;
    expect(agents).toHaveLength(1);
    expect(agents[0].avatar).toBe("bot:sprout");
  });

  it("accepts a bot id, an emoji and a small picture, answers the agent and sends agent.upserted to the global stream", async () => {
    server = await startSignedIn();
    const id = await agentId(server);
    const stream = await server.sse("/api/stream");
    await stream.waitFor((e) => e.event === "snapshot");
    for (const [sent, stored] of [
      ["bot:cat", "bot:cat"],
      [" 🦊 ", "🦊"],
      [PNG, PNG],
    ] as const) {
      const r = await server.client.call("PATCH", `/api/agents/${id}`, { body: { avatar: sent } });
      expect(r.status, sent).toBe(200);
      expect(r.body.agent).toMatchObject({ id, avatar: stored });
      const seen = await stream.waitFor((e) => e.event === "agent.upserted" && e.data.agent.avatar === stored);
      expect(seen.data.agent.id).toBe(id);
      expect((await server.client.get("/api/agents")).body.agents[0].avatar).toBe(stored);
    }
    await stream.close();
  });

  it("rejects every other form with bad_avatar and changes nothing", async () => {
    server = await startSignedIn();
    const id = await agentId(server);
    const tooLong = `data:image/png;base64,${"A".repeat(AVATAR_IMAGE_MAX_CHARS)}`;
    for (const avatar of [
      "",
      "123456789",
      "bot:Nope",
      "data:text/html;base64,AAAA",
      "data:image/png;base64,@@@@",
      tooLong,
      5,
      null,
      ["bot:cat"],
    ]) {
      const r = await server.client.call("PATCH", `/api/agents/${id}`, { body: { avatar } });
      expect(r.status, JSON.stringify(avatar).slice(0, 40)).toBe(400);
      expect(r.body.error.code).toBe("bad_avatar");
    }
    expect((await server.client.get("/api/agents")).body.agents[0].avatar).toBe("bot:sprout");
  });

  it("answers the agent unchanged when there is nothing to change, and not_found for an unknown agent", async () => {
    server = await startSignedIn();
    const id = await agentId(server);
    const same = await server.client.call("PATCH", `/api/agents/${id}`, { body: {} });
    expect(same.status).toBe(200);
    expect(same.body.agent.avatar).toBe("bot:sprout");
    const missing = await server.client.call("PATCH", "/api/agents/agt_nope", { body: { avatar: "bot:cat" } });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");
  });

  it("answers 401 without the cookie and 403 without the CSRF header", async () => {
    server = await startSignedIn();
    const id = await agentId(server);
    const noCsrf = await server.client.call("PATCH", `/api/agents/${id}`, { csrf: false, body: { avatar: "bot:cat" } });
    expect(noCsrf.status).toBe(403);
    const noCookie = await server.client.call("PATCH", `/api/agents/${id}`, {
      cookie: false,
      body: { avatar: "bot:cat" },
    });
    expect(noCookie.status).toBe(401);
    expect((await server.client.get("/api/agents")).body.agents[0].avatar).toBe("bot:sprout");
  });
});
