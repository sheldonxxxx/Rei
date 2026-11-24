// What an agent's avatar may be (Agent.avatar in the protocol): a built-in bot, a small picture, or an emoji. Pure, so it
// has its own table tests. `normalizeAvatar` returns the text to store, or null when it is not one of the forms.
import { AVATAR_IMAGE_MAX_CHARS } from "@rei/protocol";

const BOT = /^bot:[a-z0-9-]{1,32}$/;
const IMAGE = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const EMOJI_MAX_CHARS = 8;

export function normalizeAvatar(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.startsWith("bot:")) return BOT.test(value) ? value : null;
  if (value.startsWith("data:")) {
    if (value.length > AVATAR_IMAGE_MAX_CHARS) return null;
    const payload = IMAGE.exec(value)?.[1];
    return payload !== undefined && payload.length % 4 === 0 ? value : null;
  }
  const text = value.trim();
  const length = Array.from(text).length; // characters, not UTF-16 units: an emoji is often two
  return length >= 1 && length <= EMOJI_MAX_CHARS && !/\p{Cc}/u.test(text) ? text : null;
}
