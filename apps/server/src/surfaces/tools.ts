// The `surface` tool group (always offered): `show_surface` creates a surface and `update_surface` changes or removes
// one. Each call is checked against the official A2UI v1.0 schema with Rei's catalog and against Rei's own rules; a
// refused call returns its errors so the model can repair in the same run, and is kept for the Inspector.
//
// A revision is committed to the `rei.surfaces` document by the call, keyed by its call id, and the result's details
// carry the same revision. Pi commits the tool result after `execute()` returns, so the two are separate commits; the
// call is replay-safe instead: a rerun after a crash finds its revision by call id and returns it unchanged.

import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Extension, ToolExecutionApi } from "@earendil-works/pi-durable";
import { defineExtension } from "@earendil-works/pi-durable";
import { arr, bool, map, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import {
  A2UI_VERSION,
  type A2uiComponent,
  type A2uiMessage,
  SURFACE_CATALOG_ID,
  SURFACE_LIMITS,
  type SurfaceDataModel,
} from "@rei/protocol";
import { reiCatalog1 } from "@rei/protocol/surface-schemas";
import { MODEL_ONLY } from "../pi/callers.ts";
import { policyTool, type ToolCatalog } from "../pi/policy-ext.ts";
import type { AppStore } from "../store/store.ts";
import { newId } from "../util/ids.ts";
import { surfaceFallback } from "./fallback.ts";
import { attachFeed, workerEnded } from "./feeds.ts";
import {
  applyMessage,
  pushCapped,
  pushRevision,
  type SurfaceContent,
  type SurfaceRecord,
  SurfacesDoc,
  summarize,
} from "./model.ts";
import { CATALOG_COMPONENTS, checkComponent, checkMessages, checkSurface } from "./validate.ts";

export const SURFACE_GROUP = "surface";

type Json = Record<string, unknown>;

export interface SurfaceToolDetails {
  [key: string]: JsonValue | undefined;
  surfaceId?: string;
  revision?: number;
  title?: string;
  errors?: string[];
}

/** A compact description of the catalog for the tool description: each component, its properties, and the rules. */
export function catalogNote(): string {
  const cat = reiCatalog1 as unknown as { components: Record<string, Json>; instructions: string };
  // One level of item shape for a list of objects: `{url, caption?}[]`; deeper objects are not expanded.
  const itemsOf = (array: Json): string => {
    const items = array.items as Json | undefined;
    const fields = items?.properties as Record<string, Json> | undefined;
    if (!fields) return "array";
    const need = new Set((items?.required as string[] | undefined) ?? []);
    return `{${Object.keys(fields)
      .map((k) => `${k}${need.has(k) ? "" : "?"}`)
      .join(", ")}}[]`;
  };
  const typeOf = (schema: Json): string => {
    if (typeof schema.$ref === "string") {
      const name = schema.$ref.split("/").pop() ?? "";
      return (
        (
          {
            DynamicString: "text",
            DynamicNumber: "number",
            DynamicBoolean: "bool",
            DynamicStringList: "text[]",
            Child: "id",
            ChildList: "ids|template",
            Action: "action",
          } as Record<string, string>
        )[name] ?? name
      );
    }
    if (Array.isArray(schema.enum)) return (schema.enum as string[]).join("|");
    if (Array.isArray(schema.oneOf)) {
      const branch = (schema.oneOf as Json[]).find((b) => b.type === "array");
      return `${branch ? itemsOf(branch) : "list"}|binding`;
    }
    if (schema.type === "array") return itemsOf(schema);
    return String(schema.type ?? "any");
  };
  const lines = CATALOG_COMPONENTS.map((name) => {
    const def = cat.components[name] as Json;
    const own = (def.allOf as Json[] | undefined)?.find((p) => p.properties) ?? def;
    const props = (own.properties ?? {}) as Record<string, Json>;
    const required = new Set((own.required as string[] | undefined) ?? []);
    const checkable = (def.allOf as Json[] | undefined)?.some((p) => String(p.$ref ?? "").endsWith("Checkable"));
    const list = Object.entries(props)
      .filter(([k]) => k !== "component" && k !== "weight")
      .map(([k, v]) => `${k}${required.has(k) ? "" : "?"}: ${typeOf(v)}`);
    if (checkable) list.push("@checks?");
    const desc = typeof def.description === "string" ? ` — ${def.description.split(". ")[0]}` : "";
    return `- ${name}(${list.join(", ")})${desc}`;
  });
  return [cat.instructions, "", "Components:", ...lines].join("\n");
}

const COMPONENTS_PARAM = arr(obj({ id: str(), component: str() }, { open: true }), {
  description: 'A2UI v1.0 components, a flat list; children are referenced by id; one has id "root".',
});

const text = (t: string, isError = false, details?: SurfaceToolDetails) => ({
  output: [{ type: "text" as const, text: t }],
  ...(isError ? { isError: true } : {}),
  ...(details ? { details: details as JsonValue } : {}),
});

const refused = (tool: string, errors: string[], details: SurfaceToolDetails) =>
  text(
    `The surface was not ${tool === "show_surface" ? "shown" : "changed"}. Fix these and call ${tool} again:\n${errors.map((e) => `- ${e}`).join("\n")}`,
    true,
    { ...details, errors },
  );

export interface SurfaceToolDeps {
  treeId: string;
  store: AppStore;
  catalog: ToolCatalog;
  now?: () => number;
}

export function createSurfaceExtension(deps: SurfaceToolDeps): Extension {
  const { treeId, store, catalog } = deps;
  const now = deps.now ?? Date.now;
  const callerOf = (conversationId: unknown) => {
    const session = store.sessionByConversation(treeId, String(conversationId));
    const runId = session ? store.runningRun(session.id)?.id : undefined;
    return { session, runId };
  };
  const recordFailure = async (
    api: ToolExecutionApi,
    context: Context,
    failure: {
      runId: string;
      tool: "show_surface" | "update_surface";
      surfaceId?: string;
      title?: string;
      errors: string[];
    },
  ) => {
    await api.commit(async (tx) => {
      const doc = await tx.doc(SurfacesDoc, api.conversationId);
      if (doc.failures.some((f) => f.toolCallId === api.callId)) return;
      pushCapped(doc.failures, { at: now(), toolCallId: api.callId, ...failure }, SURFACE_LIMITS.failuresKept);
    }, context);
  };

  /** Checks a candidate change; returns errors, or the new content and the A2UI messages it is made of. */
  const check = (
    before: SurfaceContent,
    messages: A2uiMessage[],
  ): { errors: string[] } | { content: SurfaceContent; messages: A2uiMessage[] } => {
    const errors: string[] = [];
    for (const m of messages) {
      const comps =
        "createSurface" in m
          ? m.createSurface.components
          : "updateComponents" in m
            ? m.updateComponents.components
            : undefined;
      comps?.forEach((c, i) => {
        const e = checkComponent(c, i);
        if (e) errors.push(e);
      });
    }
    if (errors.length) return { errors: errors.slice(0, 20) };
    const schemaErrors = checkMessages(messages);
    if (schemaErrors.length) return { errors: schemaErrors };
    let content = before;
    try {
      for (const m of messages) content = applyMessage(content, m);
    } catch (error) {
      return { errors: [error instanceof Error ? error.message : "The data change could not be applied."] };
    }
    const ruleErrors = checkSurface(content.components, content.dataModel);
    if (ruleErrors.length) return { errors: ruleErrors };
    return { content, messages };
  };

  const show = policyTool(
    catalog,
    {
      actionClass: "write_internal",
      connector: SURFACE_GROUP,
      operation: "surface.show",
      summary: (a: { title?: string }) => `Show ${a.title ? `"${a.title}"` : "a surface"}`,
    },
    {
      name: "show_surface",
      callers: MODEL_ONLY,
      description: [
        "Show a surface: a live piece of interface (a table, chart, map, timeline, form, progress...) placed in your reply where you call this. It appears at once and stays in the chat; change it later with update_surface. Prefer it to long lists or tables in text. The user sees it, so do not repeat its content in your reply. Showing a surface grants no permission: an action the user takes becomes their next message, and your tool calls are decided by policy as usual.",
        `Surfaces use A2UI v1.0 components from Rei's catalog (${SURFACE_CATALOG_ID}). Limits: ${SURFACE_LIMITS.components} components, ${SURFACE_LIMITS.componentBytes / 1000} KB of components, ${SURFACE_LIMITS.dataBytes / 1000} KB of data.`,
        catalogNote(),
      ].join("\n\n"),
      parameters: obj({
        title: str({ description: "A short name for the surface, such as ‘Flight prices’." }),
        components: COMPONENTS_PARAM,
        data: opt(map(unknown(), { description: 'The initial data model, bound with {"@path": "/x"}.' })),
        feed: opt(
          obj({
            session: str({
              description:
                "The id of a worker session you started (start_session). While it runs Rei writes /status, /steps, /percent and /summary into the data model.",
            }),
          }),
        ),
      }),
      replay: "safe",
      execute: async (args, api, context) => {
        const { session, runId } = callerOf(api.conversationId);
        if (!session || !runId) return text("Surfaces can only be shown during a run of a chat.", true);
        const title = args.title.trim().slice(0, 80) || "Surface";
        let feed: SurfaceRecord["feed"];
        if (args.feed) {
          const worker = store.getSessionRow(args.feed.session);
          if (!worker || worker.parent_session_id !== session.id) {
            await recordFailure(api, context, {
              runId,
              tool: "show_surface",
              title,
              errors: [`feed.session "${args.feed.session}" is not a worker session this chat started.`],
            });
            return refused(
              "show_surface",
              [`feed.session "${args.feed.session}" is not a worker session this chat started.`],
              { title },
            );
          }
          if (!workerEnded(worker.status)) feed = { kind: "worker", sessionId: worker.id, title: worker.title };
        }
        const surfaceId = newId("srf", now());
        const data = (args.data ?? {}) as SurfaceDataModel;
        const create: A2uiMessage = {
          version: A2UI_VERSION,
          createSurface: {
            surfaceId,
            catalogId: SURFACE_CATALOG_ID,
            components: args.components as A2uiComponent[],
            dataModel: data,
          },
        };
        const checked = check({ components: [], dataModel: {} }, [create]);
        if ("errors" in checked) {
          await recordFailure(api, context, { runId, tool: "show_surface", title, errors: checked.errors });
          return refused("show_surface", checked.errors, { title });
        }
        const result = await api.commit(async (tx) => {
          const doc = await tx.doc(SurfacesDoc, api.conversationId);
          const known = doc.byCall[api.callId];
          if (known) return { ...known, title: doc.surfaces[known.surfaceId]?.title ?? title, error: undefined };
          if (feed) {
            const live = Object.values(doc.surfaces).filter((s) => s.sessionId === session.id && s.feed && !s.removed);
            if (live.length >= SURFACE_LIMITS.liveSurfacesPerSession)
              return {
                surfaceId: "",
                revision: 0,
                title,
                error: `This chat already has ${live.length} live surfaces (at most ${SURFACE_LIMITS.liveSurfacesPerSession}); remove one with update_surface or show this one without a feed.`,
              };
          }
          const at = now();
          const record: SurfaceRecord = {
            surfaceId,
            sessionId: session.id,
            runId,
            title,
            catalogId: SURFACE_CATALOG_ID,
            createdAt: at,
            updatedAt: at,
            revision: 0,
            components: checked.content.components,
            dataModel: checked.content.dataModel,
            fallback: surfaceFallback(title, checked.content.components, checked.content.dataModel),
            ...(feed ? { feed } : {}),
            base: null,
            revisions: [],
            actions: [],
          };
          pushRevision(record, {
            revision: 1,
            author: { kind: "agent", runId, toolCallId: api.callId, tool: "show_surface" },
            at,
            summary: summarize(checked.messages),
            messages: checked.messages,
          });
          doc.surfaces[surfaceId] = record;
          doc.order.push(surfaceId);
          doc.byCall[api.callId] = { surfaceId, revision: 1 };
          return { surfaceId, revision: 1, title, error: undefined };
        }, context);
        if (result.error) {
          await recordFailure(api, context, { runId, tool: "show_surface", title, errors: [result.error] });
          return refused("show_surface", [result.error], { title });
        }
        if (feed)
          attachFeed(store, {
            surfaceId: result.surfaceId,
            ownerSessionId: session.id,
            workerSessionId: feed.sessionId,
            treeId,
          });
        return text(
          `Shown "${result.title}" as surface ${result.surfaceId} (revision ${result.revision}). It is in your reply; change it with update_surface.`,
          false,
          { surfaceId: result.surfaceId, revision: result.revision, title: result.title },
        );
      },
    },
  );

  const update = policyTool(
    catalog,
    {
      actionClass: "write_internal",
      connector: SURFACE_GROUP,
      operation: "surface.update",
      summary: (a: { surfaceId: string; remove?: boolean }) =>
        a.remove ? `Remove surface ${a.surfaceId}` : `Update surface ${a.surfaceId}`,
    },
    {
      name: "update_surface",
      callers: MODEL_ONLY,
      description:
        "Change a surface this chat showed, in place: add or replace components by id (components no longer reachable from root are dropped), set data at JSON Pointer paths (a null value deletes), or remove it. Works in later runs too. The result is the new revision, or errors to fix.",
      parameters: obj({
        surfaceId: str(),
        components: opt(COMPONENTS_PARAM),
        data: opt(
          arr(
            obj({
              path: str({ description: 'A JSON Pointer such as "/rows" or "/" for the whole model.' }),
              value: unknown(),
            }),
            {
              description: "Data changes, applied in order.",
            },
          ),
        ),
        remove: opt(bool({ description: "Remove the surface from the chat." })),
      }),
      replay: "safe",
      execute: async (args, api, context) => {
        const { session, runId } = callerOf(api.conversationId);
        if (!session || !runId) return text("Surfaces can only be changed during a run of a chat.", true);
        const outcome = await api.commit(async (tx) => {
          const doc = await tx.doc(SurfacesDoc, api.conversationId);
          const known = doc.byCall[api.callId];
          if (known) return { ok: true as const, ...known, title: doc.surfaces[known.surfaceId]?.title ?? "" };
          const record = doc.surfaces[args.surfaceId];
          const fail = (errors: string[]) => ({ ok: false as const, errors, title: record?.title });
          if (!record) return fail([`There is no surface "${args.surfaceId}" in this chat.`]);
          if (record.sessionId !== session.id)
            return fail([
              "That surface belongs to the chat this one was branched from and cannot change here; show a new one.",
            ]);
          if (record.removed) return fail(["That surface was removed; show a new one."]);
          const messages: A2uiMessage[] = [];
          if (args.remove) messages.push({ version: A2UI_VERSION, deleteSurface: { surfaceId: record.surfaceId } });
          else {
            if (args.components?.length)
              messages.push({
                version: A2UI_VERSION,
                updateComponents: { surfaceId: record.surfaceId, components: args.components as A2uiComponent[] },
              });
            for (const d of args.data ?? [])
              messages.push({
                version: A2UI_VERSION,
                updateDataModel: { surfaceId: record.surfaceId, path: d.path, value: d.value ?? null },
              });
          }
          if (messages.length === 0) return fail(["Nothing to change: give components, data or remove."]);
          const at = now();
          let content: SurfaceContent = { components: record.components, dataModel: record.dataModel };
          if (!args.remove) {
            const checked = check(content, messages);
            if ("errors" in checked) return fail(checked.errors);
            content = checked.content;
          } else {
            const schemaErrors = checkMessages(messages);
            if (schemaErrors.length) return fail(schemaErrors);
          }
          const revision = record.revision + 1;
          pushRevision(record, {
            revision,
            author: { kind: "agent", runId, toolCallId: api.callId, tool: "update_surface" },
            at,
            summary: summarize(messages),
            messages,
          });
          record.updatedAt = at;
          if (args.remove) {
            record.removed = true;
            delete record.feed;
          } else {
            record.components = content.components;
            record.dataModel = content.dataModel;
            record.fallback = surfaceFallback(record.title, content.components, content.dataModel);
          }
          doc.byCall[api.callId] = { surfaceId: record.surfaceId, revision };
          return { ok: true as const, surfaceId: record.surfaceId, revision, title: record.title };
        }, context);
        if (!outcome.ok) {
          await recordFailure(api, context, {
            runId,
            tool: "update_surface",
            surfaceId: args.surfaceId,
            ...(outcome.title ? { title: outcome.title } : {}),
            errors: outcome.errors,
          });
          return refused("update_surface", outcome.errors, { surfaceId: args.surfaceId });
        }
        return text(
          args.remove
            ? `Removed surface ${outcome.surfaceId}.`
            : `Updated surface ${outcome.surfaceId} to revision ${outcome.revision}.`,
          false,
          { surfaceId: outcome.surfaceId, revision: outcome.revision, title: outcome.title },
        );
      },
    },
  );

  return defineExtension({ name: SURFACE_GROUP, tools: [show, update] });
}
