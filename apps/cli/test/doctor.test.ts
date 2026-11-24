import { describe, expect, it } from "vitest";
import { doctor } from "../src/commands/doctor.ts";
import type { Row } from "../src/format.ts";
import type { RigOptions } from "./fakes.ts";
import { makeRig, ROOT, SECRET, SERVICES, SHARED, SHARED_BUILD } from "./fakes.ts";

async function diagnose(o: RigOptions = {}, json = false) {
  const rig = makeRig(o);
  const code = await doctor(rig.ctx, { json });
  const rows: Row[] = json ? (JSON.parse(rig.out.text) as { checks: Row[] }).checks : [];
  const get = (id: string) => rows.find((r) => r.id === id);
  return { rig, code, rows, get };
}

describe("doctor", () => {
  it("a healthy stack: no failures, exit 0, nothing changed", async () => {
    const { rig, code } = await diagnose();
    expect(code).toBe(0);
    expect(rig.out.text).not.toMatch(/^FAIL/m);
    expect(rig.out.text).toMatch(/^(All checks passed\.|No failures)/m);
  });

  it("is read-only: it never calls up, run, stop, rm, restart or --force-recreate, and writes nothing", async () => {
    for (const o of [
      {},
      { missingAlias: ["gateway"] },
      { stuck: ["control"] },
      { smoke: { code: 1, stdout: "FAIL  x\n" } },
    ]) {
      const { rig } = await diagnose(o);
      expect(rig.stack.mutating).toEqual([]);
      expect(rig.stack.compose.some((c) => c.includes("force-recreate"))).toBe(false);
      expect(rig.host.writes).toEqual([]);
    }
  });

  it("--json prints one object with the checks (id, title, status, detail, fix)", async () => {
    const { rig, code, rows, get } = await diagnose({ stuck: ["gateway"] }, true);
    expect(rig.out.lines).toHaveLength(1);
    expect(code).toBe(1);
    expect(rows.length).toBeGreaterThan(15);
    for (const r of rows)
      expect(Object.keys(r).sort()).toEqual(expect.arrayContaining(["detail", "id", "status", "title"]));
    expect(get("service:gateway")).toMatchObject({
      status: "fail",
      detail: "running, unhealthy",
      fix: `see docker compose --env-file ${ROOT}/containers/.env --env-file ${ROOT}/containers/.secrets/secrets.env -f ${SHARED} -f ${SHARED_BUILD} logs gateway`,
    });
    expect(get("service:control")).toMatchObject({ status: "ok" });
  });

  it("a service that is down, unhealthy, still starting, exited non-zero or restarting", async () => {
    const rig = makeRig({ restartCounts: { exec: 3 } });
    rig.stack.rows.set("egress", { state: "exited", health: "", exitCode: 137 });
    rig.stack.rows.set("searxng", { state: "running", health: "starting", exitCode: 0 });
    rig.stack.rows.set("exec-keys", { state: "exited", health: "", exitCode: 1 });
    rig.stack.rows.delete("edge");
    expect(await doctor(rig.ctx, { json: false })).toBe(1);
    const text = rig.out.text;
    expect(text).toMatch(
      /FAIL {1}egress +exited 137\n\s+→ see docker compose --env-file .*\.env --env-file .*secrets\.env -f .*compose\.yaml -f .*compose\.build\.yaml logs egress/,
    );
    expect(text).toMatch(/warn {1}searxng +running, health check still starting/);
    expect(text).toMatch(/FAIL {1}exec-keys +exited 1/);
    expect(text).toMatch(/FAIL {1}edge +not created/);
    expect(text).toMatch(/warn {1}exec +running, healthy; restarting \(3 restarts\)/);
  });

  it("network names: a missing alias fails with the fix, and nothing is recreated", async () => {
    const { rig, code } = await diagnose({ missingAlias: ["gateway"] });
    expect(code).toBe(1);
    expect(rig.out.text).toMatch(/FAIL {1}service names +no network alias: gateway on rei_egress/);
    expect(rig.out.text).toContain("recreate the affected services");
    expect(rig.out.text).toContain("up -d --force-recreate --no-deps gateway");
  });

  it("the storage services: the control plane reaches both, and a service it cannot reach is a failure", async () => {
    const { get } = await diagnose({}, true);
    expect(get("storage:garage")).toMatchObject({ status: "ok", detail: expect.stringContaining("rei-garage:3900") });
    expect(get("storage:qdrant")).toMatchObject({ status: "ok", detail: expect.stringContaining("rei-qdrant:6333") });

    const down = await diagnose({ storageUnreachable: ["qdrant"] }, true);
    expect(down.code).toBe(1);
    expect(down.get("storage:qdrant")).toMatchObject({
      status: "fail",
      detail: "the control plane cannot reach rei-qdrant:6333 (the search index)",
    });
    expect(down.get("storage:qdrant")!.fix).toContain("Dodai");
    expect(down.get("storage:garage")).toMatchObject({ status: "ok" });
  });

  it("storage in Dodai: volumes, legacy containers and the callers' network pass on a migrated stack", async () => {
    const { get, code } = await diagnose({}, true);
    expect(code).toBe(0);
    expect(get("volumes")).toMatchObject({ status: "ok", detail: "6 external volumes exist" });
    expect(get("storage:legacy")).toMatchObject({ status: "ok" });
    expect(get("storage:network")).toMatchObject({ status: "ok" });
  });

  it("storage in Dodai: a missing volume, a volume Dodai owns, a leftover container and a missing network each fail with a fix", async () => {
    const { get, code, rig } = await diagnose(
      {
        missingVolumes: ["rei_garage-data"],
        dodaiOwnedVolumes: ["rei_qdrant-data"],
        legacyStorage: true,
        noSharedNetwork: true,
      },
      true,
    );
    expect(code).toBe(1);
    expect(get("volumes")).toMatchObject({ status: "fail", detail: "missing: rei_garage-data" });
    expect(get("volumes")!.fix).toContain("init.sh");
    expect(get("storage:legacy")).toMatchObject({ status: "fail" });
    expect(get("storage:network")).toMatchObject({ status: "fail" });
    expect(rig.stack.calls.filter((c) => c.startsWith("rm ") || c.startsWith("network rm"))).toEqual([]);

    const owned = await diagnose({ dodaiOwnedVolumes: ["rei_qdrant-data"] }, true);
    expect(owned.get("volumes")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("rei_qdrant-data belongs to the dodai project"),
    });
  });

  it("the sandbox smoke: its FAIL lines are shown", async () => {
    const { rig, code } = await diagnose({
      smoke: {
        code: 1,
        stdout: "PASS  a\nFAIL  /tmp is noexec\nFAIL  exec has no capabilities\n\n2 check(s) failed\n",
      },
    });
    expect(code).toBe(1);
    expect(rig.out.text).toMatch(/FAIL {1}sandbox +2 of 3 failed: \/tmp is noexec; exec has no capabilities/);
  });

  it("the browser smoke runs with the browser service, and a stack without it skips it", async () => {
    const withBrowser = await diagnose({
      smoke: { code: 1, stdout: "PASS  a\nFAIL  the browser cannot reach 1.1.1.1:443 directly\n" },
    });
    expect(withBrowser.rig.out.text).toMatch(
      /FAIL {1}browser +1 of 2 failed: the browser cannot reach 1\.1\.1\.1:443 directly/,
    );
    const old = await diagnose({ services: SERVICES.filter((s) => s !== "browser") });
    expect(old.rig.out.text).toMatch(/skip {1}browser /);
    expect(old.code).toBe(0);
  });

  it("network isolation: the control plane reaching the internet fails; the gateway offline only warns", async () => {
    const bad = await diagnose({ controlReachesInternet: true });
    expect(bad.code).toBe(1);
    expect(bad.rig.out.text).toMatch(/FAIL {1}network: control +reached the internet, which it must not/);
    const offline = await diagnose({ gatewayReachesInternet: false });
    expect(offline.code).toBe(0);
    expect(offline.rig.out.text).toMatch(/warn {1}network: gateway +cannot reach the internet \(offline\?\)/);
    expect(offline.rig.out.text).toMatch(/ok {3}network: control +no route to the internet, as designed/);
  });

  it("the app must answer on the published address (REI_PUBLISH is honoured)", async () => {
    const down = await diagnose({ appDown: true });
    expect(down.code).toBe(1);
    expect(down.rig.out.text).toMatch(/FAIL {1}app +http:\/\/localhost:8787 does not answer/);
    const moved = await diagnose({ env: { REI_PUBLISH: "0.0.0.0:9000" } });
    expect(moved.rig.fetched).toEqual(["http://127.0.0.1:9000/api/health"]);
    expect(moved.rig.out.text).toContain("http://localhost:9000 answers");
  });

  it("a missing secrets file fails with the fix; a missing .env only warns", async () => {
    const rig = makeRig();
    rig.host.files.delete(`${ROOT}/containers/.secrets/secrets.env`);
    rig.host.files.delete(`${ROOT}/containers/.env`);
    expect(await doctor(rig.ctx, { json: false })).toBe(1);
    expect(rig.out.text).toMatch(/FAIL {1}secret files +missing: secrets\.env\n\s+→ run containers\/init\.sh/);
    expect(rig.out.text).toMatch(/warn {1}containers\/\.env +missing/);
  });

  it("docker missing: one failing line and the stack is not checked", async () => {
    const { rig, code } = await diagnose({ dockerMissing: true });
    expect(code).toBe(1);
    expect(rig.out.text).toMatch(/FAIL {1}docker daemon +docker was not found/);
    expect(rig.out.text).toMatch(/skip {1}the stack/);
  });

  it("never prints a credential the fake docker puts in output it must not echo", async () => {
    const { rig } = await diagnose({});
    expect(rig.out.text).not.toContain(SECRET);
    const json = await diagnose({}, true);
    expect(json.rig.out.text).not.toContain(SECRET);
  });
});
