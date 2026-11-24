// End to end: the real control plane (src/main.ts as a child process, gateway mode) talks to the real gateway app,
// which swaps the stand-in for the real token and forwards to a fake OpenAI. Only the network edge is fake: the
// gateway's outbound fetch sends https://api.openai.com/v1/* to the fake upstream on loopback.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Handler, Recorded } from "../../apps/gateway/test/fake-upstream.ts";
import { type Rig, startRig } from "../../apps/gateway/test/rig.ts";
import { type Child, setUpAccount, startChild } from "../../apps/server/test/helpers/child.ts";
import { until } from "../../apps/server/test/helpers/client.ts";

const OPENAI = "https://api.openai.com/v1";

/** The text of the last user turn in a Responses request. */
const lastUserText = (rec: Recorded): string => {
  const items = (rec.json?.input ?? []) as { role?: string; content?: { text?: string }[] | string }[];
  const user = items.filter((i) => i.role === "user").at(-1);
  if (!user) return "";
  return typeof user.content === "string" ? user.content : (user.content ?? []).map((c) => c.text ?? "").join("");
};

const echo: Handler = (rec) => ({ kind: "text", text: `echo: ${lastUserText(rec)}` });

let rig: Rig | undefined;
let child: Child | undefined;
let dir: string | undefined;

afterEach(async () => {
  await child?.stop().catch(() => {});
  await rig?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  child = rig = dir = undefined;
});

async function start(handler: Handler = echo) {
  let fakeUrl = "";
  rig = await startRig({
    handler,
    fetch: (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      return fetch(url.startsWith(OPENAI) ? fakeUrl + url.slice(OPENAI.length) : url, init);
    },
  });
  fakeUrl = rig.fake.url;
  dir = mkdtempSync(join(tmpdir(), "gateway-e2e-"));
  writeFileSync(join(dir, "standin.txt"), rig.standin, { mode: 0o600 });
  // A real control plane with a fake model gateway and no Garage or Qdrant: the one process the folder file store is
  // allowed for, said out loud (config.ts refuses it otherwise, so an installed Rei cannot drift into it).
  child = await startChild(dir, {
    REI_MODEL_MODE: "gateway",
    GATEWAY_URL: rig.base,
    REI_ALLOW_FOLDER_FILES: "1",
  });
  await setUpAccount(child, dir);
  const session = (await child.client.post("/api/sessions", {})).body.session as { id: string };
  return { rig, child, dir, session };
}

async function sendAndSettle(c: Child, sessionId: string, text: string, requestId: string) {
  const sent = await c.client.post(`/api/sessions/${sessionId}/messages`, { requestId, text });
  expect(sent.status).toBe(200);
  return until(
    async () => {
      const d = (await c.client.get(`/api/sessions/${sessionId}`)).body;
      const run = d.runs.find((r: { id: string }) => r.id === sent.body.runId);
      return run && !["queued", "running"].includes(run.status) ? { d, run } : undefined;
    },
    30_000,
    "the run to finish",
  );
}

