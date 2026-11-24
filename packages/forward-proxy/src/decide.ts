// What the proxy asks and what it is answered (the decision channel itself is the embedding service's: a unix socket to
// the control plane for the egress app, a local function in the reader).

/**
 * The sandbox sends its run's token; the browser listener has no token (the source network is its identity); the render
 * listener sends a render job's token, marked source "render" so it is never taken for a run's.
 */
export type DecideRequest =
  | { token: string; host: string; port: number }
  | { source: "browser"; host: string; port: number }
  | { source: "render"; token: string; host: string; port: number };
export interface DecideResponse {
  decision: "allow" | "deny";
  message?: string;
  /**
   * Which local-network addresses the destination may reach, once the proxy has resolved it. Absent is "none": the proxy
   * refuses every local-network address unless the answer says otherwise.
   */
  localNetworks?: "all" | "none" | string[];
  /**
   * On allow, for a render job: what all of the token's connections together may move (bytes, both ways) and for how
   * long (ms from now). The proxy cuts every connection of the token when either runs out and refuses new ones.
   */
  budget?: { bytes: number; ms: number };
}
/** Rejects (or throws) when the control plane cannot be asked; the proxy then treats it as a deny. */
export type Decide = (request: DecideRequest, signal: AbortSignal) => Promise<DecideResponse>;
