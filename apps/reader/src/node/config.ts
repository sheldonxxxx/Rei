// The reader's settings, from the environment (docs/reader.md). Defaults suit the compose project.
import path from "node:path";
import type { ReadEngine } from "@rei/protocol";

export interface ReaderConfig {
  port: number;
  host: string;
  /** host:port of the reader's own forward proxy. */
  proxyPort: number;
  proxyHost: string;
  data: string;
  refuseCidrs: string;
  /** The engines in the order they are tried (READER_ENGINES). */
  engines: ReadEngine[];
  /** Renders at once, per engine. */
  renderSlots: number;
  /** The share of Moli successes that Chromium also renders (0 to 1). */
  shadowRate: number;
  moliPath: string;
  chromiumPath: string;
}

function whole(name: string, env: NodeJS.ProcessEnv, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return value;
}

export function parseEngines(text: string | undefined): ReadEngine[] {
  const names = (text ?? "moli,chromium")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  const out: ReadEngine[] = [];
  for (const name of names) {
    if (name !== "moli" && name !== "chromium")
      throw new Error(`READER_ENGINES: unknown engine "${name}" (moli, chromium)`);
    if (!out.includes(name)) out.push(name);
  }
  if (out.length === 0) throw new Error("READER_ENGINES must name at least one engine");
  return out;
}

export function parseShadowRate(text: string | undefined): number {
  if (text === undefined || text === "") return 0.1;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error("READER_SHADOW_RATE must be a number from 0 to 1");
  return value;
}

function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a port number`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ReaderConfig {
  const data = env.READER_DATA ?? "/data";
  return {
    port: port("READER_PORT", 8790),
    host: env.READER_HOST ?? "0.0.0.0",
    proxyHost: "127.0.0.1",
    proxyPort: port("READER_PROXY_PORT", 3129),
    data: path.resolve(data),
    refuseCidrs: env.READER_REFUSE_CIDRS ?? "",
    engines: parseEngines(env.READER_ENGINES),
    renderSlots: whole("READER_RENDER_SLOTS", env, 2, 1, 16),
    shadowRate: parseShadowRate(env.READER_SHADOW_RATE),
    moliPath: env.READER_MOLI_PATH ?? "/usr/local/bin/moli",
    chromiumPath: env.READER_CHROMIUM_PATH ?? "/usr/bin/chromium",
  };
}
