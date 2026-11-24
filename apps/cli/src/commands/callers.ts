// `rei callers ...`: caller administration. The gateway's own CLI, inside its container, does the gateway side (it is the
// only writer of the caller store); the arguments go through unchanged and its output comes straight to the terminal,
// so a new token is shown once and never held or logged here. `--storage` adds the other side: the caller's own Garage
// bucket and key (storage/garage.ts), for a caller that needs object storage. The gateway still knows nothing of it.
import type { Ctx } from "../ctx.ts";
import type { StorageGrant, StorageInfo } from "../storage/garage.ts";
import { bucketOf, GarageAdmin, StorageError, validateStorageId } from "../storage/garage.ts";

const S3 = "http://rei-garage:3900";

/** The options this command takes out; everything else is the gateway's. */
interface Own {
  storage: boolean;
  yes: boolean;
  rest: string[];
}

function split(args: string[]): Own {
  const rest: string[] = [];
  let storage = false;
  let yes = false;
  for (const arg of args) {
    if (arg === "--storage") storage = true;
    else if (arg === "--yes") yes = true;
    else rest.push(arg);
  }
  return { storage, yes, rest };
}

const gateway = (ctx: Ctx, args: string[]): Promise<number> =>
  ctx.shared.interactive(["exec", "-T", "gateway", "node", "src/cli.ts", "callers", ...args]);

/** What the gateway says about a caller: its `list` line is `<id>  active|revoked ...`. */
async function gatewayState(ctx: Ctx, id: string): Promise<"active" | "revoked" | "missing" | "unknown"> {
  const r = await ctx.shared
    .exec("gateway", ["node", "src/cli.ts", "callers", "list"], { timeoutMs: 30_000 })
    .catch(() => undefined);
  if (r?.code !== 0) return "unknown";
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith(`${id}  `));
  if (!line) return "missing";
  return line.slice(id.length).trim().startsWith("revoked") ? "revoked" : "active";
}

export function printGrant(ctx: Ctx, id: string, g: StorageGrant): void {
  ctx.out.line();
  ctx.out.line(`Storage for ${id} (network rei-storage-shared, external)`);
  ctx.out.line(`  S3        ${S3}  region garage  path-style  bucket ${g.bucket}`);
  ctx.out.line(`  key id    ${g.keyId}`);
  if (g.secret) ctx.out.line(`  secret    ${g.secret}   (shown once)`);
  else
    ctx.out.line(
      "  secret    unchanged (shown only when the key is made; rotate with ./rei callers rotate <id> --storage)",
    );
  ctx.out.line("Put the key id and secret in the caller's own secrets, never in this repository.");
}

function printInfo(ctx: Ctx, s: StorageInfo): void {
  const key = s.keyIds.length ? `key ${s.keyIds.join(", ")}` : "no key (revoked)";
  const size = s.objects === undefined ? "" : `, ${s.objects} object${s.objects === 1 ? "" : "s"}`;
  ctx.out.line(`${s.caller}  storage ${s.bucket ?? "(no bucket)"}  ${key}${size}`);
}

const fail = (ctx: Ctx, message: string): number => {
  ctx.out.line(message);
  return 1;
};

/** Runs a storage step; an error is printed and becomes exit code 1. */
async function storageStep(ctx: Ctx, next: string | undefined, work: () => Promise<number>): Promise<number> {
  try {
    return await work();
  } catch (cause) {
    if (!(cause instanceof StorageError)) throw cause;
    ctx.out.line(`Storage: ${cause.message}${next ? `\n${next}` : ""}`);
    return 1;
  }
}

