// The reader's own CLI, run inside its container by `./rei reader ...`: `node src/cli.ts stats [--since 30d]`.
import { formatStats, type ReaderStats } from "./core/stats.ts";

const port = Number(process.env.READER_PORT ?? 8790);
const bound = process.env.READER_HOST;
// The reader may listen on one container address only (compose binds it to its internal network).
const host = bound && bound !== "0.0.0.0" ? bound : "127.0.0.1";

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command !== "stats") {
    console.error(
      "usage: reader stats [--since 30d]\n\nThe render attempts of the window, per engine version: success, fallbacks, rescues and shadow divergence.",
    );
    return command === undefined || command === "--help" ? 0 : 2;
  }
  let since = "30d";
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--since" && rest[i + 1]) since = rest[++i]!;
    else {
      console.error(`reader stats: unknown option ${rest[i]}`);
      return 2;
    }
  }
  const res = await fetch(`http://${host}:${port}/stats?since=${encodeURIComponent(since)}`);
  if (!res.ok) {
    console.error(
      `reader stats: ${((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? res.status}`,
    );
    return 1;
  }
  console.log(formatStats((await res.json()) as ReaderStats));
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
