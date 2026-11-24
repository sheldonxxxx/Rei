import type { Approval, Grant, GrantLength, ProfileName, Session } from "@rei/protocol";
import { until } from "./client.ts";
import type { TestServer } from "./server.ts";
import { detail, say, settled } from "./sessions.ts";

export const pending = async (s: TestServer): Promise<Approval[]> =>
  (await s.client.get("/api/approvals")).body.approvals as Approval[];
export const grants = async (s: TestServer): Promise<Grant[]> =>
  (await s.client.get("/api/grants")).body.grants as Grant[];
export const decide = (
  s: TestServer,
  id: string,
  body: { decision: "approve" | "deny"; length?: GrantLength; hours?: number },
) => s.client.post(`/api/approvals/${id}/decide`, body);
export const setProfile = (s: TestServer, sessionId: string, profile: ProfileName) =>
  s.client.call("PATCH", `/api/sessions/${sessionId}`, { body: { profile } });
export const effects = (s: TestServer) => s.host.plane.approvals.demoEffects();
export const tool = (name: string, args: unknown = {}): string => `[tool: ${name} ${JSON.stringify(args)}]`;
export const sessionOf = async (s: TestServer, id: string): Promise<Session> => (await detail(s, id)).session;

/** Waits for the pending approvals of a session to number `n`. */
export const waitPending = (s: TestServer, sessionId: string, n = 1) =>
  until(
    async () => {
      const list = (await pending(s)).filter((a) => a.sessionId === sessionId);
      return list.length === n ? list : undefined;
    },
    20_000,
    `${n} pending approval(s) for ${sessionId}`,
  );

/** Sends a message and waits until its run (and any earlier one) is finished. */
export async function sayAndSettle(s: TestServer, sessionId: string, text: string) {
  const before = (await detail(s, sessionId)).runs.length;
  await say(s, sessionId, text);
  return settled(s, sessionId, before + 1);
}

/** Sends a prompt expected to pause and waits for its approval card. */
export async function askApproval(s: TestServer, sessionId: string, text: string) {
  await say(s, sessionId, text);
  return waitPending(s, sessionId);
}

export const assistantTexts = (d: { messages: { role: string; text: string }[] }): string[] =>
  d.messages.filter((m) => m.role === "assistant").map((m) => m.text);

/** Waits for the pending approval of a session, decides it, and waits for the resumed or retried run to finish. */
export async function approve(
  s: TestServer,
  sessionId: string,
  body: { length?: GrantLength; hours?: number } = {},
  wait = true,
) {
  const [a] = await waitPending(s, sessionId, 1);
  const before = (await detail(s, sessionId)).runs.length;
  const res = await decide(s, a!.id, { decision: "approve", ...body });
  if (res.status !== 200) throw new Error(`approve failed: ${JSON.stringify(res.body)}`);
  if (wait) await settled(s, sessionId, a!.resumesTool ? before : before + 1);
  return res.body.approval as Approval;
}

export const todo = (text: string): string => tool("demo_add_todo", { text });
export const send = (to: string, text = "hello"): string => tool("demo_send_message", { to, text });
