// Surface actions: a button press or a final submit from a surface, sent by a client as an A2UI `action`. The server
// reloads the stored surface and decides: accepted only on a live or idle surface owned by this session whose components
// have not changed since the revision the client drew, from a component that has that action, with its checks passing
// against the client's data model. An accepted action becomes the user's next input and starts one run; it is never an
// approval. Every decision is kept on the surface for the Inspector, and a repeated request id has no second effect.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type A2uiComponent,
  failingChecks,
  resolveContext,
  resolveText,
  SURFACE_LIMITS,
  type SurfaceActionDecision,
  type SurfaceActionRequest,
  type SurfaceActionResponse,
} from "@rei/protocol";
import type { ConversationCommands } from "../conversation/commands.ts";
import type { TreeManager } from "../pi/trees.ts";
import type { AppStore } from "../store/store.ts";
import type { Clock } from "../util/clock.ts";
import { HttpError, notFound } from "../util/errors.ts";
import { pushCapped, type SurfaceRecord, SurfacesDoc } from "./model.ts";
import { actionValidator, childRefs } from "./validate.ts";

const context = BACKGROUND_CONTEXT;
const MAX_TEXT = 4_000;

type Json = Record<string, unknown>;

export interface SurfaceActionDeps {
  store: AppStore;
  trees: TreeManager;
  commands: ConversationCommands;
  clock: Clock;
}

