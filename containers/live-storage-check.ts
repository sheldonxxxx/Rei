// Rei's own Garage and Qdrant clients, against the live services, from inside the private storage network.
//
// This is not a unit test: it is the proof that the code Rei actually ships speaks the protocol these services accept.
// `containers/smoke-storage.sh` runs it in a throwaway container on the storage network with the repo mounted read-only.
// It writes its own objects and its own collections, deletes what it made, and prints no secrets.
import { randomBytes } from "node:crypto";
import { ftsText } from "../apps/server/src/memory/keyword.ts";
import { GarageFileObjectStore } from "../apps/server/src/node/garage-object-store.ts";
import { QdrantStore } from "../apps/server/src/node/qdrant-store.ts";
import type { RetrievalPoint } from "../apps/server/src/retrieval/retrieval-store.ts";
import { objectKey, StorageError, sha256Hex } from "../apps/server/src/storage/file-object-store.ts";

/** Passages whose keyword behaviour Rei already had: Chinese, a Latin sentence, and something that must not match. */
const PASSAGES = [
  { text: "予約の確認ありがとうございます。明日の予約を確定しました。", agentId: "agent_a", createdAt: 1_000 },
  {
    text: "The tenant complained about the deposit and asked for a refund twice.",
    agentId: "agent_b",
    createdAt: 2_000,
  },
  { text: "totally unrelated note about a bicycle and a bell", agentId: "agent_b", createdAt: 3_000 },
];

/** A point of the shape Rei indexes, so the service is asked to do the thing it will really be asked to do. */
const point = (
  passage: (typeof PASSAGES)[number],
  entryId: number,
  pointId: string,
  sessionId: string,
): RetrievalPoint => ({
  pointId,
  payload: {
    entryId,
    sourceType: "message",
    sourceId: `msg_${pointId}`,
    chunkId: pointId,
    sessionId,
    agentId: passage.agentId,
    kind: "user",
    toolName: null,
    createdAt: passage.createdAt,
    text: passage.text,
    // The same tokens Rei's own index was built from: this is the half that has to behave as before.
    tokens: ftsText(passage.text),
    writtenBy: "live-storage-check",
  },
});

let failures = 0;
const ok = (name: string): void => {
  console.log(`PASS  ${name}`);
};
const bad = (name: string, detail: string): void => {
  console.log(`FAIL  ${name}\n      ${detail.split("\n").slice(0, 3).join("\n      ")}`);
  failures++;
};
const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
    ok(name);
  } catch (error) {
    bad(name, error instanceof Error ? error.message : String(error));
  }
};
const must = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};
const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};

