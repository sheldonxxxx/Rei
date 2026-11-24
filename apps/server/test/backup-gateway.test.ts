import { describe, expect, it } from "vitest";
import { gatewayBackupState } from "../src/backup/gateway.ts";

const state = { format: 1, version: "v", files: [] };

describe("gatewayBackupState", () => {
  it("asks the gateway's /backup with the stand-in token", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return Response.json(state);
    }) as unknown as typeof fetch;
    expect(await gatewayBackupState("http://gateway:8780/", async () => "tok", fetchImpl)).toEqual(state);
    expect(seen).toEqual([{ url: "http://gateway:8780/backup", auth: "Bearer tok" }]);
  });

  it("explains a refusal and an unreachable gateway without leaking the token", async () => {
    const refuse = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await expect(gatewayBackupState("http://g", () => "tok", refuse)).rejects.toThrow(/HTTP 403/);
    const down = (async () => {
      throw new TypeError("connect ECONNREFUSED tok");
    }) as unknown as typeof fetch;
    const error = await gatewayBackupState("http://g", () => "tok", down).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/could not be reached/);
    expect((error as Error).message).not.toContain("tok");
  });
});
