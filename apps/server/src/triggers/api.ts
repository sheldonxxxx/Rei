// The Triggers page's edits (PATCH /api/triggers/:id): the same rules as the agent's tools, from the trusted UI, so each
// changed field goes to the edit log and no card is needed.
import type { Trigger } from "@rei/protocol";
import type { ToolCatalog } from "../pi/policy-ext.ts";
import type { AppStore } from "../store/store.ts";
import { Invalid, notFound } from "../util/errors.ts";
import { applyPatch, type SkillLookup, specContext } from "./spec.ts";
import type { TriggerStore } from "./store.ts";

export function patchTrigger(
  deps: { app: AppStore; triggers: TriggerStore; catalog: ToolCatalog; skills: SkillLookup; defaultTz?: () => string },
  id: string,
  body: Record<string, unknown>,
): Trigger {
  const row = deps.triggers.row(id);
  if (!row) throw notFound("That trigger does not exist.");
  if (body.paused !== undefined && typeof body.paused !== "boolean") throw new Invalid("paused must be true or false.");
  const ctx = specContext(deps.app, {
    agentId: row.agent_id,
    catalog: deps.catalog,
    skills: deps.skills,
    sources: deps.triggers.sources,
    ...(deps.defaultTz ? { defaultTz: deps.defaultTz } : {}),
  });
  // Checked as a whole before anything is written, so a bad field changes nothing.
  const next = applyPatch(deps.triggers.fields(row), body, ctx, { allowOnlyRemove: true });
  deps.triggers.update(id, next, { log: true });
  if (typeof body.paused === "boolean") deps.triggers.setPaused(id, body.paused, "user", { log: true });
  return deps.triggers.get(id)!;
}