function walk(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const p = join(root, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("end to end: control plane → gateway → upstream", () => {
  it("answers a chat through the gateway with the real token, and records the call", async () => {
    const { rig, child, dir, session } = await start();
    const { d, run } = await sendAndSettle(child, session.id, "hello from e2e", "e2e-1");

    expect(run.status).toBe("completed");
    const reply = d.messages.find((m: { runId: string; role: string }) => m.runId === run.id && m.role === "assistant");
    expect(reply).toMatchObject({ status: "complete", text: "echo: hello from e2e" });

    // The upstream saw the real access token, never the stand-in or our own headers.
    const seenUpstream = () => rig.fake.requests.filter((r) => r.json?.model);
    await until(() => seenUpstream().length > 0, 20_000, "a call to reach the fake upstream");
    // The gateway keeps one record per call, linked to the control plane's step id, with usage. A turn is more than one
    // call (the chat's title follows the reply), and the record for the last one can land after the reply does, so this
    // waits for the two counts to agree instead of reading them side by side.
    const { upstream, records } = await until(
      () => {
        const ups = seenUpstream();
        const recs = rig.calls.recent(10);
        return ups.length > 0 && recs.length === ups.length ? { upstream: ups, records: recs } : undefined;
      },
      20_000,
      "a gateway record for every model call",
    );
    expect(records.length).toBe(upstream.length);
    for (const rec of upstream) {
      expect(rec.auth).toBe("ok");
      expect(String(rec.headers.authorization)).not.toContain(rig.standin);
      expect(Object.keys(rec.headers).filter((h) => h.startsWith("x-rei"))).toEqual([]);
    }
    for (const r of records) {
      expect(r.stepId).toBeTruthy();
      expect(r.status).toBe(200);
      expect(r.usage?.outputTokens).toBeGreaterThan(0);
    }

    // Stop the writer before enumerating files: atomic blob renames can otherwise remove a listed .tmp file.
    expect(await child.stop()).toBe(0);
    // The real tokens never reach the control plane: not its final data dir, not its complete logs.
    for (const secret of [rig.access, rig.refresh]) {
      for (const file of walk(dir))
        expect(readFileSync(file).includes(secret), `${file} holds a real token`).toBe(false);
      expect(child.logs.join("\n")).not.toContain(secret);
    }
  });

  it("turns a ChatGPT usage-limit 429 into a failed run with code usage_limit", async () => {
    const limitBody = JSON.stringify({
      error: { message: "You've reached your usage limit.", type: "usage_limit_reached", resets_in_seconds: 3600 },
    });
    const { rig, child, session } = await start(() => ({
      kind: "status",
      status: 429,
      body: limitBody,
      headers: { "retry-after": "3600" },
    }));
    const { d, run } = await sendAndSettle(child, session.id, "anything", "e2e-limit");

    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("usage_limit");
    const reply = d.messages.find((m: { runId: string; role: string }) => m.runId === run.id && m.role === "assistant");
    if (reply) expect(reply.status).toBe("error");
    const [record] = rig.calls.recent(1);
    expect(record).toMatchObject({ status: 429, error: { code: "usage_limit_reached" } });
    expect(record!.limit?.resetsInSeconds).toBe(3600);
  });

  it("explains a streamed provider content-screening failure in the chat", async () => {
    const event = {
      type: "response.failed",
      response: {
        status: "failed",
        error: {
          code: "server_error",
          message: "<400> InternalError.Algo.DataInspectionFailed: Input text data may contain inappropriate content.",
        },
      },
    };
    const { child, session } = await start(() => ({
      kind: "status",
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: `data: ${JSON.stringify(event)}\n\n`,
    }));
    const { d, run } = await sendAndSettle(child, session.id, "anything", "e2e-content-filter");

    const error = {
      code: "content_filtered",
      message: "The model provider blocked this request because its content filter flagged the input.",
    };
    expect(run).toMatchObject({ status: "failed", error });
    expect(d.messages).toContainEqual(expect.objectContaining({ role: "assistant", status: "error", error }));
    const trace = (await child.client.get(`/api/sessions/${session.id}/trace`)).body;
    const step = trace.runs.find((entry: { run: { id: string } }) => entry.run.id === run.id).steps[0];
    expect(step).toMatchObject({ type: "llm.call", status: "error", errorCode: error.code });
    const detail = await child.client.get(`/api/steps/${step.id}`);
    expect(detail.body.llm.error).toEqual(error);
  });

  it.each([
    [400, "context_length_exceeded", "context_too_large"],
    [401, "invalid_api_key", "provider_auth_error"],
    [402, "insufficient_quota", "provider_quota_exhausted"],
    [404, "model_not_found", "model_unavailable"],
    [413, undefined, "request_too_large"],
    [429, undefined, "rate_limited"],
    [429, "caller_concurrency", "caller_concurrency"],
    [502, undefined, "provider_unavailable"],
    [504, "upstream_timeout", "provider_timeout"],
  ])("classifies HTTP %s / %s as %s", async (status, upstreamCode, code) => {
    const privateText = "An upstream echoed private input here.";
    const { child, session } = await start(() => ({
      kind: "status",
      status,
      body: upstreamCode ? JSON.stringify({ error: { code: upstreamCode, message: privateText } }) : privateText,
    }));
    const { d, run } = await sendAndSettle(child, session.id, "anything", "e2e-http-error");
    expect(run).toMatchObject({ status: "failed", error: { code, message: expect.any(String) } });
    expect(d.messages).toContainEqual(
      expect.objectContaining({ role: "assistant", status: "error", error: run.error }),
    );
    expect(JSON.stringify(d)).not.toContain(privateText);
  });

  it("reports an interrupted stream when there is no terminal event", async () => {
    const { rig, child, session } = await start(() => ({
      kind: "status",
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: 'data: {"type":"response.created","response":{"error":null}}\n\n',
    }));
    const { run } = await sendAndSettle(child, session.id, "anything", "e2e-stream-interrupted");
    expect(run).toMatchObject({ status: "failed", error: { code: "provider_stream_interrupted" } });
    expect(rig.calls.recent(1)[0]).toMatchObject({ error: { code: "stream_truncated" } });
  });

  it("fails cleanly with gateway_auth when the stand-in is wrong", async () => {
    const { child, dir, session } = await start();
    writeFileSync(join(dir, "standin.txt"), "standin-wrong-0123456789abcdef"); // re-read on every call
    const { run } = await sendAndSettle(child, session.id, "anything", "e2e-auth");
    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("gateway_auth");
  });
});
