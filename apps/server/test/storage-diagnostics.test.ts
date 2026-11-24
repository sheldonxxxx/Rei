// What an operator is told about the two services. The point of the endpoint is that Rei can say what SQLite and the
// services disagree about — so the useful test is that it says it, and says nothing else.

import type { StorageStatusResponse } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryFileObjectStore } from "../src/storage/file-object-store.ts";
import { FakeRetrieval } from "./helpers/retrieval.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, say, settled } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const statusOf = async (s: TestServer): Promise<StorageStatusResponse> => {
  const response = await s.client.get("/api/diagnostics/storage");
  expect(response.status).toBe(200);
  return response.body as StorageStatusResponse;
};

const upload = async (s: TestServer, name = "quarterly-report.txt"): Promise<void> => {
  const form = new FormData();
  form.append("file", new File(["the numbers for the quarterly report"], name, { type: "text/plain" }));
  const response = await s.client.fetcher("/api/files", {
    method: "POST",
    body: form,
    headers: { cookie: `rei_session=${s.client.cookie}`, "x-rei": "1" },
  });
  expect(response.status).toBe(200);
};

describe("the storage diagnostics", () => {
  it("asks for a login", async () => {
    const s = await startSignedIn();

    server = s;
    expect((await s.client.get("/api/diagnostics/storage", { cookie: false })).status).toBe(401);
  });

  it("says what the object ledger holds, and what the search service holds", async () => {
    const fake = new FakeRetrieval();
    const s = await startSignedIn({ retrieval: fake });

    server = s;
    await upload(s);
    const id = await chat(s);
    await say(s, id, "the quarterly report needs a footnote");
    await settled(s, id);
    await s.host.plane.memory.history.settle();

    const status = await statusOf(s);
    expect(status.files).toMatchObject({
      bucket: "local",
      pending: 0,
      ready: 1,
      deletePending: 0,
      failed: 0,
      lastError: null,
    });
    expect(status.files.readyBytes).toBeGreaterThan(0);
    expect(status.search).toMatchObject({
      configured: true,
      ok: true,
      detail: null,
      lexicalCollection: "rei_history_lexical_v1",
      dense: [],
      queued: 0,
      queueError: null,
    });
    // The file is a file; only what was said in the chat is searchable.
    expect(status.search.lexicalPoints).toBeGreaterThan(0);
    expect((status.search.lexicalPoints ?? 0) < 10).toBe(true);
  });

  it("admits when the ledger owes the object store a delete", async () => {
    // An object store that can be made to refuse a delete, so the ledger has something honest to report.
    const objects = new MemoryFileObjectStore();
    const s = await startSignedIn({ fileObjects: objects });

    server = s;
    await upload(s);
    const file = (await s.client.get("/api/files")).body.files[0];
    const key = s.host.plane.storage.registry.row(
      s.host.plane.adapter.attachments!.row(file.current.attachmentId)!.object_id,
    )!.object_key;
    objects.failDelete.set(key, new Error("the object service refused"));
    await s.client.call("PATCH", `/api/files/${file.id}`, { body: { trashed: true } });
    await s.client.raw("DELETE", `/api/files/${file.id}`, { body: { confirm: true } });

    const status = await statusOf(s);
    expect(status.files).toMatchObject({ bucket: "memory", ready: 0, deletePending: 1, failed: 0 });
    expect(status.files.lastError).toContain("refused");
  });

  it("admits when the search service is behind or unreachable", async () => {
    const fake = new FakeRetrieval();
    const s = await startSignedIn({ retrieval: fake });

    server = s;
    fake.failUpsert = 10;
    const id = await chat(s);
    await say(s, id, "an entry the search service has not been told about");
    await settled(s, id);
    await s.host.plane.memory.history.settle();
    let status = await statusOf(s);
    expect(status.search.queued).toBeGreaterThan(0);
    expect(status.search.queueError).toBeTruthy();
    expect(status.search.lexicalPoints).toBe(0);

    fake.down = true;
    status = await statusOf(s);
    expect(status.search.ok).toBe(false);
    expect(status.search.detail).toBeTruthy();
  });

  it("names no object key, no filename and no credential", async () => {
    const fake = new FakeRetrieval();
    const s = await startSignedIn({ retrieval: fake });

    server = s;
    await upload(s);
    const id = await chat(s);
    await say(s, id, "the quarterly report needs a footnote");
    await settled(s, id);
    await s.host.plane.memory.history.settle();
    const body = JSON.stringify(await statusOf(s));
    expect(body).not.toContain("quarterly-report.txt");
    expect(body).not.toMatch(/files\/v1\//);
    expect(body).not.toMatch(/"object_key"/);
    expect(body).not.toContain("api-key");
  });
});
