/**
 * How a provider is shown to people: its connection's name. A connection that no longer exists reads as "Removed provider",
 * never as its id, which is an internal key.
 */
export function providerDisplayName(names: Record<string, string>, providerId: string): string {
  return names[providerId] ?? "Removed provider";
}
