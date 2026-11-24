// Run by run.sh inside a throwaway container on the shared network. Prints "<check> <observed>" lines: a status, a
// status and error code, or "blocked". Never prints the token or a response body.
const base = "http://rei-gateway:8781";
const token = process.env.SMOKE_TOKEN ?? "";
const only = process.env.SMOKE_ONLY ?? "";
const auth = { authorization: `Bearer ${token}` };

async function seen(name, url, init = {}, withCode = false) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    const body = await res.text();
    let code = "";
    if (withCode) {
      try {
        code = `:${JSON.parse(body).error?.code ?? ""}`;
      } catch {}
    }
    console.log(`${name} ${res.status}${code}`);
  } catch {
    console.log(`${name} blocked`);
  }
}

const json = (body, headers = {}) => ({
  method: "POST",
  headers: { ...auth, "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const search = () => seen("search", `${base}/search`, json({ query: "what is the capital of France" }));

if (only === "search") await search();
else {
  await seen("healthz", `${base}/healthz`);
  await seen("internal-port", "http://rei-gateway:8780/healthz", { signal: AbortSignal.timeout(4_000) });
  await seen("status", `${base}/status`);
  await seen("callers", `${base}/callers`, { headers: auth });
  await seen("mcp", `${base}/mcp/connectors`, { headers: auth });
  const chat = { model: "none", messages: [{ role: "user", content: "hi" }] };
  await seen(
    "no-token",
    `${base}/v1/chat/completions`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chat) },
    true,
  );
  await seen(
    "wrong-token",
    `${base}/v1/chat/completions`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token.slice(0, -4)}AAAA`, "content-type": "application/json" },
      body: JSON.stringify(chat),
    },
    true,
  );
  await seen(
    "unknown-provider",
    `${base}/v1/chat/completions`,
    json(chat, { "x-rei-provider-id": "not-connected" }),
    true,
  );
  await search();
  if (process.env.SMOKE_MODEL)
    await seen(
      "model",
      `${base}/v1/responses`,
      // The shape a ChatGPT subscription accepts: a list as input, streamed, not stored (docs/gateway-callers.md).
      json({
        model: process.env.SMOKE_MODEL,
        input: [{ role: "user", content: "Reply with the single word: ok" }],
        stream: true,
        store: false,
      }),
    );
}
