// Run by run.sh inside a throwaway container, with no dependencies (node: modules only). Prints "<check> <observed>"
// lines: an HTTP status, "blocked" (no connection), or "reached". Never prints a key, a secret or a response body.
//   SMOKE_MODE=access   S3 as the caller: its own bucket, Rei's bucket, bucket listing, CreateBucket
//   SMOKE_MODE=refused  one S3 call with the key given (after rotate or revoke): the status
//   SMOKE_MODE=rei      Rei's own Garage key (GARAGE_DEFAULT_ACCESS_KEY/SECRET_KEY) against the caller's bucket
//   SMOKE_MODE=net      TCP reach of SMOKE_TARGETS="name=host:port,..."
//   SMOKE_MODE=connect  HTTP CONNECT through a proxy (SMOKE_PROXY=host:port) to SMOKE_TARGETS: the proxy's status line
//   SMOKE_MODE=read     POST /read on the gateway's shared listener for SMOKE_URL (token in SMOKE_TOKEN)
import { createHash, createHmac } from "node:crypto";
import net from "node:net";

const mode = process.env.SMOKE_MODE ?? "";
const endpoint = process.env.SMOKE_ENDPOINT ?? "http://rei-garage:3900";
const asRei = process.env.SMOKE_MODE === "rei";
const keyId = (asRei ? process.env.GARAGE_DEFAULT_ACCESS_KEY : process.env.SMOKE_KEY_ID) ?? "";
const secret = (asRei ? process.env.GARAGE_DEFAULT_SECRET_KEY : process.env.SMOKE_SECRET) ?? "";
const bucket = process.env.SMOKE_BUCKET ?? "";
const reiBucket = process.env.SMOKE_REI_BUCKET ?? "rei-files";
const region = "garage";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** AWS Signature Version 4, path-style. Returns the status, or "blocked" when there was no answer. */
async function s3(method, path, { query = "", body = "" } = {}) {
  const url = new URL(endpoint);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payload = sha256(body);
  const headers = { host: url.host, "x-amz-content-sha256": payload, "x-amz-date": amzDate };
  const signed = Object.keys(headers).sort();
  const canonical = [
    method,
    path,
    query,
    signed.map((k) => `${k}:${headers[k]}\n`).join(""),
    signed.join(";"),
    payload,
  ].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  let k = hmac(`AWS4${secret}`, day);
  for (const part of [region, "s3", "aws4_request"]) k = hmac(k, part);
  const signature = createHmac("sha256", k).update(toSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`;
  try {
    const res = await fetch(`${endpoint}${path}${query ? `?${query}` : ""}`, {
      method,
      headers,
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    return { status: res.status, text };
  } catch {
    return { status: "blocked", text: "" };
  }
}

const say = (name, value) => console.log(`${name} ${value}`);

function tcp(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: Number(port), timeout: 3000 });
    const finish = (v) => {
      s.destroy();
      resolve(v);
    };
    s.once("connect", () => finish("reached"));
    s.once("timeout", () => finish("blocked"));
    s.once("error", () => resolve("blocked"));
  });
}

function connectVia(proxy, target) {
  const [ph, pp] = proxy.split(":");
  return new Promise((resolve) => {
    const s = net.connect({ host: ph, port: Number(pp), timeout: 5000 });
    let data = "";
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.once("connect", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.on("data", (d) => {
      data += d;
      if (data.includes("\r\n")) done(data.split("\r\n")[0].split(" ")[1] ?? "blocked");
    });
    s.once("timeout", () => done("blocked"));
    s.once("error", () => done("blocked"));
    s.once("close", () => done(data ? (data.split("\r\n")[0].split(" ")[1] ?? "blocked") : "blocked"));
  });
}

if (mode === "access") {
  const key = `/${bucket}/probe.txt`;
  say("put-own", (await s3("PUT", key, { body: "smoke" })).status);
  const got = await s3("GET", key);
  say("get-own", got.status);
  say("read-back", got.text === "smoke" ? "match" : "mismatch");
  const list = await s3("GET", `/${bucket}`, { query: "list-type=2" });
  say("list-own", list.status);
  say("list-contains-object", list.text.includes("probe.txt") ? "yes" : "no");
  const buckets = await s3("GET", "/");
  const names = [...buckets.text.matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1]);
  say("list-buckets", `${buckets.status}:${names.join(",")}`);
  say("get-rei", (await s3("GET", `/${reiBucket}/anything`)).status);
  say("put-rei", (await s3("PUT", `/${reiBucket}/probe.txt`, { body: "x" })).status);
  say("list-rei", (await s3("GET", `/${reiBucket}`, { query: "list-type=2" })).status);
  say("create-bucket", (await s3("PUT", `/smoke-created-${Date.now()}`)).status);
  say("delete-own", (await s3("DELETE", key)).status);
} else if (mode === "rei") {
  say("rei-get-caller", (await s3("GET", `/${bucket}/probe.txt`)).status);
  say("rei-list-caller", (await s3("GET", `/${bucket}`, { query: "list-type=2" })).status);
  say("rei-put-caller", (await s3("PUT", `/${bucket}/rei.txt`, { body: "x" })).status);
  say("rei-create-bucket", (await s3("PUT", `/smoke-rei-created-${Date.now()}`)).status);
} else if (mode === "refused") {
  say("refused", (await s3("GET", `/${bucket}`, { query: "list-type=2" })).status);
} else if (mode === "net") {
  for (const entry of (process.env.SMOKE_TARGETS ?? "").split(",").filter(Boolean)) {
    const [name, addr] = entry.split("=");
    const i = addr.lastIndexOf(":");
    say(name, await tcp(addr.slice(0, i), addr.slice(i + 1)));
  }
} else if (mode === "connect") {
  for (const entry of (process.env.SMOKE_TARGETS ?? "").split(",").filter(Boolean)) {
    const [name, addr] = entry.split("=");
    say(name, await connectVia(process.env.SMOKE_PROXY ?? "", addr));
  }
} else if (mode === "read") {
  try {
    const res = await fetch("http://rei-gateway:8781/read", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.SMOKE_TOKEN ?? ""}`, "content-type": "application/json" },
      body: JSON.stringify({
        url: process.env.SMOKE_URL ?? "",
        allowHosts: [new URL(process.env.SMOKE_URL ?? "http://x/").hostname],
        localNetworks: "all",
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await res.json().catch(() => ({}));
    const refused = /own networks/.test(body.message ?? "") ? ":refused" : "";
    say("read", `${res.status}:${body.outcome ?? ""}${refused}`);
  } catch {
    say("read", "blocked");
  }
} else {
  console.log("unknown SMOKE_MODE");
  process.exit(2);
}
