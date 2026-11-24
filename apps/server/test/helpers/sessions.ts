import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Message, Run, Session } from "@rei/protocol";
import { until } from "./client.ts";
import { startTestServer, type TestServer } from "./server.ts";

export type Detail = { session: Session; messages: Message[]; runs: Run[] };

export const chat = async (s: TestServer): Promise<string> =>
  (await s.client.post("/api/sessions", {})).body.session.id as string;
export const homeChat = (s: TestServer): string =>
  s.host.plane.store.getAgent(s.host.plane.store.defaultAgentId()!)!.homeSessionId;
export const workspaceOf = (s: TestServer, sessionId: string): string =>
  s.host.plane.store.getSessionRowAny(sessionId)!.agent_id;
export const say = (s: TestServer, id: string, text: string, requestId: string = crypto.randomUUID()) =>
  s.client.post(`/api/sessions/${id}/messages`, { requestId, text });
export const detail = async (s: TestServer, id: string): Promise<Detail> =>
  (await s.client.get(`/api/sessions/${id}`)).body as Detail;
export const sessions = async (s: TestServer): Promise<Session[]> =>
  (await s.client.get("/api/sessions")).body.sessions as Session[];

/** Waits until the session has at least `runs` runs and all of them are finished (any outcome). */
export const settled = (s: TestServer, id: string, runs = 1) =>
  until(
    async () => {
      const d = await detail(s, id);
      return d.runs.length >= runs && d.runs.every((r) => r.status !== "queued" && r.status !== "running")
        ? d
        : undefined;
    },
    20_000,
    `session ${id} to settle with ${runs} run(s)`,
  );

export const childrenOf = async (s: TestServer, parentId: string): Promise<Session[]> =>
  (await sessions(s)).filter((x) => x.parentSessionId === parentId);
export const treeOf = (s: TestServer, sessionId: string): string =>
  s.host.plane.store.getSessionRowAny(sessionId)!.tree_id;
export const treeDir = (s: TestServer, treeId: string): string => join(s.dir, "trees", treeId);

/** Stops the server and starts a new one on the same folder, signed in with the same cookie. */
export async function restart(s: TestServer): Promise<TestServer> {
  const { dir } = s;
  const cookie = s.client.cookie;
  await s.stop();
  const next = await startTestServer({ dir });
  next.client.cookie = cookie;
  return next;
}

/** Every file under `dir` whose bytes contain `needle`. */
export function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const bytes = Buffer.from(needle, "utf8");
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && readFileSync(p).includes(bytes)) hits.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return hits;
}

/** The JSON a trace step stored for a model call (the exact payload; in faux mode: the messages sent). */
export function stepPayloads(s: TestServer, sessionId: string): string[] {
  const rows = s.host.plane.store.db.all<{ payload_blob: string | null }>(
    "SELECT payload_blob FROM steps WHERE session_id = ? AND type = 'llm.call' ORDER BY started_at",
    sessionId,
  );
  return rows.flatMap((r) => {
    if (!r.payload_blob) return [];
    const hex = r.payload_blob.slice("sha256:".length);
    const path = join(s.dir, "blobs", hex.slice(0, 2), hex);
    return existsSync(path) ? [readFileSync(path, "utf8")] : [];
  });
}
