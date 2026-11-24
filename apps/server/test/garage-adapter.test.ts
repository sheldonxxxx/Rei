// The Garage adapter: how it signs, how it retries, and how each service answer turns into something a caller can act
// on. These run against a fake S3 (an injected fetch, or a real local HTTP server for the streamed put, which goes over
// node:http); `containers/smoke-storage.sh` runs the same adapter against the real Garage container, which is what
// proves the canonical request is the one S3 actually expects.
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { BUCKET_PATTERN, GarageFileObjectStore } from "../src/node/garage-object-store.ts";
import { collect, objectKey, StorageError, sha256Hex } from "../src/storage/file-object-store.ts";

const bytes = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;

interface Answer {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** A local HTTP server, closed after each test. */
async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** An S3 stand-in: answers whatever the test says, in order (the last answer repeats), and records what it was asked. */
class FakeS3 {
  readonly requests: Recorded[] = [];
  answers: Answer[] = [];
  #endpoint: string | undefined;

  #answer(recorded: Recorded): Answer {
    this.requests.push(recorded);
    return this.answers[Math.min(this.answers.length - 1, this.requests.length - 1)] ?? { status: 200 };
  }

  /** Serves the same answers over a real local server: a streamed put goes over node:http, not the injected fetch. */
  async listen(): Promise<this> {
    this.#endpoint = await serve((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers))
          if (typeof value === "string") headers[name] = value;
        const answer = this.#answer({
          method: request.method ?? "GET",
          url: `http://${request.headers.host}${request.url}`,
          headers,
          ...(chunks.length > 0 ? { body: new Uint8Array(Buffer.concat(chunks)) } : {}),
        });
        response.writeHead(answer.status, { "content-type": "application/xml", ...(answer.headers ?? {}) });
        response.end(request.method === "HEAD" ? undefined : (answer.body ?? ""));
      });
    });
    return this;
  }

  fetch: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      headers[name.toLowerCase()] = value;
    const requestBody =
      init?.body instanceof Uint8Array
        ? (init.body as Uint8Array)
        : init?.body instanceof ReadableStream
          ? new Uint8Array(await new Response(init.body).arrayBuffer())
          : undefined;
    const answer = this.#answer({
      method: String(init?.method ?? "GET"),
      url: String(url),
      headers,
      ...(requestBody ? { body: requestBody } : {}),
    });
    return new Response(answer.status === 200 || answer.status === 206 ? answer.body : (answer.body ?? ""), {
      status: answer.status,
      headers: { "content-type": "application/xml", ...(answer.headers ?? {}) },
    });
  }) as unknown as typeof fetch;

  configured(overrides: { retries?: number; secretAccessKey?: string } = {}): GarageFileObjectStore {
    return new GarageFileObjectStore({
      endpoint: this.#endpoint ?? "http://garage:3900",
      region: "garage",
      bucket: "rei-files",
      accessKeyId: "GKtestkey",
      secretAccessKey: overrides.secretAccessKey ?? "testsecret",
      retries: overrides.retries ?? 2,
      // Served, every request goes to the local server; otherwise the injected fetch answers.
      ...(this.#endpoint ? {} : { fetchImpl: this.fetch }),
      sleep: async () => {},
    });
  }
}

/** A stream of `content`, cut into `size`-byte chunks. */
const chunked =
  (content: Uint8Array, size = 100) =>
  () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < content.byteLength; at += size) controller.enqueue(content.slice(at, at + size));
        controller.close();
      },
    });

/** A key whose hash actually matches these bytes, because the adapter checks that they do. */
const keyFor = async (content: Uint8Array<ArrayBuffer>, id = "obj_test"): Promise<string> =>
  objectKey(id, await sha256Hex(content));