const run = async (): Promise<void> => {
  const qdrantUrl = env("REI_QDRANT_URL");
  const suffix = randomBytes(4).toString("hex");
  const garage = new GarageFileObjectStore({
    endpoint: env("REI_GARAGE_ENDPOINT"),
    region: process.env.REI_GARAGE_REGION ?? "garage",
    bucket: env("REI_GARAGE_BUCKET"),
    accessKeyId: env("GARAGE_DEFAULT_ACCESS_KEY"),
    secretAccessKey: env("GARAGE_DEFAULT_SECRET_KEY"),
    retries: 1,
  });
  // Collections of its own: the check never reads or writes what Rei's index holds.
  const qdrant = new QdrantStore({
    url: qdrantUrl,
    apiKey: env("QDRANT__SERVICE__API_KEY"),
    lexicalCollection: `rei_history_smoke_lexical_${suffix}`,
  });
  const denseCollection = `rei_history_smoke_dense_${suffix}`;
  const sessionId = `ses_smoke_${suffix}`;
  const smokePoint = (index: number, entryId = index + 1): RetrievalPoint =>
    point(PASSAGES[index]!, entryId, `smoke_${suffix}_${index}`, sessionId);

  // ---- the object store -------------------------------------------------------------------------------------------------
  const content = randomBytes(4096);
  const sha256 = await sha256Hex(content);
  const id = `obj_smoke_${suffix}`;
  const key = objectKey(id, sha256);

  await check("garage: stores an object and reads back exactly the bytes it was given", async () => {
    await garage.put({ key, bytes: content, sha256 });
    const back = await garage.get(key);
    must(back !== undefined, "the object was not there after the upload");
    must(Buffer.from(back!).equals(Buffer.from(content)), `got ${back!.byteLength} of ${content.byteLength} bytes`);
  });

  await check("garage: reports the object's size from the service, not from what it sent", async () => {
    const head = await garage.head(key);
    must(head?.byteLength === content.byteLength, `head says ${head?.byteLength}, not ${content.byteLength}`);
  });

  await check("garage: serves a byte range, as a file preview needs", async () => {
    const slice = await garage.get(key, { start: 100, end: 199 });
    must(slice !== undefined && Buffer.from(slice).equals(Buffer.from(content.subarray(100, 200))), "wrong slice");
    const tail = await garage.get(key, { start: content.byteLength - 16 });
    must(tail?.byteLength === 16, `tail is ${tail?.byteLength} bytes`);
  });

  await check("garage: refuses bytes that do not hash to the key they would be stored under", async () => {
    const other = randomBytes(64);
    const lie = objectKey(`obj_smoke_lie_${suffix}`, await sha256Hex(other));
    let kind = "it accepted them";
    try {
      await garage.put({ key: lie, bytes: other, sha256 });
    } catch (error) {
      kind = error instanceof StorageError ? error.kind : `not a StorageError (${String(error)})`;
    }
    must(kind === "integrity", `expected an integrity refusal, got ${kind}`);
    must((await garage.head(lie)) === undefined, "the refused object was stored anyway");
  });

  await check(
    "garage: answers for a key that is not there, and deletes an absent object without an error",
    async () => {
      const missing = objectKey(`obj_smoke_none_${suffix}`, "f".repeat(64));
      must((await garage.get(missing)) === undefined, "a read of nothing should be undefined");
      must((await garage.head(missing)) === undefined, "a head of nothing should be undefined");
      await garage.delete(missing);
    },
  );

  await check("garage: lists what it holds under a prefix, for reconciliation", async () => {
    const keys = await garage.list(`files/v1/${id}/`);
    must(keys.length === 1 && keys[0] === key, `expected one key, got ${JSON.stringify(keys)}`);
  });

  await check("garage: the object is gone when Rei says it is gone, and saying so twice is fine", async () => {
    await garage.delete(key);
    await garage.delete(key);
    must((await garage.head(key)) === undefined, "the object survived its delete");
  });

  // ---- the search service -----------------------------------------------------------------------------------------------
  await check("qdrant: refuses a request with no API key", async () => {
    const response = await fetch(`${qdrantUrl}/collections`, { signal: AbortSignal.timeout(5_000) });
    must(response.status === 401, `unauthenticated list answered ${response.status}, expected 401`);
  });

  await check("qdrant: creates the lexical collection and its BM25 index on Rei's tokens", async () => {
    await qdrant.ensureLexical();
    const status = await qdrant.status();
    must(status.ok, `status says ${status.detail}`);
    must(status.lexicalCollection === qdrant.lexicalCollection, "status names a different collection");
  });

  await check("qdrant: indexes passages written with Rei's tokenising", async () => {
    await qdrant.upsert(
      qdrant.lexicalCollection,
      PASSAGES.map((_, index) => smokePoint(index)),
    );
    must((await qdrant.count(qdrant.lexicalCollection)) === PASSAGES.length, "not every point landed");
  });

  await check("qdrant: finds a Chinese query the way Rei's own index did", async () => {
    const hits = await qdrant.searchLexical("予約の確認", { filters: {}, limit: 5 });
    must(hits.length > 0, "a Chinese query found nothing");
    must(hits[0]!.payload.text.includes("予約"), `best hit was "${hits[0]!.payload.text}"`);
    must(!hits.some((h) => h.payload.text.includes("bicycle")), "an unrelated passage was returned");
  });

  await check("qdrant: applies the caller's filters before it ranks", async () => {
    const byAgent = await qdrant.searchLexical("予約 OR deposit", { filters: { agentId: "agent_b" }, limit: 5 });
    must(byAgent.length > 0, "the filtered query found nothing it should have");
    must(
      byAgent.every((h) => h.payload.agentId === "agent_b"),
      "a passage from another agent was returned",
    );
    const byDate = await qdrant.searchLexical("予約 OR deposit", { filters: { to: 1_500 }, limit: 5 });
    must(
      byDate.every((h) => h.payload.createdAt <= 1_500),
      "the date filter did not apply",
    );
  });

  await check("qdrant: stores and ranks dense vectors in the generation it is named", async () => {
    await qdrant.ensureDense(denseCollection, 4);
    const vectors = [
      new Float32Array([1, 0, 0, 0]),
      new Float32Array([0.9, 0.1, 0, 0]),
      new Float32Array([0, 1, 0, 0]),
    ];
    await qdrant.upsert(
      denseCollection,
      PASSAGES.map((_, index) => ({ ...smokePoint(index, 101 + index), vector: vectors[index] })),
    );
    const hits = await qdrant.searchDense(denseCollection, new Float32Array([1, 0.05, 0, 0]), {
      filters: {},
      limit: 3,
    });
    must(hits.length === 3, `expected 3 hits, got ${hits.length}`);
    must(hits[0]!.payload.entryId === 101, `nearest was entry ${hits[0]!.payload.entryId}`);
    must(hits[0]!.score > hits[1]!.score && hits[1]!.score > hits[2]!.score, "the ranking is not nearest-first");
  });

  await check("qdrant: removes points by id, and everything a source produced", async () => {
    await qdrant.remove([qdrant.lexicalCollection, denseCollection], [`smoke_${suffix}_0`]);
    const left = await qdrant.searchLexical("予約", { filters: {}, limit: 5 });
    must(!left.some((h) => h.pointId === `smoke_${suffix}_0`), "the removed point was still searchable");
    await qdrant.removeWhere([qdrant.lexicalCollection], { sessionIds: [sessionId] });
    must((await qdrant.count(qdrant.lexicalCollection)) === 0, "removing by source left points behind");
  });

  await check("qdrant: reports what it holds, and only names collections Rei owns", async () => {
    const status = await qdrant.status();
    must(status.ok, `status says ${status.detail}`);
    must(status.lexicalPoints === 0, `the count did not follow the removal: ${status.lexicalPoints}`);
    // Two, not three: the check's own point-id removal above took one out of the dense collection as well.
    must(
      status.dense.some((d) => d.collection === denseCollection && d.points === 2),
      `dense collections: ${JSON.stringify(status.dense)}`,
    );
    must(
      (await qdrant.collections()).every((name) => name.startsWith("rei_history_")),
      "the listing included a collection Rei does not own",
    );
  });

  await qdrant.dropCollection(qdrant.lexicalCollection);
  await qdrant.dropCollection(denseCollection);
  // What has to be gone is what this check made. The running control plane owns its own collections on the same
  // service, and those are not ours to remove.
  const left = (await qdrant.collections()).filter((name) => name.includes("smoke_"));
  must(left.length === 0, `the check left a collection behind: ${left.join(", ")}`);
  ok(
    `the check left nothing behind${(await qdrant.collections()).length ? " (the app's own collections remain)" : ""}`,
  );
};

await run().catch((error: unknown) => {
  bad("the check could not run", error instanceof Error ? error.message : String(error));
});
process.exit(failures === 0 ? 0 : 1);
