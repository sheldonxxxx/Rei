import { AGENT_BOT_AVATARS } from "@rei/protocol";
import { normalizeAvatar } from "../util/avatar.ts";
import { HttpError } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";
import { askModel, type OneShotDeps } from "./oneshot.ts";

export const NAME_MAX = 40;

const SYSTEM = [
  "You design AI agents. The user describes the agent they want in a sentence; you write its name and an emoji for its avatar.",
  'Reply with only JSON of this shape: {"name": string, "emoji": string}.',
  `"name" is at most ${NAME_MAX} characters, a role or a short friendly name with no quotes.`,
  '"emoji" is a single emoji that suits the agent.',
  "Write in the language the user wrote in.",
].join(" ");

/** The instructions every new agent starts with; only the name changes. */
export const instructionsFor = (name: string): string =>
  `You are ${name}, a personal AI assistant. Be direct, concise and honest about what you do not know.`;

/** What a new agent starts with. */
export interface AgentDesign {
  name: string;
  avatar: string;
  instructions: string;
}

export interface AgentDesignerDeps extends OneShotDeps {
  log: Logger;
  /** The model to ask: the chat-titles model (Settings), else the fast default. */
  model(): Promise<string>;
}

/** An agent made from one sentence: a model writes the design; when it cannot (a provider error, a limit, a timeout, an unreadable reply) nothing is made and the caller says so. */
export class AgentDesigner {
  readonly #d: AgentDesignerDeps;

  constructor(deps: AgentDesignerDeps) {
    this.#d = deps;
  }

  async design(description: string): Promise<AgentDesign> {
    const d = this.#d;
    // Faux mode scripts its replies and has no model to ask; a design call would use one up.
    if (d.runtime.mode === "faux") return fallbackDesign(description);
    let reason: string;
    try {
      const text = await askModel(
        d,
        await d.model(),
        SYSTEM,
        `Description: ${description}\n\nWrite the agent.`,
        "other",
      );
      const design = text === undefined ? undefined : parseDesign(text);
      if (design) return design;
      reason = text === undefined ? "no_reply" : "unreadable";
    } catch (cause) {
      reason = cause instanceof Error ? cause.name : "error";
    }
    d.log.warn("agent.design_failed", { reason });
    throw new HttpError(
      502,
      "design_failed",
      "The model could not design the agent just now (it may be busy or over its limit). Nothing was created; try again in a moment.",
    );
  }
}

/** The model's reply (JSON, maybe inside a code fence) as a design; undefined when it is not JSON or a field is missing, empty, too long or not an emoji. */
export function parseDesign(text: string): AgentDesign | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { name, emoji } = value as Record<string, unknown>;
  if (typeof name !== "string" || typeof emoji !== "string") return undefined;
  const cleanName = name.replace(/\s+/g, " ").trim();
  if (cleanName === "" || cleanName.length > NAME_MAX) return undefined;
  const avatar = emoji.startsWith("bot:") || emoji.startsWith("data:") ? null : normalizeAvatar(emoji);
  if (avatar === null || !/\p{Extended_Pictographic}/u.test(avatar)) return undefined;
  return { name: cleanName, avatar, instructions: instructionsFor(cleanName) };
}

/** The design when no model wrote one: the description as the name, a built-in bot picked by the description's hash, the fixed instructions. */
export function fallbackDesign(description: string): AgentDesign {
  const plain = description
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?。]+$/, "");
  const capital = plain === "" ? "New agent" : plain.charAt(0).toUpperCase() + plain.slice(1);
  const chars = Array.from(capital);
  const name =
    chars.length > NAME_MAX
      ? `${chars
          .slice(0, NAME_MAX - 1)
          .join("")
          .trimEnd()}…`
      : capital;
  let hash = 2166136261;
  for (const ch of description) hash = Math.imul(hash ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return {
    name,
    avatar: AGENT_BOT_AVATARS[hash % AGENT_BOT_AVATARS.length]!,
    instructions: instructionsFor(name),
  };
}
