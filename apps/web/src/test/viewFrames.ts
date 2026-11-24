import type { Message, ReiConversationViewV2, Run, Session, SessionEvent } from "@rei/protocol";

/**
 * Test shorthand for the session stream: tests describe what changed (a snapshot of messages and runs, a message, a run,
 * the session, streamed text) and this turns it into the server's frames (`snapshot`, then `patch` with `{ epoch, rev }`),
 * folding each change into the view it keeps, the way the server diffs successive views.
 */
export type ViewChange =
  | { type: "snapshot"; session: Session; messages: Message[]; runs: Run[]; cursor?: string; before?: string | null }
  | { type: "message.upserted"; message: Message }
  | { type: "message.delta"; messageId: string; offset: number; text: string }
  | { type: "run.upserted"; run: Run }
  | { type: "session.upserted"; session: Session }
  | SessionEvent;

const liveRun = (runs: Run[]): string | null => runs.find((r) => r.status === "running")?.id ?? null;

/** Where an upserted message goes: after the others of its run, else last (the server's order). */
function place(items: Message[], msg: Message): Message[] {
  const i = items.findIndex((m) => m.id === msg.id);
  if (i !== -1) return items.map((m, n) => (n === i ? msg : m));
  let at = -1;
  if (msg.runId) for (let n = items.length - 1; n >= 0 && at === -1; n--) if (items[n]?.runId === msg.runId) at = n + 1;
  if (at === -1) return [...items, msg];
  return [...items.slice(0, at), msg, ...items.slice(at)];
}

export class ViewFrames {
  view: ReiConversationViewV2 | undefined;
  epoch = "test-epoch";
  rev = 0;

  translate(change: ViewChange): SessionEvent[] {
    switch (change.type) {
      case "snapshot": {
        if ("view" in change) {
          this.view = change.view;
          this.epoch = change.epoch;
          this.rev = change.rev;
          return [change];
        }
        this.rev = 0;
        this.view = {
          version: 2,
          session: change.session,
          items: change.messages,
          runs: change.runs,
          before: change.before ?? null,
          live: { runId: liveRun(change.runs) },
          overlays: [],
        };
        return [{ type: "snapshot", epoch: this.epoch, rev: 0, view: this.view }];
      }
      case "message.upserted": {
        const view = this.#need();
        const items = place(view.items, change.message);
        this.view = { ...view, items };
        return [this.#patch({ upsert: [change.message], order: items.map((m) => m.id) })];
      }
      case "message.delta": {
        const view = this.#need();
        const msg = view.items.find((m) => m.id === change.messageId);
        // A delta that does not continue the text is dropped (as the server never sends one).
        if (msg?.status !== "streaming" || change.offset !== msg.text.length) return [];
        const next = { ...msg, text: msg.text + change.text };
        this.view = { ...view, items: view.items.map((m) => (m.id === next.id ? next : m)) };
        return [this.#patch({ upsert: [next] })];
      }
      case "run.upserted": {
        const view = this.#need();
        const i = view.runs.findIndex((r) => r.id === change.run.id);
        const runs = i === -1 ? [...view.runs, change.run] : view.runs.map((r, n) => (n === i ? change.run : r));
        const live = { ...view.live, runId: liveRun(runs) };
        this.view = { ...view, runs, live };
        return [this.#patch({ runs, live })];
      }
      case "session.upserted": {
        const view = this.#need();
        this.view = { ...view, session: change.session };
        return [this.#patch({ session: change.session })];
      }
      default:
        if (change.type === "patch") this.rev = change.rev;
        return [change];
    }
  }

  #need(): ReiConversationViewV2 {
    if (!this.view) throw new Error("emit a snapshot first");
    return this.view;
  }

  #patch(body: Omit<Extract<SessionEvent, { type: "patch" }>, "type" | "epoch" | "rev">): SessionEvent {
    this.rev += 1;
    return { type: "patch", epoch: this.epoch, rev: this.rev, ...body };
  }
}