const s3Error = (code: string, message = "nope") =>
  `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;

describe("the Garage adapter's requests", () => {
  it("addresses objects path-style, under the bucket", async () => {
    const s3 = new FakeS3();
    const content = bytes("abc");
    s3.answers = [{ status: 200 }, { status: 200, headers: { "content-length": "3" } }];
    await s3.configured().put({ key: await keyFor(content), bytes: content, sha256: await sha256Hex(content) });
    expect(s3.requests.map((r) => r.method)).toEqual(["PUT", "HEAD"]);
    expect(s3.requests[0]!.url).toBe(`http://garage:3900/rei-files/${await keyFor(content)}`);
  });

  it("streams a large put with its length and known hash, and reads an object back as a verified stream", async () => {
    const s3 = await new FakeS3().listen();
    const content = bytes("streamed body ".repeat(1000));
    const sha256 = await sha256Hex(content);
    const key = await keyFor(content);
    s3.answers = [{ status: 500, body: s3Error("InternalError") }, { status: 200 }];
    s3.answers.push({ status: 200, headers: { "content-length": String(content.byteLength) } });
    let opened = 0;
    const stream = () => {
      opened++;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(content.subarray(0, 100));
          controller.enqueue(content.subarray(100));
          controller.close();
        },
      });
    };
    await s3.configured().put({ key, sha256, byteLength: content.byteLength, stream });
    // A retried put opens the source again rather than replaying bytes it kept.
    expect(opened).toBe(2);
    const put = s3.requests[1]!;
    expect([put.method, put.headers["content-length"], put.headers["x-amz-content-sha256"]]).toEqual([
      "PUT",
      String(content.byteLength),
      sha256,
    ]);
    expect(put.body).toEqual(content);
    expect(put.url).toBe(`${new URL(put.url).origin}/rei-files/${key}`);

    const reader = new FakeS3();
    reader.answers = [
      {
        status: 200,
        body: new TextDecoder().decode(content),
        headers: { "content-length": String(content.byteLength) },
      },
    ];
    const object = (await reader.configured().open(key))!;
    expect(object.byteLength).toBe(content.byteLength);
    expect(await collect(object.body)).toEqual(content);

    const liar = new FakeS3();
    liar.answers = [{ status: 200, body: "someone else's bytes", headers: { "content-length": "20" } }];
    const lie = (await liar.configured().open(key))!;
    const error = (await collect(lie.body).catch((e) => e)) as StorageError;
    expect(error.kind).toBe("integrity");

    const missing = new FakeS3();
    missing.answers = [{ status: 404, body: s3Error("NoSuchKey") }];
    expect(await missing.configured().open(key)).toBeUndefined();
  });

  it("does not call a streamed put done when the stream sent other bytes than it promised", async () => {
    const s3 = await new FakeS3().listen();
    const content = bytes("promised");
    const sha256 = await sha256Hex(content);
    s3.answers = [{ status: 200 }, { status: 200, headers: { "content-length": "8" } }];
    const other = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes("imposter"));
          controller.close();
        },
      });
    const error = (await s3
      .configured()
      .put({ key: await keyFor(content), sha256, byteLength: 8, stream: other })
      .catch((e) => e)) as StorageError;
    expect(error.kind).toBe("integrity");
  });

  it("signs with SigV4 over every header it sent, with the payload's own hash", async () => {
    const s3 = new FakeS3();
    const content = bytes("signed body");
    const key = await keyFor(content);
    s3.answers = [{ status: 200 }, { status: 200, headers: { "content-length": String(content.byteLength) } }];
    await s3.configured().put({ key, bytes: content, sha256: await sha256Hex(content) });
    const put = s3.requests[0]!;
    expect(put.headers.host).toBe("garage:3900");
    // Garage answers 400 InvalidRequest for a date that is not exactly YYYYMMDDTHHMMSSZ.
    expect(put.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(put.headers["x-amz-content-sha256"]).toBe(await sha256Hex(content));
    const authorization = put.headers.authorization!;
    expect(authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=GKtestkey\/\d{8}\/garage\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    );
    const signed = /SignedHeaders=([^,]+)/.exec(authorization)![1]!.split(";");
    expect(signed).toEqual(expect.arrayContaining(["host", "x-amz-content-sha256", "x-amz-date"]));
    expect(signed).toEqual(signed.slice().sort());
    // A different payload, key, or secret must produce a different signature.
    const other = new FakeS3();
    const otherContent = bytes("different body");
    other.answers = [{ status: 200 }, { status: 200, headers: { "content-length": String(otherContent.byteLength) } }];
    await other
      .configured()
      .put({ key: await keyFor(otherContent), bytes: otherContent, sha256: await sha256Hex(otherContent) });
    expect(other.requests[0]!.headers.authorization).not.toBe(authorization);
    const wrongSecret = new FakeS3();
    wrongSecret.answers = [{ status: 200 }, { status: 200, headers: { "content-length": String(content.byteLength) } }];
    await wrongSecret
      .configured({ secretAccessKey: "other-secret" })
      .put({ key, bytes: content, sha256: await sha256Hex(content) });
    expect(wrongSecret.requests[0]!.headers.authorization).not.toBe(authorization);
  });

  it("derives the signing key the way SigV4 says, checked against node:crypto", async () => {
    const s3 = new FakeS3();
    s3.answers = [{ status: 403, body: s3Error("AccessDenied") }];
    await expect(s3.configured().get(await keyFor(bytes("x")))).rejects.toThrow(/403/);
    // Recompute the signature the adapter should have produced, with node:crypto instead of WebCrypto: agreement means
    // both the string to sign and the key derivation (AWS4+secret, date, region, service, aws4_request) are right.
    const request = s3.requests[0]!;
    const amzDate = request.headers["x-amz-date"]!;
    const dateStamp = amzDate.slice(0, 8);
    const signedHeaders = request.headers.authorization!.match(/SignedHeaders=([^,]+)/)![1]!;
    const url = new URL(request.url);
    const canonicalRequest = [
      request.method,
      url.pathname,
      "",
      signedHeaders
        .split(";")
        .map((name) => `${name}:${request.headers[name]!.trim()}\n`)
        .join(""),
      signedHeaders,
      request.headers["x-amz-content-sha256"]!,
    ].join("\n");
    const { createHash } = await import("node:crypto");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      `${dateStamp}/garage/s3/aws4_request`,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    let signingKey: Buffer = Buffer.from("AWS4testsecret");
    for (const part of [dateStamp, "garage", "s3", "aws4_request"])
      signingKey = createHmac("sha256", signingKey).update(part).digest();
    expect(request.headers.authorization).toContain(
      `Signature=${createHmac("sha256", signingKey).update(stringToSign).digest("hex")}`,
    );
  });

  it("asks for a byte range and insists on being served one", async () => {
    const s3 = new FakeS3();
    const key = await keyFor(bytes("0123456789"));
    s3.answers = [{ status: 206, body: "345" }];
    expect(new TextDecoder().decode((await s3.configured().get(key, { start: 3, end: 5 }))!)).toBe("345");
    expect(s3.requests[0]!.headers.range).toBe("bytes=3-5");
    s3.answers = [{ status: 206, body: "3456789" }];
    expect(new TextDecoder().decode((await s3.configured().get(key, { start: 3 }))!)).toBe("3456789");
    expect(s3.requests[1]!.headers.range).toBe("bytes=3-");
    // Answering a range request with the whole object (200) would silently hand back the wrong bytes.
    s3.answers = [{ status: 200, body: "0123456789" }];
    await expect(s3.configured().get(key, { start: 3 })).rejects.toThrow(/range/);
  });

  it("lists under a prefix and follows the continuation token", async () => {
    const s3 = new FakeS3();
    const page = (keys: string[], truncated: boolean, token?: string): Answer => ({
      status: 200,
      body: `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}<IsTruncated>${truncated}</IsTruncated>${token ? `<NextContinuationToken>${token}</NextContinuationToken>` : ""}</ListBucketResult>`,
    });
    s3.answers = [page(["a"], true, "TOK"), page(["b"], false)];
    expect(await s3.configured().list("files/v1/")).toEqual(["a", "b"]);
    expect(s3.requests[0]!.url).toContain("list-type=2");
    expect(s3.requests[0]!.url).toContain("prefix=files%2Fv1%2F");
    expect(s3.requests[1]!.url).toContain("continuation-token=TOK");
  });
});

