// `node src/cli.ts callers <list|add|set|rotate|revoke|usage>`: caller administration. It asks the running gateway over
// loopback with Rei's own token, because the gateway is the only writer of the secret store (node/secretstore.ts); a
// second process writing the file would race it. A new token is printed once, on its own line, and nowhere else.
import type { CallerBudget, GatewayCaller, GatewayCallerCreated, GatewayCallsSummary } from "@rei/protocol";

export interface CallersCliEnv {
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = `usage: callers <command>
  list
  add <id> [--note <text>] [--scopes models,search,embeddings,read,read-local] [budget flags]
  set <id> [--note <text>] [--scopes models,search,embeddings,read,read-local] [budget flags]
  rotate <id> [--grace <seconds>]      the old token keeps working for the grace (default 86400; 0 ends it at once)
  revoke <id>
  usage [--since <hours>h | <days>d]   default 24h
budget flags (a whole number from 0 to 16, or "none" for no cap):
  --provider <id>=<n>   calls in flight to one model provider (repeatable; 0 turns the provider off)
  --default-provider <n> calls in flight to a provider not listed
  --search <n>          searches in flight
  --embeddings <n>      embedding calls in flight
  --reads <n>           page reads in flight
scopes: read-local lets a caller ask for pages on the local network; it is not in the default set.`;

class UsageError extends Error {}

interface Parsed {
  positional: string[];
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[], known: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    if (!known.includes(name)) throw new UsageError(`unknown option --${name}`);
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { positional, flags };
}

const capOf = (text: string, flag: string): number | null => {
  if (text === "none") return null;
  if (!/^\d{1,2}$/.test(text)) throw new UsageError(`--${flag} takes a whole number or "none"`);
  return Number(text);
};

/** The request fields the flags name; a flag that is absent stays out, so the gateway keeps or defaults that field. */
function changes(p: Parsed): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const one = (name: string) => p.flags.get(name)?.at(-1);
  if (one("note") !== undefined) body.note = one("note");
  if (one("scopes") !== undefined)
    body.scopes = one("scopes")!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const budget: Partial<CallerBudget> = {};
  const providers = p.flags.get("provider");
  if (providers) {
    budget.providers = {};
    for (const entry of providers) {
      const eq = entry.lastIndexOf("=");
      if (eq < 1) throw new UsageError("--provider takes <id>=<n>");
      budget.providers[entry.slice(0, eq)] = capOf(entry.slice(eq + 1), "provider");
    }
  }
  if (one("default-provider") !== undefined)
    budget.defaultProvider = capOf(one("default-provider")!, "default-provider");
  if (one("search") !== undefined) budget.search = capOf(one("search")!, "search");
  if (one("embeddings") !== undefined) budget.embeddings = capOf(one("embeddings")!, "embeddings");
  if (one("reads") !== undefined) budget.reads = capOf(one("reads")!, "reads");
  if (Object.keys(budget).length > 0) body.budget = budget;
  return body;
}

const capText = (cap: number | null) => (cap === null ? "none" : String(cap));

export function budgetText(b: CallerBudget): string {
  const providers = Object.entries(b.providers).map(([id, cap]) => `${id}=${capText(cap)}`);
  return [
    ...providers,
    `other providers=${capText(b.defaultProvider)}`,
    `search=${capText(b.search)}`,
    `embeddings=${capText(b.embeddings)}`,
    `reads=${capText(b.reads)}`,
  ].join(" ");
}

const when = (ms: number | null) => (ms === null ? "never" : new Date(ms).toISOString());

function describe(c: GatewayCaller): string[] {
  const state =
    c.revokedAt !== null ? `revoked ${when(c.revokedAt)}` : c.source === "environment" ? "environment" : "active";
  return [
    `${c.id}  ${state}  scopes ${c.scopes.join(",")}`,
    `  budget (calls in flight): ${budgetText(c.budget)}`,
    ...(c.fingerprints.length ? [`  token sha256: ${c.fingerprints.join(", ")}`] : []),
    ...(c.graceUntil !== null ? [`  the previous token works until ${when(c.graceUntil)}`] : []),
    `  last used: ${when(c.lastUsedAt)}${c.note ? `  note: ${c.note}` : ""}`,
  ];
}

