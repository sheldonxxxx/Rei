import { randomBytes } from "./encoding.ts";

const RANDOM_SPACE = 2 ** 48;
let lastTime = -1;
let lastRandom = 0;

const randomPart = (): number => {
  const b = randomBytes(6);
  let n = 0;
  for (const byte of b) n = n * 256 + byte;
  return n;
};

/**
 * Opaque, time-ordered, never-reused id: `<prefix>_<12 hex of ms time><12 hex random>`. Ids made in the same millisecond
 * keep the order they were made in (the random part only ever grows within a millisecond), because rows are listed by
 * `created_at, id` and two messages sent back to back must not swap places.
 */
export function newId(prefix: string, now: number = Date.now()): string {
  const time = Math.floor(now);
  let random = randomPart();
  if (time === lastTime) {
    // Step on from the previous id by a random amount; start over from the low half if the space ran out.
    random = lastRandom + 1 + (random % 4096);
    if (random >= RANDOM_SPACE) random = random % 4096;
  }
  lastTime = time;
  lastRandom = random;
  return `${prefix}_${time.toString(16).padStart(12, "0").slice(-12)}${random.toString(16).padStart(12, "0")}`;
}
