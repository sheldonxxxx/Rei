// Reads the gateway's state for a backup: `GET /backup` on the gateway's internal address, with the stand-in token (the
// gateway answers it to admin scope only, which is what the stand-in token has).
import type { GatewayState } from "./bundle-types.ts";

export async function gatewayBackupState(
  gatewayUrl: string,
  token: () => Promise<string | undefined> | string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayState> {
  const bearer = await token();
  let response: Response;
  try {
    response = await fetchImpl(`${gatewayUrl.replace(/\/+$/, "")}/backup`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error("The gateway could not be reached, so its state was not backed up.");
  }
  if (!response.ok) throw new Error(`The gateway refused to give its state for the backup (HTTP ${response.status}).`);
  return (await response.json()) as GatewayState;
}
