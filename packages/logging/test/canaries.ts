// Strings that must never reach a service log or the gateway call log. Built by concatenation so secret scanners
// do not flag this file; none of them is a real credential.
const tail = "Q7x9Lm2Pz4Rt8Wn6Kb3Vc5Yd";

export const CANARIES = {
  bearer: `Bearer ${"canary"}${tail}`,
  jwt: `${"eyJ"}hbGciOiJIUzI1NiJ9.${"eyJ"}zdWIiOiJjYW5hcnkifQ.${tail}`,
  apiKey: `${"sk"}-canary${tail}`,
  email: `canary.person${"@"}example.com`,
  personal: "my canary diary entry about a private matter",
  urlWithToken: `https://canary.example.com/reset?token=${tail}`,
  connectionString: `postgres://canary:${tail}${"@"}db.internal:5432/rei`,
} as const;

/** The distinctive part of each canary: if any of these appears in output, something leaked. */
export const CANARY_MARKERS: readonly string[] = [
  tail,
  "canary.person",
  "canary diary",
  "canary.example.com",
  "db.internal",
];

/** Every canary marker found in `output` (empty when nothing leaked). */
export function leakedCanaries(output: string): string[] {
  return CANARY_MARKERS.filter((marker) => output.includes(marker));
}

/** An Error whose message carries every canary, the way an upstream or connector error might. */
export function canaryError(): Error {
  return new Error(Object.values(CANARIES).join(" | "));
}
