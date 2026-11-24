import { describe, expect, it } from "vitest";
import { initSecrets } from "../src/init.ts";
import { FakeStack, makeRig, ROOT, SET_UP_SECRETS } from "./fakes.ts";

const DIR = `${ROOT}/containers/.secrets`;
const SECRETS = `${DIR}/secrets.env`;
const ENV = `${ROOT}/containers/.env`;
const VOLUMES = ["gateway-data", "reader-data", "garage-meta", "garage-data", "qdrant-data", "qdrant-snapshots"];

/** A fresh machine: no .env, no secrets, no volumes. */
function fresh(env: Record<string, string> = {}) {
  const prefix = env.REI_PROJECT || "rei";
  const rig = makeRig({ checkout: false, env, missingVolumes: VOLUMES.map((v) => `${prefix}_${v}`) });
  const lines: string[] = [];
  return { ...rig, lines, run: () => initSecrets(rig.ctx, (line) => lines.push(line)) };
}

const value = (text: string, name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(text)?.[1];

describe("rei init", () => {
  it("makes .env, secrets.env (0600, in the layout init.sh wrote) and the six external volumes", async () => {
    const r = fresh();
    expect(await r.run()).toBe(0);
    expect(r.host.files.get(ENV)).toEqual({ text: "", mode: 0o644 });
    const file = r.host.files.get(SECRETS)!;
    expect(file.mode).toBe(0o600);
    // The same variables, in the same order, with the same shapes as before.
    const keys = file.text
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => l.split("=")[0]);
    expect(keys).toEqual([
      "REI_STANDIN",
      "GARAGE_RPC_SECRET",
      "GARAGE_ADMIN_TOKEN",
      "GARAGE_DEFAULT_BUCKET",
      "GARAGE_DEFAULT_ACCESS_KEY",
      "GARAGE_DEFAULT_SECRET_KEY",
      "QDRANT__SERVICE__API_KEY",
      "REI_EVENTS_KEY",
    ]);
    expect(value(file.text, "REI_STANDIN")).toMatch(/^[A-Za-z0-9]{38,43}$/);
    expect(value(file.text, "GARAGE_RPC_SECRET")).toMatch(/^[0-9a-f]{64}$/);
    expect(value(file.text, "GARAGE_ADMIN_TOKEN")).toMatch(/^[0-9a-f]{32}$/);
    expect(value(file.text, "GARAGE_DEFAULT_BUCKET")).toBe("rei-files");
    expect(value(file.text, "GARAGE_DEFAULT_ACCESS_KEY")).toMatch(/^GK[0-9a-f]{32}$/);
    expect(value(file.text, "GARAGE_DEFAULT_SECRET_KEY")).toMatch(/^[0-9a-f]{64}$/);
    expect(value(file.text, "QDRANT__SERVICE__API_KEY")).toMatch(/^[0-9a-f]{64}$/);
    expect(value(file.text, "REI_EVENTS_KEY")).toMatch(/^[0-9a-f]{64}$/);
    // Written beside the target, then moved into place.
    expect(r.host.writes.map((w) => w.path)).toEqual([ENV, `${SECRETS}.tmp`, SECRETS]);
    expect(r.stack.calls.filter((c) => c.startsWith("volume create"))).toEqual(
      VOLUMES.map((v) => `volume create rei_${v}`),
    );
    expect(r.lines).toContain(`created ${SECRETS}`);
    // What it prints names paths and volumes, never a value.
    for (const line of r.lines) expect(line).not.toContain(value(file.text, "GARAGE_RPC_SECRET")!);
  });

  it("makes different values on every machine", async () => {
    const a = fresh();
    const b = fresh();
    await a.run();
    await b.run();
    expect(value(a.host.readText(SECRETS)!, "REI_STANDIN")).not.toBe(value(b.host.readText(SECRETS)!, "REI_STANDIN"));
    expect(value(a.host.readText(SECRETS)!, "REI_EVENTS_KEY")).not.toBe(
      value(b.host.readText(SECRETS)!, "REI_EVENTS_KEY"),
    );
  });

  it("a second run changes nothing: no write, no volume", async () => {
    const r = makeRig();
    const lines: string[] = [];
    expect(await initSecrets(r.ctx, (l) => lines.push(l))).toBe(0);
    expect(r.host.writes).toEqual([]);
    expect(r.host.readText(SECRETS)).toBe(SET_UP_SECRETS);
    expect(r.stack.calls.some((c) => c.startsWith("volume create"))).toBe(false);
    expect(lines).toEqual([]);
  });

  it("a file that lost a variable gets it back and keeps every other value exactly", async () => {
    const r = makeRig();
    const without = SET_UP_SECRETS.replace(/^REI_EVENTS_KEY=.*\n/m, "").replace(
      /^GARAGE_ADMIN_TOKEN=.*$/m,
      "GARAGE_ADMIN_TOKEN=",
    );
    r.host.files.set(SECRETS, { text: without, mode: 0o600 });
    expect(await initSecrets(r.ctx, () => {})).toBe(0);
    const text = r.host.readText(SECRETS)!;
    for (const name of [
      "REI_STANDIN",
      "GARAGE_RPC_SECRET",
      "GARAGE_DEFAULT_ACCESS_KEY",
      "GARAGE_DEFAULT_SECRET_KEY",
      "QDRANT__SERVICE__API_KEY",
    ])
      expect(value(text, name)).toBe(value(SET_UP_SECRETS, name));
    expect(value(text, "REI_EVENTS_KEY")).toMatch(/^[0-9a-f]{64}$/);
    // An empty line is a missing value, so a new one is made.
    expect(value(text, "GARAGE_ADMIN_TOKEN")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("migrates the one-file-per-value layout: the same values, then the old files are removed", async () => {
    const r = fresh();
    const old: Record<string, string> = {
      standin: "old-standin-value\n",
      "garage/rpc-secret": `${"a".repeat(64)}\n`,
      "garage/admin-token": `${"b".repeat(32)}\n`,
      "garage/access-key": `GK${"c".repeat(32)}\n`,
      "garage/secret-key": `${"d".repeat(64)}\n`,
      "garage/default-keys.env": "x\n",
      "garage/garage.toml": "x\n",
      "qdrant-api-key": `${"e".repeat(64)}\n`,
      "qdrant.env": "QDRANT__SERVICE__API_KEY=x\n",
    };
    for (const [name, text] of Object.entries(old)) r.host.files.set(`${DIR}/${name}`, { text, mode: 0o600 });
    r.host.dirs.push(`${DIR}/garage`);
    expect(await r.run()).toBe(0);
    const text = r.host.readText(SECRETS)!;
    expect(value(text, "REI_STANDIN")).toBe("old-standin-value");
    expect(value(text, "GARAGE_RPC_SECRET")).toBe("a".repeat(64));
    expect(value(text, "GARAGE_ADMIN_TOKEN")).toBe("b".repeat(32));
    expect(value(text, "GARAGE_DEFAULT_ACCESS_KEY")).toBe(`GK${"c".repeat(32)}`);
    expect(value(text, "GARAGE_DEFAULT_SECRET_KEY")).toBe("d".repeat(64));
    expect(value(text, "QDRANT__SERVICE__API_KEY")).toBe("e".repeat(64));
    // The old layout had no events key, so it is new.
    expect(value(text, "REI_EVENTS_KEY")).toMatch(/^[0-9a-f]{64}$/);
    for (const name of Object.keys(old)) expect(r.host.files.has(`${DIR}/${name}`), name).toBe(false);
    expect(r.host.dirs).not.toContain(`${DIR}/garage`);
    expect(r.lines).toContain(`removed ${DIR}/standin (its value is in secrets.env)`);
  });

  it("an empty old file does not count: a new value is made", async () => {
    const r = fresh();
    r.host.files.set(`${DIR}/standin`, { text: "", mode: 0o600 });
    expect(await r.run()).toBe(0);
    expect(value(r.host.readText(SECRETS)!, "REI_STANDIN")).toMatch(/^[A-Za-z0-9]{38,43}$/);
    expect(r.host.files.has(`${DIR}/standin`)).toBe(false);
  });

  it("removes an empty search folder, and only names one that still holds keys", async () => {
    const empty = makeRig();
    empty.host.dirs.push(`${DIR}/search`);
    const lines: string[] = [];
    await initSecrets(empty.ctx, (l) => lines.push(l));
    expect(empty.host.dirs).not.toContain(`${DIR}/search`);
    expect(lines).toEqual([`removed ${DIR}/search (empty; web search is configured in the web app)`]);

    const full = makeRig();
    full.host.files.set(`${DIR}/search/brave`, { text: "brave-key-SECRET-9876\n", mode: 0o600 });
    const notes: string[] = [];
    await initSecrets(full.ctx, (l) => notes.push(l));
    expect(full.host.files.has(`${DIR}/search/brave`)).toBe(true);
    expect(notes.join("\n")).toContain("is no longer read");
    expect(notes.join("\n")).not.toContain("brave-key-SECRET-9876");
  });

  it("names the volumes after REI_PROJECT", async () => {
    const r = fresh({ REI_PROJECT: "rei-test" });
    expect(await r.run()).toBe(0);
    expect(r.stack.calls.filter((c) => c.startsWith("volume create"))).toEqual(
      VOLUMES.map((v) => `volume create rei-test_${v}`),
    );
  });

  it("without docker it still makes the secrets, and says the volumes were not created", async () => {
    const r = makeRig({ checkout: false, dockerMissing: true });
    const lines: string[] = [];
    expect(await initSecrets(r.ctx, (l) => lines.push(l))).toBe(0);
    expect(r.host.files.get(SECRETS)?.mode).toBe(0o600);
    expect(lines.at(-1)).toContain("docker not found; the storage volumes were not created");
  });

  it("fails when a volume cannot be created", async () => {
    const r = fresh();
    r.stack.run = async (cmd, args, opts) =>
      cmd === "docker" && args[1] === "create"
        ? { code: 1, stdout: "", stderr: "Error response from daemon: disk full\n" }
        : FakeStack.prototype.run.call(r.stack, cmd, args, opts);
    expect(await r.run()).toBe(1);
    expect(r.lines.join("\n")).toContain(
      "could not create volume rei_gateway-data: Error response from daemon: disk full",
    );
  });
});
