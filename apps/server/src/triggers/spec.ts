// What a trigger is made of, checked: the one set of rules for the create_trigger and update_trigger tools and for
// PATCH /api/triggers/:id. Every failure is an `Invalid` with one clear sentence.
import type { ProfileName, ReportSetting, Schedule, TriggerAction, TriggerAllow, TriggerStart } from "@rei/protocol";
import { TRIGGER_LIMITS } from "@rei/protocol";
import { EVENT_TYPE } from "../events/receive.ts";
import type { ToolCatalog } from "../pi/policy-ext.ts";
import type { AppStore } from "../store/store.ts";
import { Invalid } from "../util/errors.ts";
import { minGapMs, nextRuns, validateSchedule } from "./schedule.ts";

/** What the rules need to know about skills (a skill action needs a skill the agent can see). */
export interface SkillLookup {
  find(agentId: string, name: string): { name: string; version: number; allowedTools: string[] } | undefined;
}

export type TriggerProfile = Exclude<ProfileName, "yolo">;

/** The editable part of a trigger. */
export interface TriggerFields {
  name: string;
  start: TriggerStart;
  action: TriggerAction;
  landing: "new" | "ongoing";
  report: ReportSetting;
  latenessMinutes: number;
  catchUp: "once" | "skip";
  overlap: "skip" | "queue";
  profile: TriggerProfile;
  allow: TriggerAllow[];
}

/** What the rules need to know about event sources (an event trigger needs a source that exists). */
export interface EventSourceLookup {
  get(id: string): { id: string } | undefined;
  list(): { id: string; types: string[] }[];
}

export interface SpecContext {
  agentId: string;
  defaultTz: string;
  now: number;
  catalog: ToolCatalog;
  skills: SkillLookup;
  /** The event sources; absent when this installation takes no outside events. */
  sources?: EventSourceLookup | undefined;
  /** The agent's own default profile (yolo reads as standard). */
  agentProfile: ProfileName;
}

/** The zone a schedule gets when it names none: the process's. */
export const processZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The context the rules need for a trigger of this agent. */
export function specContext(
  store: AppStore,
  input: {
    agentId: string;
    catalog: ToolCatalog;
    skills: SkillLookup;
    sources?: EventSourceLookup | undefined;
    defaultTz?: () => string;
  },
): SpecContext {
  return {
    agentId: input.agentId,
    defaultTz: (input.defaultTz ?? processZone)(),
    now: store.clock.now(),
    catalog: input.catalog,
    skills: input.skills,
    sources: input.sources,
    agentProfile: store.getAgent(input.agentId)?.defaultProfile ?? "standard",
  };
}

/** Classes an allow entry can never cover: they always ask or are a takeover. */
export const NEVER_ALLOWED = ["irreversible", "credentials", "configure"] as const;

const text = (value: unknown, what: string, max: number): string => {
  if (typeof value !== "string" || value.trim() === "") throw new Invalid(`${what} must be some text.`);
  if (value.length > max) throw new Invalid(`${what} can be at most ${max} characters.`);
  return value.trim();
};

export function checkName(value: unknown): string {
  const name = text(value, "The name", TRIGGER_LIMITS.nameChars * 4).replace(/\s+/g, " ");
  if (name.length > TRIGGER_LIMITS.nameChars)
    throw new Invalid(`The name can be at most ${TRIGGER_LIMITS.nameChars} characters.`);
  return name;
}

export function checkAction(value: unknown, ctx: Pick<SpecContext, "agentId" | "skills">): TriggerAction {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Invalid("The action must be an object with a kind: notify, prompt or skill.");
  const o = value as Record<string, unknown>;
  switch (o.kind) {
    case "notify":
      return { kind: "notify", message: text(o.message, "The message", TRIGGER_LIMITS.textChars) };
    case "prompt":
      return { kind: "prompt", prompt: text(o.prompt, "The prompt", TRIGGER_LIMITS.textChars) };
    case "skill": {
      const name = text(o.skill, "The skill name", 64);
      if (!ctx.skills.find(ctx.agentId, name))
        throw new Invalid(`There is no skill named "${name}" for this agent. Save it as a skill first.`);
      const args =
        o.args === undefined || o.args === null || o.args === ""
          ? undefined
          : text(o.args, "The skill's arguments", TRIGGER_LIMITS.textChars);
      return { kind: "skill", skill: name, ...(args !== undefined ? { args } : {}) };
    }
    default:
      throw new Invalid("The action's kind must be notify, prompt or skill.");
  }
}

