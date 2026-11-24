import { describe, expect, it } from "vitest";
import { callers } from "../src/commands/callers.ts";
import { GarageAdmin, restrictReiStorageKey, StorageError, validateStorageId } from "../src/storage/garage.ts";
import type { Rig } from "./fakes.ts";
import { makeRig, SHARED } from "./fakes.ts";

/** The fields the fake reads from a request. */
interface Payload {
  globalAlias: string;
  name: string;
  id: string;
  bucketId: string;
  accessKeyId: string;
  permissions: { read?: boolean; write?: boolean; owner?: boolean };
  body?: { deny?: { createBucket?: boolean } };
}

interface Bucket {
  id: string;
  alias: string;
  objects: number;
  bytes: number;
  keys: Map<string, { read: boolean; write: boolean; owner: boolean }>;
}
interface Key {
  id: string;
  name: string;
  createBucket: boolean;
  secret: string;
}

/** A Garage that answers `garage json-api` in the garage container, and a gateway whose `callers list` is scripted. */
function fakeGarage(rig: Rig, opts: { gatewayList?: string } = {}) {
  const buckets = new Map<string, Bucket>();
  const keys = new Map<string, Key>();
  keys.set("GKrei", { id: "GKrei", name: "default access key", createBucket: true, secret: "reisecret" });
  buckets.set("rei-files", { id: "b-rei", alias: "rei-files", objects: 3, bytes: 10, keys: new Map() });
  const requests: { endpoint: string; payload: Record<string, unknown> | null }[] = [];
  const gatewayCalls: string[][] = [];
  let seq = 0;
  const notFound = (what: string) => ({ code: 1, stdout: "", stderr: `Error: NoSuch${what} (404): not found\n` });
  const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
  const bucketJson = (b: Bucket) => ({
    id: b.id,
    globalAliases: [b.alias],
    objects: b.objects,
    bytes: b.bytes,
    keys: [...b.keys].map(([accessKeyId, permissions]) => ({ accessKeyId, permissions })),
  });
  const original = rig.stack.run.bind(rig.stack);
  rig.stack.run = async (cmd, args, o) => {
    const i = args.indexOf("json-api");
    if (cmd === "docker" && args.includes(SHARED) && i > 0 && args.includes("garage")) {
      expect(args.slice(args.indexOf("exec"), args.indexOf("exec") + 3)).toEqual(["exec", "-T", "garage"]);
      const endpoint = args[i + 1] as string;
      const payload = JSON.parse(args[i + 2] ?? "null") as Record<string, unknown> | null;
      requests.push({ endpoint, payload });
      const p = (payload ?? {}) as unknown as Payload;
      switch (endpoint) {
        case "GetBucketInfo": {
          const b = buckets.get(p.globalAlias);
          return b ? ok(bucketJson(b)) : notFound("Bucket");
        }
        case "CreateBucket": {
          const b: Bucket = { id: `b-${++seq}`, alias: p.globalAlias, objects: 0, bytes: 0, keys: new Map() };
          buckets.set(b.alias, b);
          return ok(bucketJson(b));
        }
        case "ListKeys":
          return ok([...keys.values()].map((k) => ({ id: k.id, name: k.name, created: `2026-01-0${k.id.length}` })));
        case "ListBuckets":
          return ok([...buckets.values()].map((b) => ({ id: b.id, globalAliases: [b.alias] })));
        case "CreateKey": {
          const k: Key = { id: `GK${++seq}`, name: p.name, createBucket: false, secret: `secret-${seq}` };
          keys.set(k.id, k);
          return ok({
            accessKeyId: k.id,
            name: k.name,
            secretAccessKey: k.secret,
            permissions: { createBucket: false },
          });
        }
        case "AllowBucketKey": {
          const b = [...buckets.values()].find((x) => x.id === p.bucketId);
          if (!b) return notFound("Bucket");
          b.keys.set(p.accessKeyId, {
            read: !!p.permissions.read,
            write: !!p.permissions.write,
            owner: !!p.permissions.owner,
          });
          return ok(bucketJson(b));
        }
        case "DeleteKey": {
          if (!keys.delete(p.id)) return notFound("AccessKey");
          for (const b of buckets.values()) b.keys.delete(p.id);
          return ok(null);
        }
        case "DeleteBucket": {
          const b = [...buckets.values()].find((x) => x.id === p.id);
          if (!b) return notFound("Bucket");
          buckets.delete(b.alias);
          return ok(null);
        }
        case "UpdateKey": {
          const k = keys.get(p.id);
          if (!k) return notFound("AccessKey");
          if (p.body?.deny?.createBucket) k.createBucket = false;
          return ok({ accessKeyId: k.id });
        }
      }
      return { code: 1, stdout: "", stderr: `Error: unknown endpoint ${endpoint}` };
    }
    if (cmd === "docker" && args.includes("gateway") && args.includes("list"))
      return { code: 0, stdout: opts.gatewayList ?? "", stderr: "" };
    return original(cmd, args, o);
  };
  const interactive = rig.stack.interactive.bind(rig.stack);
  rig.stack.interactive = async (cmd, args) => {
    if (args.includes("gateway") && args.includes("callers")) {
      gatewayCalls.push(args.slice(args.indexOf("callers") + 1));
      return 0;
    }
    return interactive(cmd, args);
  };
  return { buckets, keys, requests, gatewayCalls };
}