/** Components inside a component's subtree (templates included), the component itself first. */
function subtree(components: readonly A2uiComponent[], rootId: string): A2uiComponent[] {
  const byId = new Map(components.map((c) => [c.id, c]));
  const out: A2uiComponent[] = [];
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const c = byId.get(id);
    if (!c) continue;
    out.push(c);
    stack.push(...childRefs(c).reverse());
  }
  return out;
}

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The visible label of a component (a Button's child text), for the message the action writes. */
function labelOf(components: readonly A2uiComponent[], id: string, data: Json): string {
  const byId = new Map(components.map((c) => [c.id, c]));
  const walk = (cid: string, depth: number): string => {
    const c = byId.get(cid);
    if (!c || depth > 4) return "";
    if (c.component === "Text") return resolveText(c.text, { data });
    if (typeof c.child === "string") return walk(c.child, depth + 1);
    if (Array.isArray(c.children))
      return c.children
        .map((x) => walk(String(x), depth + 1))
        .filter(Boolean)
        .join(" ");
    return "";
  };
  return walk(id, 0);
}

const valueText = (v: unknown): string =>
  v === undefined || v === null ? "" : typeof v === "string" ? v : Array.isArray(v) ? v.join(", ") : JSON.stringify(v);

export class SurfaceActions {
  readonly #d: SurfaceActionDeps;

  constructor(deps: SurfaceActionDeps) {
    this.#d = deps;
  }

  async send(sessionId: string, surfaceId: string, request: SurfaceActionRequest): Promise<SurfaceActionResponse> {
    const { store, trees, commands, clock } = this.#d;
    const row = store.getSessionRow(sessionId);
    if (!row) throw notFound("That session does not exist.");
    const tree = await trees.open(row.tree_id);
    const ts = tree.session(sessionId);
    if (!ts) throw notFound("That session does not exist.");
    const conv = ts.conv;
    const action = request.action.action;
    if (JSON.stringify(request.dataModel).length > SURFACE_LIMITS.dataBytes)
      throw new HttpError(400, "bad_action", "The data model is too large.");
    if (!actionValidator().check(request.action))
      throw new HttpError(400, "bad_action", "The action is not a valid A2UI v1.0 action.");
    if (action.surfaceId !== surfaceId) throw new HttpError(400, "bad_action", "The action names another surface.");

    const record = async (decision: SurfaceActionDecision, reason?: string, runId?: string, messageId?: string) =>
      conv.commit(async (tx) => {
        const doc = await tx.doc(SurfacesDoc, conv.id);
        const surface = doc.surfaces[surfaceId];
        if (!surface) return;
        if (decision === "accepted")
          doc.byRequest[request.requestId] = {
            surfaceId,
            ...(runId ? { runId } : {}),
            ...(messageId ? { messageId } : {}),
          };
        pushCapped(
          surface.actions,
          {
            requestId: request.requestId,
            at: clock.now(),
            revision: request.revision,
            componentId: action.sourceComponentId,
            name: action.name,
            decision,
            ...(reason ? { reason } : {}),
            ...(runId ? { runId } : {}),
          },
          SURFACE_LIMITS.actionsKept,
        );
      }, context);

    // Read the stored surface and decide.
    const snapshot = await conv.commit(async (tx) => {
      const doc = await tx.doc(SurfacesDoc, conv.id);
      const prior = doc.byRequest[request.requestId];
      const surface = doc.surfaces[surfaceId];
      return {
        prior: prior ? (JSON.parse(JSON.stringify(prior)) as typeof prior) : undefined,
        surface: surface ? (JSON.parse(JSON.stringify(surface)) as SurfaceRecord) : undefined,
      };
    }, context);
    if (snapshot.prior?.runId && snapshot.prior.messageId) {
      await record("duplicate", "The same request was sent again.", snapshot.prior.runId);
      return { runId: snapshot.prior.runId, messageId: snapshot.prior.messageId };
    }
    const surface = snapshot.surface;
    if (!surface) throw notFound("That surface does not exist.");
    const refuse = async (
      decision: SurfaceActionDecision,
      status: number,
      code: string,
      reason: string,
    ): Promise<never> => {
      await record(decision, reason);
      throw new HttpError(status, code, reason);
    };
    if (surface.sessionId !== sessionId)
      return refuse(
        "rejected",
        409,
        "surface_closed",
        "This is a copy from the chat this one was branched from; it cannot be used here.",
      );
    if (surface.removed) return refuse("rejected", 409, "surface_closed", "This surface was removed.");
    const changedAt = surface.revisions.filter((r) => r.author.kind === "agent").at(-1)?.revision ?? 1;
    if (request.revision < changedAt || request.revision > surface.revision)
      return refuse(
        "stale",
        409,
        "stale_surface",
        "This surface changed since it was shown. Look at it again and retry.",
      );
    const source = surface.components.find((c) => c.id === action.sourceComponentId);
    if (!source) return refuse("rejected", 400, "bad_action", "That component does not exist.");
    const event = ((source.action as Json | undefined)?.event ?? undefined) as Json | undefined;
    if ((source.component !== "Button" && source.component !== "Steps") || !event || event.name !== action.name)
      return refuse("rejected", 400, "bad_action", "That component has no such action.");

    // Re-run the checks against the client's values: the source's own, and for a form every input in its steps.
    const data = request.dataModel;
    const scope = subtree(surface.components, source.id);
    const failures = scope.flatMap((c) => failingChecks(c as Json, { data }).map((m) => `${c.id}: ${m}`));
    if (failures.length > 0)
      return refuse("rejected", 400, "bad_action", `Checks failed: ${failures.slice(0, 3).join("; ")}`);
    const resolved = resolveContext(event.context, { data });
    if (!deepEqual(resolved, action.context))
      return refuse("rejected", 400, "bad_action", "The action's values do not match its data model.");

    // The user's next input: what was done, in words, and the action itself for the model.
    const userMessage = event.userMessage !== undefined ? resolveText(event.userMessage, { data }).trim() : "";
    const isForm = source.component === "Steps";
    const values = Object.entries(resolved)
      .map(([k, v]) => `${k}: ${valueText(v)}`)
      .join("; ");
    let text =
      userMessage ||
      (isForm
        ? `Submitted "${surface.title}"${values ? `: ${values}` : ""}`
        : `Pressed "${labelOf(surface.components, source.id, data) || action.name}" in "${surface.title}"`);
    if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT - 1)}…`;
    const modelText = `${text}\n\n<surface_action>${JSON.stringify({
      surfaceId,
      revision: surface.revision,
      name: action.name,
      sourceComponentId: action.sourceComponentId,
      context: resolved,
    })}</surface_action>`;
    const result = await commands
      .admit({
        sessionId,
        requestId: request.requestId,
        role: "user",
        text,
        modelText,
        surfaceAction: { surfaceId, revision: surface.revision, componentId: source.id, name: action.name },
        // A form is submitted once: a double tap or a retry with a new request id has no second effect.
        ...(isForm ? { onceKey: `surface:${surfaceId}:${source.id}` } : {}),
      })
      .catch(async (error: unknown) => {
        if (error instanceof HttpError && error.code === "already_submitted") await record("duplicate", error.message);
        throw error;
      });
    await record("accepted", undefined, result.runId, result.messageId);
    return { runId: result.runId, messageId: result.messageId };
  }
}