export function checkLanding(value: unknown): "new" | "ongoing" {
  if (value !== "new" && value !== "ongoing")
    throw new Invalid(
      'landing must be "new" (a new chat per run) or "ongoing" (one chat that remembers earlier runs).',
    );
  return value;
}
export function checkReport(value: unknown): ReportSetting {
  if (value !== "always" && value !== "on_change" && value !== "never")
    throw new Invalid('report must be "always", "on_change" or "never".');
  return value;
}
export function checkLateness(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > TRIGGER_LIMITS.maxLatenessMinutes)
    throw new Invalid(`latenessMinutes must be a whole number from 1 to ${TRIGGER_LIMITS.maxLatenessMinutes}.`);
  return value;
}
export function checkCatchUp(value: unknown): "once" | "skip" {
  if (value !== "once" && value !== "skip")
    throw new Invalid('catchUp must be "once" (run a missed time once when back) or "skip" (skip a missed time).');
  return value;
}
export function checkOverlap(value: unknown): "skip" | "queue" {
  if (value !== "skip" && value !== "queue")
    throw new Invalid(
      'overlap must be "skip" (skip a run that fires while the last is still going) or "queue" (start it when the last one ends; one waits at most).',
    );
  return value;
}
export function checkProfile(value: unknown): TriggerProfile {
  if (value !== "strict" && value !== "standard" && value !== "relaxed")
    throw new Invalid("profile must be strict, standard or relaxed (a trigger never runs on YOLO).");
  return value;
}

/** An allow list: known tools only, none that always ask, no repeats. */
export function checkAllow(value: unknown, catalog: ToolCatalog): TriggerAllow[] {
  if (!Array.isArray(value)) throw new Invalid("allow must be a list of { tool, destination? }.");
  if (value.length > TRIGGER_LIMITS.allowEntries)
    throw new Invalid(`allow can have at most ${TRIGGER_LIMITS.allowEntries} entries.`);
  const out: TriggerAllow[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || typeof (item as { tool?: unknown }).tool !== "string")
      throw new Invalid("Each allow entry needs a tool name.");
    const { tool, destination } = item as { tool: string; destination?: unknown };
    const policy = catalog.get(tool);
    if (!policy)
      throw new Invalid(`"${tool}" is not a tool you can allow. The tools are: ${catalog.names().sort().join(", ")}.`);
    if ((NEVER_ALLOWED as readonly string[]).includes(policy.actionClass))
      throw new Invalid(`"${tool}" always asks (${policy.actionClass}), so it cannot be allowed in advance.`);
    if (
      destination !== undefined &&
      destination !== null &&
      (typeof destination !== "string" || destination === "" || destination.length > 200)
    )
      throw new Invalid("An allow entry's destination must be a short piece of text.");
    if (policy.allowNeedsDestination && (typeof destination !== "string" || destination === ""))
      throw new Invalid(
        `An allow entry for "${tool}" must name a destination (<connector id>.<tool name>), one tool at a time.`,
      );
    const entry: TriggerAllow = { tool, ...(typeof destination === "string" ? { destination } : {}) };
    if (!out.some((e) => e.tool === entry.tool && e.destination === entry.destination)) out.push(entry);
  }
  return out;
}

/** How a trigger starts: a schedule (checked as before), or events of 1 to 10 types (or all) from a source that exists. */
export function checkStart(value: unknown, ctx: Pick<SpecContext, "defaultTz" | "now" | "sources">): TriggerStart {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Invalid('start must be an object: { kind: "schedule", schedule } or { kind: "event", source, types }.');
  const o = value as Record<string, unknown>;
  if (o.kind === "schedule") {
    const schedule = validateSchedule(o.schedule, ctx.defaultTz);
    checkFuture(schedule, ctx.now);
    return { kind: "schedule", schedule };
  }
  if (o.kind !== "event") throw new Invalid('start.kind must be "schedule" or "event".');
  const known = ctx.sources?.list().map((s) => s.id) ?? [];
  if (typeof o.source !== "string" || !ctx.sources?.get(o.source))
    throw new Invalid(
      known.length === 0
        ? "There are no event sources yet. The owner adds one with ./rei sources add."
        : `There is no event source "${typeof o.source === "string" ? o.source : ""}". The sources are: ${known.join(", ")}.`,
    );
  if (!Array.isArray(o.types) || o.types.length < 1 || o.types.length > TRIGGER_LIMITS.eventTypes)
    throw new Invalid(`start.types must list 1 to ${TRIGGER_LIMITS.eventTypes} event types, or ["*"] for every type.`);
  const types: string[] = [];
  for (const t of o.types) {
    if (typeof t !== "string" || (t !== "*" && (t.length > 64 || !EVENT_TYPE.test(t))))
      throw new Invalid(
        'An event type is lowercase words joined by dots, like "items.new" (at most 4 parts, 64 characters), or "*".',
      );
    if (!types.includes(t)) types.push(t);
  }
  if (types.includes("*") && types.length > 1) throw new Invalid('"*" already means every type; list it alone.');
  return { kind: "event", source: o.source, types };
}