const sent = (g: ReturnType<typeof fakeGarage>) => g.requests.map((r) => r.endpoint);

describe("storage names", () => {
  it.each([
    ["media", undefined],
    ["a", undefined],
    ["my-app-2", undefined],
    ["rei", '"rei" is reserved'],
    ["has_underscore", expect.stringContaining("underscore")],
    ["Upper", expect.stringContaining("lower-case")],
    ["-lead", expect.stringContaining("lower-case")],
    ["trail-", expect.stringContaining("lower-case")],
    ["x".repeat(41), expect.stringContaining("lower-case")],
  ])("validates %s", (id, want) => {
    expect(validateStorageId(id)).toEqual(want);
  });
});

describe("GarageAdmin", () => {
  it("grants a bucket and a key with read and write only, and never owner or createBucket", async () => {
    const rig = makeRig();
    const g = fakeGarage(rig);
    const grant = await new GarageAdmin(rig.ctx).grant("media");

    expect(grant).toMatchObject({ bucket: "caller-media", bucketCreated: true, keyCreated: true });
    expect(grant.secret).toMatch(/^secret-/);
    expect(sent(g)).toEqual(["GetBucketInfo", "CreateBucket", "ListKeys", "CreateKey", "AllowBucketKey"]);
    expect(g.requests.find((r) => r.endpoint === "CreateKey")!.payload).toEqual({ name: "caller-media" });
    const allow = g.requests.find((r) => r.endpoint === "AllowBucketKey")!.payload as unknown as Payload;
    expect(allow.permissions).toEqual({ read: true, write: true });
    expect(JSON.stringify(g.requests)).not.toContain("owner");
    expect(JSON.stringify(g.requests)).not.toContain("createBucket");
    expect(g.buckets.get("caller-media")!.keys.get(grant.keyId)).toEqual({ read: true, write: true, owner: false });
    expect(g.keys.get(grant.keyId)!.createBucket).toBe(false);
  });

  it("is idempotent: a second grant creates nothing and shows no secret", async () => {
    const rig = makeRig();
    const g = fakeGarage(rig);
    const first = await new GarageAdmin(rig.ctx).grant("media");
    const before = g.requests.length;
    const again = await new GarageAdmin(rig.ctx).grant("media");

    expect(again).toMatchObject({ keyId: first.keyId, bucketCreated: false, keyCreated: false });
    expect(again.secret).toBeUndefined();
    expect(g.requests.slice(before).map((r) => r.endpoint)).toEqual(["GetBucketInfo", "ListKeys", "AllowBucketKey"]);
    expect([...g.keys.values()].filter((k) => k.name === "caller-media")).toHaveLength(1);
  });

  it("rotates: a new key is made and allowed, then the old one is deleted", async () => {
    const rig = makeRig();
    const g = fakeGarage(rig);
    const admin = new GarageAdmin(rig.ctx);
    const first = await admin.grant("media");
    const next = await admin.rotate("media");

    expect(next.keyId).not.toBe(first.keyId);
    expect(next.secret).toBeDefined();
    expect(g.keys.has(first.keyId)).toBe(false);
    expect(g.buckets.get("caller-media")!.keys.has(next.keyId)).toBe(true);
    await expect(admin.rotate("nobody")).rejects.toThrow(/has no storage/);
  });

  it("revokes by deleting the key and keeps the bucket", async () => {
    const rig = makeRig();
    const g = fakeGarage(rig);
    const admin = new GarageAdmin(rig.ctx);
    await admin.grant("media");

    expect(await admin.revoke("media")).toBe(1);
    expect(await admin.revoke("media")).toBe(0);
    expect(g.buckets.has("caller-media")).toBe(true);
    expect(g.keys.has("GKrei")).toBe(true);
  });

  it("purge refuses an active key and a non-empty bucket, names the bucket, and deletes an empty one", async () => {
    const rig = makeRig();
    const g = fakeGarage(rig);
    const admin = new GarageAdmin(rig.ctx);
    await admin.grant("media");
    await expect(admin.purge("media")).rejects.toThrow(/revoke/);
    await admin.revoke("media");
    g.buckets.get("caller-media")!.objects = 2;
    await expect(admin.purge("media")).rejects.toThrow(/caller-media is not empty \(2 objects/);
    expect(g.buckets.has("caller-media")).toBe(true);
    g.buckets.get("caller-media")!.objects = 0;
    expect(await admin.purge("media")).toBe(true);
    expect(g.buckets.has("caller-media")).toBe(false);
    expect(await admin.purge("media")).toBe(false);
    expect(g.buckets.has("rei-files")).toBe(true);
  });

  it("takes createBucket from Rei's key by its name, without reading a secret", async () => {
    const rig = makeRig();
    const g = fakeGarage(rig);

    expect(await restrictReiStorageKey(rig.ctx)).toBeUndefined();
    expect(g.keys.get("GKrei")!.createBucket).toBe(false);
    expect(g.requests.find((r) => r.endpoint === "UpdateKey")!.payload).toEqual({
      id: "GKrei",
      body: { deny: { createBucket: true } },
    });
    expect(rig.host.writes).toEqual([]);
  });

  it("says so when Garage is not running", async () => {
    const rig = makeRig();
    rig.stack.run = async () => ({ code: 1, stdout: "", stderr: 'service "garage" is not running' });
    await expect(new GarageAdmin(rig.ctx).grant("media")).rejects.toBeInstanceOf(StorageError);
    expect(await restrictReiStorageKey(rig.ctx)).toContain("not running");
  });
});

describe("rei callers --storage", () => {
  it("add: the gateway adds first with --storage removed, then the credentials print once", async () => {
    const rig = makeRig();
    const g = fakeGarage(rig);

    expect(await callers(rig.ctx, ["add", "media", "--storage", "--note", "x"])).toBe(0);
    expect(g.gatewayCalls).toEqual([["add", "media", "--note", "x"]]);
    const text = rig.out.text;
    expect(text).toContain("Storage for media (network rei-storage-shared, external)");
    expect(text).toContain("S3        http://rei-garage:3900  region garage  path-style  bucket caller-media");
    expect(text).toMatch(/key id {4}GK\d+/);
    expect(text).toMatch(/secret {4}secret-\d+ +\(shown once\)/);
  });

  it("add refuses an id that cannot be a bucket before the gateway is touched", async () => {
    const rig = makeRig();
    const g = fakeGarage(rig);

    expect(await callers(rig.ctx, ["add", "a_b", "--storage"])).toBe(1);
    expect(await callers(rig.ctx, ["add", "rei", "--storage"])).toBe(1);
    expect(g.gatewayCalls).toEqual([]);
    expect(g.requests).toEqual([]);
  });

  it("add: a storage failure after the gateway token says what exists and what to run", async () => {
    const rig = makeRig();
    const g = fakeGarage(rig);
    const run = rig.stack.run.bind(rig.stack);
    rig.stack.run = async (cmd, args, o) =>
      args.includes("CreateBucket") ? { code: 1, stdout: "", stderr: "Error: boom" } : run(cmd, args, o);

    expect(await callers(rig.ctx, ["add", "media", "--storage"])).toBe(1);
    expect(g.gatewayCalls).toHaveLength(1);
    expect(rig.out.text).toContain("media exists in the gateway; its storage was not made.");
    expect(rig.out.text).toContain("./rei callers set media --storage");
  });

  it("set --storage alone grants storage to an existing caller and never touches the gateway's settings", async () => {
    const rig = makeRig();
    const g = fakeGarage(rig, { gatewayList: "media  active  scopes models\n  budget\n" });

    expect(await callers(rig.ctx, ["set", "media", "--storage"])).toBe(0);
    expect(g.gatewayCalls).toEqual([]);
    expect(rig.out.text).toContain("bucket caller-media");

    const missing = makeRig();
    const g2 = fakeGarage(missing, { gatewayList: "" });
    expect(await callers(missing.ctx, ["set", "ghost", "--storage"])).toBe(1);
    expect(missing.out.text).toContain("not a caller");
    expect(g2.requests).toEqual([]);

    const revoked = makeRig();
    fakeGarage(revoked, { gatewayList: "media  revoked 2026-01-01  scopes models\n" });
    expect(await callers(revoked.ctx, ["set", "media", "--storage"])).toBe(1);
  });

  it("set with other options sends them to the gateway first", async () => {
    const rig = makeRig();
    const g = fakeGarage(rig);

    expect(await callers(rig.ctx, ["set", "media", "--note", "n", "--storage"])).toBe(0);
    expect(g.gatewayCalls).toEqual([["set", "media", "--note", "n"]]);
  });

  it("set --storage on an existing key does not print the secret again", async () => {
    const rig = makeRig();
    fakeGarage(rig, { gatewayList: "media  active  scopes models\n" });
    await callers(rig.ctx, ["set", "media", "--storage"]);
    rig.out.lines.length = 0;

    expect(await callers(rig.ctx, ["set", "media", "--storage"])).toBe(0);
    expect(rig.out.text).toContain("secret    unchanged");
    expect(rig.out.text).not.toMatch(/secret-\d+/);
  });

  it("rotate --storage rotates storage only; plain rotate goes to the gateway only", async () => {
    const rig = makeRig();
    const g = fakeGarage(rig);
    await new GarageAdmin(rig.ctx).grant("media");
    rig.out.lines.length = 0;

    expect(await callers(rig.ctx, ["rotate", "media", "--storage"])).toBe(0);
    expect(g.gatewayCalls).toEqual([]);
    expect(rig.out.text).toMatch(/secret {4}secret-\d+/);

    const plain = makeRig();
    const g2 = fakeGarage(plain);
    expect(await callers(plain.ctx, ["rotate", "media", "--grace", "0"])).toBe(0);
    expect(g2.gatewayCalls).toEqual([["rotate", "media", "--grace", "0"]]);
    expect(g2.requests).toEqual([]);
  });

  it("revoke removes the gateway token and the storage key, and keeps the bucket", async () => {
    const rig = makeRig();
    const g = fakeGarage(rig);
    await new GarageAdmin(rig.ctx).grant("media");

    expect(await callers(rig.ctx, ["revoke", "media"])).toBe(0);
    expect(g.gatewayCalls).toEqual([["revoke", "media"]]);
    expect([...g.keys.values()].some((k) => k.name === "caller-media")).toBe(false);
    expect(g.buckets.has("caller-media")).toBe(true);
    expect(rig.out.text).toContain("Storage key of media deleted");
  });

  it("revoke of a caller without storage prints nothing about storage", async () => {
    const rig = makeRig();
    fakeGarage(rig);
    expect(await callers(rig.ctx, ["revoke", "plain"])).toBe(0);
    expect(rig.out.text).toBe("");
  });

  it("list adds a line per caller with storage", async () => {
    const rig = makeRig();
    const g = fakeGarage(rig);
    await new GarageAdmin(rig.ctx).grant("media");

    expect(await callers(rig.ctx, ["list"])).toBe(0);
    expect(g.gatewayCalls).toEqual([["list"]]);
    expect(rig.out.text).toMatch(/media {2}storage caller-media {2}key GK\d+, 0 objects/);
    expect(rig.out.text).not.toContain("rei-files");
  });

  it("purge: refuses an active caller, asks for the id, and --yes skips the question", async () => {
    const active = makeRig({ answers: [] });
    const ga = fakeGarage(active, { gatewayList: "media  active  scopes models\n" });
    expect(await callers(active.ctx, ["purge", "media"])).toBe(1);
    expect(active.out.text).toContain("still an active caller");
    expect(ga.requests).toEqual([]);

    const rig = makeRig({ answers: ["wrong"] });
    const g = fakeGarage(rig, { gatewayList: "media  revoked 2026-01-01  scopes models\n" });
    await new GarageAdmin(rig.ctx).grant("media");
    await new GarageAdmin(rig.ctx).revoke("media");
    expect(await callers(rig.ctx, ["purge", "media"])).toBe(1);
    expect(g.buckets.has("caller-media")).toBe(true);
    expect(rig.prompter.asked.join()).toContain("Type media");

    expect(await callers(rig.ctx, ["purge", "media", "--yes"])).toBe(0);
    expect(g.buckets.has("caller-media")).toBe(false);
  });

  it("purge without a terminal and without --yes refuses", async () => {
    const rig = makeRig({ answers: null });
    const g = fakeGarage(rig, { gatewayList: "" });
    await new GarageAdmin(rig.ctx).grant("media");
    await new GarageAdmin(rig.ctx).revoke("media");

    expect(await callers(rig.ctx, ["purge", "media"])).toBe(1);
    expect(g.buckets.has("caller-media")).toBe(true);
  });

  it("purge names a non-empty bucket and keeps it", async () => {
    const rig = makeRig({ answers: [] });
    const g = fakeGarage(rig, { gatewayList: "" });
    await new GarageAdmin(rig.ctx).grant("media");
    await new GarageAdmin(rig.ctx).revoke("media");
    g.buckets.get("caller-media")!.objects = 5;

    expect(await callers(rig.ctx, ["purge", "media", "--yes"])).toBe(1);
    expect(rig.out.text).toContain("caller-media is not empty (5 objects");
    expect(g.buckets.has("caller-media")).toBe(true);
  });

  it("rejects --storage on other commands and --yes outside purge", async () => {
    const rig = makeRig();
    const g = fakeGarage(rig);
    expect(await callers(rig.ctx, ["revoke", "media", "--storage"])).toBe(1);
    expect(await callers(rig.ctx, ["list", "--yes"])).toBe(1);
    expect(g.gatewayCalls).toEqual([]);
  });
});
