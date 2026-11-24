// `node src/node/events-cli.ts sources <command>`: event source administration, run inside the control container by
// `./rei sources` (it opens the same database and the same REI_EVENTS_KEY the server uses, so nothing is sent over HTTP).
// A new secret is printed once here and held nowhere else. Output is for a terminal: no JSON, no logs.
import { join } from "node:path";
import { ensureEventsSchema } from "../db/schema.ts";
import { DEFAULT_GRACE_MS, EventSources, parseEventsKey } from "../events/sources.ts";
import { openSqliteDb } from "./sqlite-db.ts";

const USAGE = `./rei sources <command>

  add <id> [--name "..."]        Make a source and print its secret once, with the address to send events to
  list                           Id, name, status, created, last event, event types seen in the last 30 days
  rotate <id> [--grace 24h]      Make a new secret; the old one keeps working for the grace period (0 ends it now)
  disable <id> | enable <id>     Stop or resume accepting a source's events
  remove <id> [--force]          Delete a source (refused while a trigger listens to it; --force pauses those triggers)

Ids are 2 to 32 characters: a lowercase letter, then lowercase letters, digits or dashes. See docs/events.md.`;

/** "24h", "30m", "90s", "2d" or "0" as milliseconds. */
export function parseGrace(text: string): number {
  const m = /^(\d+)([smhd]?)$/.exec(text.trim());
  if (!m) throw new Error("--grace takes a number with a unit: 30m, 24h, 2d (or 0).");
  const unit = { "": 1000, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "" | "s" | "m" | "h" | "d"];
  return Number(m[1]) * unit;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

const when = (at: number | null): string =>
  at === null ? "never" : new Date(at).toISOString().replace(/\.\d+Z$/, "Z");

export async function run(argv: string[], env: NodeJS.ProcessEnv, out: (line: string) => void): Promise<number> {
  const [group, command, ...rest] = argv;
  if (group !== "sources" || !command || command === "--help" || command === "help") {
    out(USAGE);
    return command === undefined || command === "--help" || command === "help" ? 0 : 2;
  }
  let key: Uint8Array<ArrayBuffer> | undefined;
  try {
    key = parseEventsKey(env.REI_EVENTS_KEY);
  } catch (error) {
    out(`rei: ${error instanceof Error ? error.message : "bad REI_EVENTS_KEY"}`);
    return 1;
  }
  if (!key) {
    out("rei: REI_EVENTS_KEY is not set. Run containers/init.sh, then ./rei start.");
    return 1;
  }
  const db = openSqliteDb(join(env.REI_DATA || "/data", "app.sqlite"));
  try {
    ensureEventsSchema(db);
    const sources = new EventSources(db, key);
    const id = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
    const needId = (): string => {
      if (!id) throw new Error(`${command} needs a source id.`);
      return id;
    };
    switch (command) {
      case "add": {
        const made = await sources.add(needId(), flag(rest, "--name"));
        const base = (env.REI_PUBLIC_URL || "<Rei address>").replace(/\/+$/, "");
        out(`Added source "${made.source.id}".`);
        out("");
        out(`  Send to:  POST ${base}/api/events/${made.source.id}`);
        out(`  Secret:   ${made.secret}`);
        out("");
        out("The secret is shown only now. Give it to the sender; if it is lost, rotate it.");
        return 0;
      }
      case "list": {
        const all = sources.list();
        if (all.length === 0) out("No event sources. Add one with ./rei sources add <id>.");
        for (const s of all) {
          out(`${s.id}  ${s.status}${s.name !== s.id ? `  "${s.name}"` : ""}`);
          out(`  created ${when(s.createdAt)}, last event ${when(s.lastEventAt)}`);
          out(`  types (30 days): ${s.types.length ? s.types.join(", ") : "none"}`);
          if (s.graceUntil) out(`  the earlier secret works until ${when(s.graceUntil)}`);
        }
        return 0;
      }
      case "rotate": {
        const grace = flag(rest, "--grace");
        const done = await sources.rotate(needId(), grace === undefined ? DEFAULT_GRACE_MS : parseGrace(grace));
        out(`Rotated "${id}". New secret: ${done.secret}`);
        out(
          done.graceUntil
            ? `The earlier secret still works until ${when(done.graceUntil)}.`
            : "The earlier secret no longer works.",
        );
        out("The secret is shown only now.");
        return 0;
      }
      case "disable":
      case "enable":
        sources.setStatus(needId(), command === "enable" ? "active" : "disabled");
        out(`${command === "enable" ? "Enabled" : "Disabled"} "${id}".`);
        return 0;
      case "remove": {
        const done = sources.remove(needId(), rest.includes("--force"));
        out(
          `Removed "${id}".${done.paused ? ` Paused ${done.paused} trigger${done.paused === 1 ? "" : "s"} that listened to it.` : ""}`,
        );
        return 0;
      }
      default:
        out(`rei: unknown sources command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    out(`rei: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    db.close();
  }
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2), process.env, (line) => console.log(line));
