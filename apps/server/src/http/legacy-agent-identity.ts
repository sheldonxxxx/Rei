import { AGENT_BOT_AVATARS, AGENT_NAME_MAX_CHARS } from "@rei/protocol";
import { badRequest } from "../util/errors.ts";

/** Preserves creation for older clients that only send a description. */
export function legacyAgentIdentity(description: string): { name: string; avatar: string } {
  description = description.trim();
  if (!description || description.length > 500)
    throw badRequest("bad_request", "The description must be 1 to 500 characters.");
  const plain = description
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?。]+$/, "");
  const capital = plain === "" ? "New agent" : plain.charAt(0).toUpperCase() + plain.slice(1);
  const chars = Array.from(capital);
  const name =
    chars.length > AGENT_NAME_MAX_CHARS
      ? `${chars
          .slice(0, AGENT_NAME_MAX_CHARS - 1)
          .join("")
          .trimEnd()}…`
      : capital;
  let hash = 2166136261;
  for (const ch of description) hash = Math.imul(hash ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return {
    name,
    avatar: AGENT_BOT_AVATARS[hash % AGENT_BOT_AVATARS.length]!,
  };
}
