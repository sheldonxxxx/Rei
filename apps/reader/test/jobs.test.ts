import { describe, expect, it } from "vitest";
import { createJobTokens, isPublicName } from "../src/node/jobs.ts";

const ask = (jobs: ReturnType<typeof createJobTokens>, token: string, host: string, port = 443) =>
  jobs.decide({ source: "render", token, host, port }, new AbortController().signal);

describe("fetch jobs", () => {
  const open = (localNetworks: "all" | "none" | string[] = "none") => {
    let t = 1_000;
    const jobs = createJobTokens({ now: () => t });
    const job = jobs.open({ kind: "fetch", allowHosts: new Set(["a.test"]), localNetworks, deadlineMs: 5_000 });
    return {
      jobs,
      job,
      advance: (ms: number) => {
        t += ms;
      },
    };
  };
  it("allows only the named hosts on ports 80 and 443", async () => {
    const { jobs, job } = open();
    expect(await ask(jobs, job.token, "A.test.")).toMatchObject({ decision: "allow", localNetworks: "none" });
    expect(await ask(jobs, job.token, "b.test")).toMatchObject({ decision: "deny" });
    expect(await ask(jobs, job.token, "a.test", 8080)).toMatchObject({ decision: "deny" });
    expect(job.revoke()).toEqual({ connections: 1, refused: 2 });
  });
  it("passes the caller's local scope to the proxy and refuses literal local addresses without it", async () => {
    const withScope = open(["10.1.2.3"]);
    withScope.jobs.open({
      kind: "fetch",
      allowHosts: new Set(["10.1.2.3"]),
      localNetworks: ["10.1.2.3"],
      deadlineMs: 5_000,
    });
    const t = withScope.jobs.open({
      kind: "fetch",
      allowHosts: new Set(["10.1.2.3", "169.254.169.254"]),
      localNetworks: ["10.1.2.3"],
      deadlineMs: 5_000,
    });
    expect(await ask(withScope.jobs, t.token, "10.1.2.3")).toMatchObject({
      decision: "allow",
      localNetworks: ["10.1.2.3"],
    });
    expect(await ask(withScope.jobs, t.token, "169.254.169.254")).toMatchObject({ decision: "deny" });
    const none = createJobTokens();
    const j = none.open({ kind: "fetch", allowHosts: new Set(["10.1.2.3"]), localNetworks: "none", deadlineMs: 5_000 });
    expect(await ask(none, j.token, "10.1.2.3")).toMatchObject({ decision: "deny" });
  });
  it("refuses a revoked, expired, unknown or missing token", async () => {
    const { jobs, job, advance } = open();
    expect(await ask(jobs, "j.unknown", "a.test")).toMatchObject({ decision: "deny" });
    expect(
      await jobs.decide({ source: "browser", host: "a.test", port: 443 }, new AbortController().signal),
    ).toMatchObject({ decision: "deny" });
    advance(6_000);
    expect(await ask(jobs, job.token, "a.test")).toMatchObject({ decision: "deny" });
    const second = open();
    second.job.revoke();
    expect(await ask(second.jobs, second.job.token, "a.test")).toMatchObject({ decision: "deny" });
  });
  it("caps connections", async () => {
    const jobs = createJobTokens({ limits: { maxConnections: 2, maxBytes: 1000 } });
    const job = jobs.open({ kind: "fetch", allowHosts: new Set(["a.test"]), localNetworks: "none", deadlineMs: 5_000 });
    expect(await ask(jobs, job.token, "a.test")).toMatchObject({ decision: "allow", budget: { bytes: 1000 } });
    await ask(jobs, job.token, "a.test");
    expect(await ask(jobs, job.token, "a.test")).toMatchObject({ decision: "deny" });
  });
});

describe("render jobs", () => {
  it("allow any public name and never local ones", async () => {
    const jobs = createJobTokens();
    const job = jobs.open({ kind: "render", deadlineMs: 5_000 });
    expect(await ask(jobs, job.token, "cdn.example.com")).toMatchObject({ decision: "allow", localNetworks: "none" });
    expect(await ask(jobs, job.token, "nas.lan")).toMatchObject({ decision: "deny" });
    expect(await ask(jobs, job.token, "printer")).toMatchObject({ decision: "deny" });
    expect(await ask(jobs, job.token, "192.168.1.5")).toMatchObject({ decision: "deny" });
    expect(await ask(jobs, job.token, "93.184.216.34")).toMatchObject({ decision: "allow" });
  });
  it("isPublicName", () => {
    expect(isPublicName("example.com")).toBe(true);
    expect(isPublicName("a.home.arpa")).toBe(false);
    expect(isPublicName("localhost")).toBe(false);
    expect(isPublicName("foo.local.")).toBe(false);
  });
});
