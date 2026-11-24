// The decision channel to the control plane: HTTP over a unix socket in a volume only egress and control mount, so
// the sandbox cannot call it and nothing needs a shared secret.
import http from "node:http";
import type { Decide, DecideResponse } from "@rei/forward-proxy";

const MAX_RESPONSE_BYTES = 64 * 1024;

/** The budget the answer carries, or undefined when it is missing or out of range. */
function validBudget(value: unknown): DecideResponse["budget"] {
  const b = value as { bytes?: unknown; ms?: unknown } | null | undefined;
  const ok = (n: unknown, max: number): n is number => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= max;
  return b && ok(b.bytes, 2 ** 40) && ok(b.ms, 3_600_000) ? { bytes: b.bytes, ms: b.ms } : undefined;
}

/** The local-network scope the answer carries, or undefined when it is missing or not one of the three forms. */
function validScope(value: unknown): DecideResponse["localNetworks"] {
  if (value === "all" || value === "none") return value;
  if (Array.isArray(value) && value.length <= 200 && value.every((entry) => typeof entry === "string")) return value;
  return undefined;
}

export function unixDecide(socketPath: string): Decide {
  return (request, signal) =>
    new Promise<DecideResponse>((resolve, reject) => {
      const body = JSON.stringify(request);
      const req = http.request(
        {
          socketPath,
          method: "POST",
          path: "/egress/decide",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
          signal,
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) return req.destroy(new Error("decide response too large"));
            chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            try {
              if (res.statusCode !== 200) throw new Error(`decide answered ${res.statusCode}`);
              const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<DecideResponse> | null;
              if (!parsed || (parsed.decision !== "allow" && parsed.decision !== "deny")) {
                throw new Error("decide answered with an unknown decision");
              }
              resolve({
                decision: parsed.decision,
                message: typeof parsed.message === "string" ? parsed.message : undefined,
                localNetworks: validScope(parsed.localNetworks),
                budget: validBudget(parsed.budget),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
}