describe("the Garage adapter's answers", () => {
  it("treats a missing object as nothing there, and an already-gone delete as fine", async () => {
    const s3 = new FakeS3();
    const key = await keyFor(bytes("x"));
    s3.answers = [{ status: 404, body: s3Error("NoSuchKey") }];
    const store = s3.configured();
    expect(await store.get(key)).toBeUndefined();
    expect(await store.head(key)).toBeUndefined();
    await expect(store.delete(key)).resolves.toBeUndefined();
    expect(s3.requests.map((r) => r.method)).toEqual(["GET", "HEAD", "DELETE"]);
  });

  it("says a failed upload is a service problem, and does not pretend to have written", async () => {
    const s3 = new FakeS3();
    const content = bytes("bytes");
    const key = await keyFor(content);
    s3.answers = [{ status: 500, body: s3Error("InternalError") }];
    const error = (await s3
      .configured()
      .put({ key, bytes: content, sha256: await sha256Hex(content) })
      .catch((e) => e)) as StorageError;
    expect(error).toBeInstanceOf(StorageError);
    expect(error.kind).toBe("unavailable");
    expect(error.retryable).toBe(true);
    expect(error.code).toBe("InternalError");
    expect(error.message).toContain("InternalError");
    expect(s3.requests.length).toBeGreaterThan(1);
    expect(s3.requests.some((r) => r.method === "HEAD")).toBe(false);
  });

  it("does not call an upload complete when the object is absent or the wrong size afterwards", async () => {
    const content = bytes("bytes");
    const sha = await sha256Hex(content);
    const key = objectKey("obj_absent", sha);
    const s3 = new FakeS3();
    s3.answers = [{ status: 200 }, { status: 404, body: s3Error("NoSuchKey") }];
    await expect(s3.configured().put({ key, bytes: content, sha256: sha })).rejects.toThrow(/absent after/);

    const shortStore = new FakeS3();
    shortStore.answers = [{ status: 200 }, { status: 200, headers: { "content-length": "999" } }];
    const error = (await shortStore
      .configured()
      .put({ key, bytes: content, sha256: sha })
      .catch((e) => e)) as StorageError;
    expect(error.kind).toBe("integrity");
  });

  it("fails a read whose bytes do not hash to the key, rather than serving them", async () => {
    const s3 = new FakeS3();
    s3.answers = [{ status: 200, body: "someone else's bytes entirely" }];
    const error = (await s3
      .configured()
      .get(await keyFor(bytes("mine")))
      .catch((e) => e)) as StorageError;
    expect(error).toBeInstanceOf(StorageError);
    expect(error.kind).toBe("integrity");
  });

  it("retries a busy service, and stops retrying a refusal", async () => {
    const key = await keyFor(bytes("0123456789012345678901234567890123456789012345678901234567890123x"));
    const busy = new FakeS3();
    busy.answers = [
      { status: 503, body: s3Error("SlowDown") },
      { status: 200, body: "0123456789012345678901234567890123456789012345678901234567890123" },
    ];
    // The body is not the key's bytes, so the read ends on integrity: what is being checked here is that it tried twice.
    await expect(busy.configured().get(key)).rejects.toThrow(/hash/);
    expect(busy.requests.length).toBe(2);

    const refused = new FakeS3();
    refused.answers = [{ status: 403, body: s3Error("AccessDenied") }];
    const error = (await refused
      .configured()
      .get(key)
      .catch((e) => e)) as StorageError;
    expect(error.kind).toBe("invalid");
    expect(refused.requests.length).toBe(1);
  });

  it("reports a service it cannot reach as unavailable and retryable", async () => {
    const key = await keyFor(bytes("x"));
    const down = new GarageFileObjectStore({
      endpoint: "http://garage:3900",
      region: "garage",
      bucket: "rei-files",
      accessKeyId: "GKtest",
      secretAccessKey: "s",
      retries: 1,
      sleep: async () => {},
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const error = (await down.get(key).catch((e) => e)) as StorageError;
    expect(error.kind).toBe("unavailable");
    expect(error.retryable).toBe(true);
  });

  it("refuses a bucket name S3 would not accept, before touching the network", () => {
    for (const bucket of ["Rei-Files", "rei_files", "a", "rei..files", "192.168.0.1", "rei-"])
      expect(BUCKET_PATTERN.test(bucket)).toBe(false);
    expect(BUCKET_PATTERN.test("rei-files")).toBe(true);
    expect(
      () =>
        new GarageFileObjectStore({
          endpoint: "http://garage:3900",
          region: "garage",
          bucket: "Rei Files",
          accessKeyId: "GK",
          secretAccessKey: "s",
        }),
    ).toThrow(/bucket/);
  });
});

describe("the Garage adapter's streamed put", () => {
  it("lets each chunk go once the socket has taken it, however fast the receiver reads", async () => {
    // fetch (undici 7, in Node 24) kept every chunk of a streamed body alive while a fast receiver kept up: a 1 GiB put
    // to Garage on the local network cost 1 GiB of memory. Counting what a forced GC can still reach is deterministic;
    // RSS is not. Newer Node releases do not show the leak, so the put must also stay off fetch altogether.
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const CHUNK = 1024 * 1024;
    const COUNT = 48;
    const CHECK_AT = 40;
    const endpoint = await serve((request, response) => {
      if (request.method === "HEAD") response.setHeader("content-length", String(CHUNK * COUNT));
      request.resume();
      request.on("end", () => response.end());
    });
    const block = new Uint8Array(CHUNK).fill(7);
    const whole = new Uint8Array(CHUNK * COUNT).fill(7) as Uint8Array<ArrayBuffer>;
    const sha256 = await sha256Hex(whole);
    const sent: WeakRef<ArrayBuffer>[] = [];
    let reachable = -1;
    const stream = () => {
      let made = 0;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (made === CHECK_AT) {
            // The first half went out long ago; nothing should still hold it.
            await new Promise((resolve) => setImmediate(resolve));
            gc();
            reachable = sent.slice(0, CHECK_AT / 2).filter((ref) => ref.deref() !== undefined).length;
          }
          if (made === COUNT) return controller.close();
          const chunk = block.slice();
          sent.push(new WeakRef(chunk.buffer));
          made++;
          controller.enqueue(chunk);
        },
      });
    };
    const fetched: string[] = [];
    const store = new GarageFileObjectStore({
      endpoint,
      region: "garage",
      bucket: "rei-files",
      accessKeyId: "GKtestkey",
      secretAccessKey: "testsecret",
      retries: 0,
      fetchImpl: ((url: string, init?: RequestInit) => {
        fetched.push(String(init?.method));
        return fetch(url, init);
      }) as typeof fetch,
    });
    await store.put({ key: objectKey("obj_test", sha256), sha256, byteLength: whole.byteLength, stream });
    expect(reachable).toBe(0);
    expect(fetched).toEqual(["HEAD"]);
  });

  it("calls a body Garage refuses as not the signed one an integrity failure, and does not retry it", async () => {
    const s3 = await new FakeS3().listen();
    const content = bytes("x".repeat(5000));
    // Garage v2 answers a body whose SHA-256 is not the signed x-amz-content-sha256 with 400 InvalidDigest.
    s3.answers = [{ status: 400, body: s3Error("InvalidDigest") }];
    const error = (await s3
      .configured()
      .put({ key: await keyFor(content), sha256: await sha256Hex(content), byteLength: 5000, stream: chunked(content) })
      .catch((e) => e)) as StorageError;
    expect([error.kind, error.retryable, error.code]).toEqual(["integrity", false, "InvalidDigest"]);
    expect(s3.requests.length).toBe(1);
  });

  it("refuses a stream shorter or longer than it promised before it sends a whole body, without retrying", async () => {
    const content = bytes("y".repeat(5000));
    const sha256 = await sha256Hex(content);
    const key = await keyFor(content);
    for (const source of [content.subarray(0, 4000), bytes("y".repeat(6000))]) {
      const s3 = await new FakeS3().listen();
      let opened = 0;
      const stream = () => {
        opened++;
        return chunked(source)();
      };
      const error = (await s3
        .configured()
        .put({ key, sha256, byteLength: content.byteLength, stream })
        .catch((e) => e)) as StorageError;
      expect([error.kind, error.retryable]).toEqual(["integrity", false]);
      expect(error.message).toMatch(/promised/);
      expect(opened).toBe(1);
      // The server never saw a complete request, so it never answered or recorded one.
      expect(s3.requests).toEqual([]);
    }
  });

  it("stops uploading when the answer comes first, and reports that answer", async () => {
    let connections = 0;
    const endpoint = await serve((request, response) => {
      connections++;
      // Refuse straight away, without reading the 64 MiB that is on its way.
      response.writeHead(403, { "content-type": "application/xml" });
      response.end(s3Error("AccessDenied"));
      request.on("error", () => undefined);
    });
    const store = new GarageFileObjectStore({
      endpoint,
      region: "garage",
      bucket: "rei-files",
      accessKeyId: "GK",
      secretAccessKey: "s",
      sleep: async () => {},
    });
    const content = new Uint8Array(64 * 1024 * 1024) as Uint8Array<ArrayBuffer>;
    const error = (await store
      .put({
        key: await keyFor(content),
        sha256: await sha256Hex(content),
        byteLength: content.byteLength,
        stream: chunked(content, 1024 * 1024),
      })
      .catch((e) => e)) as StorageError;
    expect([error.kind, error.code]).toEqual(["invalid", "AccessDenied"]);
    expect(connections).toBe(1);
  });

  it("gives up at its deadline or the caller's abort, stops reading the source and closes the connection", async () => {
    const open = new Set<import("node:net").Socket>();
    const endpoint = await serve((request) => {
      // Takes the body and never answers.
      request.resume();
    });
    servers.at(-1)!.on("connection", (socket) => {
      open.add(socket);
      socket.on("close", () => open.delete(socket));
    });
    const content = bytes("z".repeat(5000));
    const sha256 = await sha256Hex(content);
    const key = await keyFor(content);
    const store = (timeoutMs: number) =>
      new GarageFileObjectStore({
        endpoint,
        region: "garage",
        bucket: "rei-files",
        accessKeyId: "GK",
        secretAccessKey: "s",
        timeoutMs,
        retries: 0,
      });

    const late = (await store(200)
      .put({ key, sha256, byteLength: content.byteLength, stream: chunked(content) })
      .catch((e) => e)) as StorageError;
    expect([late.kind, late.message]).toEqual(["aborted", expect.stringMatching(/took too long/)]);

    // A source that never ends: the caller's abort has to stop it.
    let cancelled = false;
    const endless = () =>
      new ReadableStream<Uint8Array>({
        pull: (controller) =>
          new Promise<void>((resolve) =>
            setTimeout(() => {
              if (!cancelled) controller.enqueue(bytes("z"));
              resolve();
            }, 5),
          ),
        cancel: () => {
          cancelled = true;
        },
      });
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 100);
    const stopped = (await store(30_000)
      .put({ key, sha256, byteLength: content.byteLength, stream: endless, signal: caller.signal })
      .catch((e) => e)) as StorageError;
    expect(stopped.kind).toBe("aborted");
    expect(cancelled).toBe(true);
    await expect.poll(() => open.size).toBe(0);
  });

  it("retries a service it cannot reach, reading the source again each time", async () => {
    // A port that was just free: nothing listens there.
    const endpoint = await serve(() => undefined);
    await new Promise((resolve) => servers.pop()!.close(resolve));
    const content = bytes("w".repeat(500));
    let opened = 0;
    const store = new GarageFileObjectStore({
      endpoint,
      region: "garage",
      bucket: "rei-files",
      accessKeyId: "GK",
      secretAccessKey: "s",
      retries: 2,
      sleep: async () => {},
    });
    const error = (await store
      .put({
        key: await keyFor(content),
        sha256: await sha256Hex(content),
        byteLength: 500,
        stream: () => {
          opened++;
          return chunked(content)();
        },
      })
      .catch((e) => e)) as StorageError;
    expect([error.kind, error.retryable]).toEqual(["unavailable", true]);
    expect(opened).toBe(3);
  });
});