function sinceOf(text: string | undefined): number {
  const m = /^(\d{1,4})([hd])$/.exec(text ?? "24h");
  if (!m) throw new UsageError('--since takes hours or days, for example "24h" or "7d"');
  return Date.now() - Number(m[1]) * (m[2] === "h" ? 3_600_000 : 86_400_000);
}

export async function callersCommand(argv: string[], env: CallersCliEnv): Promise<number> {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await env.fetch(env.baseUrl + path, {
        method,
        headers: { authorization: `Bearer ${env.token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error(
        "the gateway did not answer on loopback; is it running? (use `exec` in its container, not `run`)",
      );
    }
    const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    if (!res.ok) throw new Error(`${json.error?.code ?? `http_${res.status}`}: ${json.error?.message ?? "refused"}`);
    return json as T;
  };
  const showToken = (created: GatewayCallerCreated) => {
    for (const line of describe(created.caller)) env.out(line);
    env.out("");
    env.out("Token (shown once; it cannot be read back):");
    env.out(created.token);
  };

  const [command, ...rest] = argv;
  try {
    const flags = ["note", "scopes", "provider", "default-provider", "search", "embeddings", "reads"];
    switch (command) {
      case "list": {
        const { callers } = await call<{ callers: GatewayCaller[] }>("GET", "/callers");
        for (const caller of callers) for (const line of describe(caller)) env.out(line);
        return 0;
      }
      case "add": {
        const p = parseArgs(rest, flags);
        if (p.positional.length !== 1) throw new UsageError("add takes one caller id");
        showToken(await call<GatewayCallerCreated>("POST", "/callers", { id: p.positional[0], ...changes(p) }));
        return 0;
      }
      case "set": {
        const p = parseArgs(rest, flags);
        if (p.positional.length !== 1) throw new UsageError("set takes one caller id");
        const body = changes(p);
        if (Object.keys(body).length === 0) throw new UsageError("set needs at least one option");
        const { caller } = await call<{ caller: GatewayCaller }>(
          "PATCH",
          `/callers/${encodeURIComponent(p.positional[0]!)}`,
          body,
        );
        for (const line of describe(caller)) env.out(line);
        return 0;
      }
      case "rotate": {
        const p = parseArgs(rest, ["grace"]);
        if (p.positional.length !== 1) throw new UsageError("rotate takes one caller id");
        const grace = p.flags.get("grace")?.at(-1);
        if (grace !== undefined && !/^\d{1,8}$/.test(grace)) throw new UsageError("--grace takes seconds");
        showToken(
          await call<GatewayCallerCreated>("POST", `/callers/${encodeURIComponent(p.positional[0]!)}/rotate`, {
            ...(grace === undefined ? {} : { graceSeconds: Number(grace) }),
          }),
        );
        return 0;
      }
      case "revoke": {
        const p = parseArgs(rest, []);
        if (p.positional.length !== 1) throw new UsageError("revoke takes one caller id");
        const { caller } = await call<{ caller: GatewayCaller }>(
          "POST",
          `/callers/${encodeURIComponent(p.positional[0]!)}/revoke`,
          {},
        );
        for (const line of describe(caller)) env.out(line);
        return 0;
      }
      case "usage": {
        const p = parseArgs(rest, ["since"]);
        const since = sinceOf(p.flags.get("since")?.at(-1));
        const s = await call<GatewayCallsSummary>("GET", `/calls/summary?since=${since}`);
        env.out(`Calls since ${when(s.since)}`);
        if (s.rows.length === 0) env.out("  none");
        for (const r of s.rows)
          env.out(
            `  ${r.caller}  ${r.provider ?? "unknown"}  calls ${r.calls} (ok ${r.ok}, errors ${r.errors}, upstream limits ${r.upstreamLimited})  tokens in ${r.inputTokens} out ${r.outputTokens} cached ${r.cachedInputTokens}`,
          );
        env.out(`Refused by a budget since ${when(s.refusalsSince)} (the gateway's last start)`);
        if (s.refusals.length === 0) env.out("  none");
        for (const r of s.refusals) env.out(`  ${r.caller}  ${r.code}  ${r.count}`);
        return 0;
      }
      default:
        env.err(USAGE);
        return 2;
    }
  } catch (cause) {
    if (cause instanceof UsageError) {
      env.err(`${cause.message}\n${USAGE}`);
      return 2;
    }
    env.err(`callers ${command} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
}
