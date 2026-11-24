// The Triggers page uses the same validation as the agent's tools and records changes in the edit log.
import type { CreateTriggerRequest, Trigger } from "@rei/protocol";
import type { ToolCatalog } from "../pi/policy-ext.ts";
import type { AppStore } from "../store/store.ts";
import { Invalid, notFound } from "../util/errors.ts";
import { applyPatch, buildNew, type SkillLookup, specContext } from "./spec.ts";
import type { TriggerStore } from "./store.ts";

interface TriggerApiDeps {
  app: AppStore;
  triggers: TriggerStore;
  catalog: ToolCatalog;
  skills: SkillLookup;
  defaultTz?: () => string;
}

function triggerContext(deps: TriggerApiDeps, agentId: string) {
  return specContext(deps.app, {
    agentId,
    catalog: deps.catalog,
    skills: deps.skills,
    sources: deps.triggers.sources,
    ...(deps.defaultTz ? { defaultTz: deps.defaultTz } : {}),
  });
}

export function createTrigger(deps: TriggerApiDeps, { agentId, ...draft }: CreateTriggerRequest): Trigger {
  if (!deps.app.getAgent(agentId)) throw notFound("That agent does not exist.");
  const fields = buildNew(draft, triggerContext(deps, agentId));
  return deps.triggers.create({ agentId, fields, createdBySessionId: null, author: "user" });
}

export function patchTrigger(deps: TriggerApiDeps, id: string, body: Record<string, unknown>): Trigger {
  const row = deps.triggers.row(id);
  if (!row) throw notFound("That trigger does not exist.");
  if (body.paused !== undefined && typeof body.paused !== "boolean") throw new Invalid("paused must be true or false.");
  const ctx = triggerContext(deps, row.agent_id);
  // Checked as a whole before anything is written, so a bad field changes nothing.
  const next = applyPatch(deps.triggers.fields(row), body, ctx, { allowOnlyRemove: true });
  deps.triggers.update(id, next, { log: true });
  if (typeof body.paused === "boolean") deps.triggers.setPaused(id, body.paused, "user", { log: true });
  return deps.triggers.get(id)!;
}
