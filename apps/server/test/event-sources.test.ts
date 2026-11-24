import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeDatabase } from "../src/db/schema.ts";
import { DEFAULT_GRACE_MS, EventSources, parseEventsKey } from "../src/events/sources.ts";
import { parseGrace, run } from "../src/node/events-cli.ts";
import { openSqliteDb } from "../src/node/sqlite-db.ts";

const KEY = parseEventsKey("ab".repeat(32))!;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function open(now: { t: number } = { t: 1_000_000 }) {
  const dir = mkdtempSync(join(tmpdir(), "rei-sources-"));
  dirs.push(dir);
  const db = openSqliteDb(join(dir, "app.sqlite"));
  initializeDatabase(db);
  return { dir, db, now, sources: new EventSources(db, KEY, () => now.t) };
}

describe("event sources", () => {
  it("adds a source, shows the secret once and keeps it encrypted", async () => {
    const { dir, db, sources } = open();
    const { secret, source } = await sources.add("my-service", "My service");
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(source).toMatchObject({ id: "my-service", name: "My service", status: "active" });
    expect(JSON.stringify(sources.list())).not.toContain(secret);
    expect(await sources.validSecrets("my-service")).toEqual([secret]);
    db.checkpoint?.();
    db.close();
    for (const f of readdirSync(dir))
      expect(readFileSync(join(dir, f)).includes(Buffer.from(secret.slice(6)))).toBe(false);
  });

  it("refuses bad and repeated ids", async () => {
    const { sources } = open();
    await expect(sources.add("A-bad")).rejects.toThrow(/lowercase/);
    await expect(sources.add("x")).rejects.toThrow(/lowercase/);
    await sources.add("one");
    await expect(sources.add("one")).rejects.toThrow(/already exists/);
  });

  it("will not open a blob moved to another source", async () => {
    const { db, sources } = open();
    await sources.add("aa");
    await sources.add("bb");
    const a = db.get<{ secret: string }>("SELECT secret FROM event_sources WHERE id = 'aa'")!.secret;
    db.run("UPDATE event_sources SET secret = ? WHERE id = 'bb'", a);
    expect(await sources.validSecrets("bb")).toEqual([]);
  });

  it("keeps the old secret for the grace period only", async () => {
    const { sources, now } = open();
    const first = (await sources.add("rot")).secret;
    const { secret: second, graceUntil } = await sources.rotate("rot");
    expect(graceUntil).toBe(now.t + DEFAULT_GRACE_MS);
    expect(await sources.validSecrets("rot")).toEqual([second, first]);
    now.t += DEFAULT_GRACE_MS;
    expect(await sources.validSecrets("rot")).toEqual([second]);
    const third = (await sources.rotate("rot", 0)).secret;
    expect(await sources.validSecrets("rot")).toEqual([third]);
  });

  it("answers the same for a disabled source and an unknown one", async () => {
    const { sources } = open();
    await sources.add("off");
    sources.setStatus("off", "disabled");
    expect(await sources.validSecrets("off")).toBeUndefined();
    expect(await sources.validSecrets("nope")).toBeUndefined();
    sources.setStatus("off", "active");
    expect(await sources.validSecrets("off")).toHaveLength(1);
  });

  it("refuses to remove a source a trigger listens to, unless forced, which pauses them", async () => {
    const { db, sources } = open();
    await sources.add("busy");
    db.run(
      `INSERT INTO triggers (id, agent_id, name, schedule_json, action_json, landing, report, lateness_minutes, profile, status, created_at, updated_at, start_kind, event_json)
       VALUES ('t1', 'a', 'Watch', 'null', '{}', 'new', 'never', 1, 'standard', 'active', 1, 1, 'event', '{"source":"busy","types":["*"]}')`,
    );
    expect(() => sources.remove("busy", false)).toThrow(/Watch/);
    expect(sources.remove("busy", true)).toEqual({ paused: 1 });
    expect(db.get<{ status: string }>("SELECT status FROM triggers WHERE id = 't1'")!.status).toBe("paused");
    expect(sources.get("busy")).toBeUndefined();
  });

  it("lists the last event and the types of the last 30 days", async () => {
    const { db, sources, now } = open();
    await sources.add("seen");
    const ev = (id: string, type: string, at: number) =>
      db.run(
        "INSERT INTO events (id, source, webhook_id, type, ref, received_at) VALUES (?, 'seen', ?, ?, 'r', ?)",
        id,
        id,
        type,
        at,
      );
    ev("e1", "old.type", now.t - 40 * 86_400_000);
    ev("e2", "items.new", now.t - 1000);
    expect(sources.list()[0]).toMatchObject({ lastEventAt: now.t - 1000, types: ["items.new"] });
  });
});

describe("the sources command", () => {
  it("parses a grace period", () => {
    expect(parseGrace("24h")).toBe(DEFAULT_GRACE_MS);
    expect(parseGrace("0")).toBe(0);
    expect(parseGrace("30m")).toBe(1_800_000);
    expect(() => parseGrace("soon")).toThrow();
  });

  it("adds, lists and removes through the same database, printing the secret once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rei-sources-cli-"));
    dirs.push(dir);
    const db = openSqliteDb(join(dir, "app.sqlite"));
    initializeDatabase(db);
    db.close();
    const env = { REI_DATA: dir, REI_EVENTS_KEY: "cd".repeat(32), REI_PUBLIC_URL: "http://rei.test:8787/" };
    const say = async (...argv: string[]) => {
      const lines: string[] = [];
      const code = await run(["sources", ...argv], env, (l) => lines.push(l));
      return { code, text: lines.join("\n") };
    };
    const added = await say("add", "my-service", "--name", "My service");
    expect(added.code).toBe(0);
    expect(added.text).toContain("POST http://rei.test:8787/api/events/my-service");
    const secret = /Secret:\s+(whsec_\S+)/.exec(added.text)![1]!;
    const listed = await say("list");
    expect(listed.text).toContain("my-service  active");
    expect(listed.text).not.toContain(secret);
    expect((await say("rotate", "my-service", "--grace", "0")).text).toContain("no longer works");
    expect((await say("disable", "my-service")).code).toBe(0);
    expect((await say("remove", "my-service")).text).toContain("Removed");
    expect((await say("remove", "my-service")).code).toBe(1);
    expect((await say("bogus")).code).toBe(2);
  });

  it("says what is missing when there is no key", async () => {
    const lines: string[] = [];
    const code = await run(["sources", "list"], {}, (l) => lines.push(l));
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("REI_EVENTS_KEY");
  });
});