/** Settings that only mean something for a schedule: refused, not silently ignored, when given for an event trigger. */
function scheduleOnly(start: TriggerStart, o: Record<string, unknown>): void {
  if (start.kind !== "event") return;
  for (const key of ["latenessMinutes", "catchUp", "overlap"])
    if (field(o, key) !== undefined)
      throw new Invalid(
        `${key} is for schedules only. Events that arrive while a run is going gather into one waiting run.`,
      );
}

const field = (o: Record<string, unknown>, key: string): unknown => (o[key] === null ? undefined : o[key]);

/** A new trigger from a draft (the create_trigger arguments): checked, with the defaults filled in. */
export function buildNew(input: unknown, ctx: SpecContext): TriggerFields {
  if (typeof input !== "object" || input === null) throw new Invalid("The trigger must be an object.");
  const o = input as Record<string, unknown>;
  const start = checkStart(o.start, ctx);
  scheduleOnly(start, o);
  const action = checkAction(o.action, ctx);
  const gap = start.kind === "schedule" ? minGapMs(start.schedule, ctx.now) : null;
  const cap =
    gap === null
      ? TRIGGER_LIMITS.defaultLatenessMinutes
      : Math.max(1, Math.min(TRIGGER_LIMITS.defaultLatenessMinutes, Math.floor(gap / 60_000)));
  return {
    name: checkName(o.name),
    start,
    action,
    landing: field(o, "landing") === undefined ? "new" : checkLanding(o.landing),
    report: field(o, "report") === undefined ? "on_change" : checkReport(o.report),
    latenessMinutes: field(o, "latenessMinutes") === undefined ? cap : checkLateness(o.latenessMinutes),
    catchUp: field(o, "catchUp") === undefined ? "once" : checkCatchUp(o.catchUp),
    overlap: field(o, "overlap") === undefined ? "skip" : checkOverlap(o.overlap),
    profile:
      field(o, "profile") === undefined
        ? ctx.agentProfile === "yolo"
          ? "standard"
          : ctx.agentProfile
        : checkProfile(o.profile),
    allow: field(o, "allow") === undefined ? [] : checkAllow(o.allow, ctx.catalog),
  };
}

/** A trigger with the changed fields of a patch applied and checked (the update_trigger arguments, or a PATCH body). */
export function applyPatch(
  current: TriggerFields,
  patch: Record<string, unknown>,
  ctx: SpecContext,
  opts: { allowOnlyRemove?: boolean } = {},
): TriggerFields {
  const next: TriggerFields = { ...current };
  if (field(patch, "name") !== undefined) next.name = checkName(patch.name);
  if (field(patch, "start") !== undefined) next.start = checkStart(patch.start, ctx);
  scheduleOnly(next.start, patch);
  if (field(patch, "action") !== undefined) next.action = checkAction(patch.action, ctx);
  if (field(patch, "landing") !== undefined) next.landing = checkLanding(patch.landing);
  if (field(patch, "report") !== undefined) next.report = checkReport(patch.report);
  if (field(patch, "latenessMinutes") !== undefined) next.latenessMinutes = checkLateness(patch.latenessMinutes);
  if (field(patch, "catchUp") !== undefined) next.catchUp = checkCatchUp(patch.catchUp);
  if (field(patch, "overlap") !== undefined) next.overlap = checkOverlap(patch.overlap);
  if (field(patch, "profile") !== undefined) next.profile = checkProfile(patch.profile);
  if (field(patch, "allow") !== undefined) {
    if (opts.allowOnlyRemove) {
      // From the page: what is kept must already be on the list (so no look-up in the tool catalog, which is only filled
      // while a conversation is open).
      const wanted = patch.allow;
      if (!Array.isArray(wanted)) throw new Invalid("allow must be a list of { tool, destination? }.");
      const kept = current.allow.filter((c) =>
        wanted.some(
          (a) =>
            typeof a === "object" &&
            a !== null &&
            (a as TriggerAllow).tool === c.tool &&
            ((a as TriggerAllow).destination ?? undefined) === c.destination,
        ),
      );
      if (kept.length !== wanted.length)
        throw new Invalid("The allow list can only be shortened here; an agent proposes new entries on a card.");
      next.allow = kept;
    } else {
      next.allow = checkAllow(patch.allow, ctx.catalog);
    }
  }
  return next;
}

/** A one-time schedule must still be ahead of us. */
export function checkFuture(schedule: Schedule, now: number): void {
  if (schedule.kind === "once" && nextRuns(schedule, now, 1).length === 0)
    throw new Invalid("That time has already passed; pick a time in the future.");
}

export const PATCH_KEYS = [
  "name",
  "start",
  "action",
  "landing",
  "report",
  "latenessMinutes",
  "catchUp",
  "overlap",
  "profile",
  "allow",
] as const;