export async function callers(ctx: Ctx, args: string[]): Promise<number> {
  const own = split(args);
  const [command, id] = own.rest;
  const admin = new GarageAdmin(ctx);

  if (own.yes && command !== "purge") return fail(ctx, "--yes goes with purge only.");
  if (own.storage && command !== "add" && command !== "set" && command !== "rotate")
    return fail(ctx, "--storage goes with add, set and rotate.");
  if (command === "purge") {
    if (!id || own.rest.length !== 2) return fail(ctx, "usage: ./rei callers purge <id> [--yes]");
    return purge(ctx, admin, id, own.yes);
  }
  if (!own.storage) {
    const code = await gateway(ctx, own.rest);
    if (command === "revoke" && id) return revokeStorage(ctx, admin, id, code);
    if (command === "list" && code === 0) return listStorage(ctx, admin, code);
    return code;
  }

  // --storage with add, set or rotate: the id must be a valid bucket name before anything is made.
  if (!id) return fail(ctx, `usage: ./rei callers ${command} <id> --storage`);
  const bad = validateStorageId(id);
  if (bad) return fail(ctx, `${id} cannot have storage: ${bad}.`);
  const again = `Run ./rei callers set ${id} --storage to finish; every step can be repeated.`;

  if (command === "rotate")
    return storageStep(ctx, undefined, async () => {
      printGrant(ctx, id, await admin.rotate(id));
      ctx.out.line("The old key no longer works. The gateway token was not changed.");
      return 0;
    });

  if (command === "add") {
    const code = await gateway(ctx, own.rest);
    if (code !== 0) return code;
  } else if (own.rest.length > 2) {
    // set with options besides --storage: the gateway applies them first.
    const code = await gateway(ctx, own.rest);
    if (code !== 0) return code;
  } else {
    const state = await gatewayState(ctx, id);
    if (state === "missing") return fail(ctx, `${id} is not a caller. Add it first: ./rei callers add ${id} --storage`);
    if (state === "revoked") return fail(ctx, `${id} is revoked, so it cannot be given storage.`);
  }
  const code = await storageStep(ctx, `${id} exists in the gateway; its storage was not made. ${again}`, async () => {
    printGrant(ctx, id, await admin.grant(id));
    return 0;
  });
  return code;
}

async function revokeStorage(ctx: Ctx, admin: GarageAdmin, id: string, gatewayCode: number): Promise<number> {
  const bad = validateStorageId(id);
  if (bad) return gatewayCode;
  // Whatever the gateway said, a storage key that is still there goes: revoke can be run again.
  const storage = await storageStep(
    ctx,
    `Run ./rei callers revoke ${id} again once Dodai's Garage is up.`,
    async () => {
      const n = await admin.revoke(id);
      if (n > 0)
        ctx.out.line(
          `Storage key of ${id} deleted. ${bucketOf(id)} and its data are kept; purge removes an empty bucket.`,
        );
      return 0;
    },
  );
  return gatewayCode !== 0 ? gatewayCode : storage;
}

async function listStorage(ctx: Ctx, admin: GarageAdmin, code: number): Promise<number> {
  return storageStep(ctx, undefined, async () => {
    const all = await admin.list();
    if (all.length > 0) {
      ctx.out.line();
      ctx.out.line("Storage (Garage, one bucket and one key per caller):");
      for (const s of all) printInfo(ctx, s);
    }
    return code;
  });
}

async function purge(ctx: Ctx, admin: GarageAdmin, id: string, yes: boolean): Promise<number> {
  const state = await gatewayState(ctx, id);
  if (state === "active") return fail(ctx, `${id} is still an active caller. Run ./rei callers revoke ${id} first.`);
  return storageStep(ctx, undefined, async () => {
    const info = await admin.info(id);
    if (info.keyIds.length > 0)
      throw new StorageError(`${id} still has a storage key. Run ./rei callers revoke ${id} first.`);
    if (!info.bucket) {
      ctx.out.line(`${id} has no storage bucket. Nothing to purge.`);
      return 0;
    }
    if ((info.objects ?? 0) > 0 || (info.bytes ?? 0) > 0)
      throw new StorageError(
        `${info.bucket} is not empty (${info.objects} object${info.objects === 1 ? "" : "s"}, ${info.bytes} bytes). Empty it from the caller's side, then purge again.`,
      );
    if (!yes) {
      if (!ctx.prompter.interactive)
        throw new StorageError("purge asks for the id to be typed; run it in a terminal or add --yes.");
      const typed = (await ctx.prompter.ask(`Delete the empty bucket ${info.bucket}? Type ${id} to confirm: `)).trim();
      if (typed !== id) {
        ctx.out.line("Nothing was deleted.");
        return 1;
      }
    }
    const done = await admin.purge(id);
    ctx.out.line(done ? `${info.bucket} deleted.` : `${info.bucket} was already gone.`);
    return 0;
  });
}
