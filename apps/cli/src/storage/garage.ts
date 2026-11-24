// Garage storage for one caller: its own bucket and its own key, made with `garage json-api` inside Dodai's garage
// container. That talks RPC to the node, so it needs no admin token, and it runs where the secrets already are: this CLI
// never reads one. The only secret that passes through is the new key's own, which Garage returns once and the caller
// prints once. Every operation is safe to repeat. Callers use Garage directly over rei-storage-shared (S3 only);
// storage is not behind the gateway (docs/adr/0021).
import type { Ctx } from "../ctx.ts";

/** Prefix of a caller's bucket and of the name of its Garage key. */
export const CALLER_PREFIX = "caller-";

/** What a caller needs to use its storage. `secret` is set only when this call made the key. */
export interface StorageGrant {
  bucket: string;
  keyId: string;
  secret?: string;
  /** What was made now, for the output ("created", "kept"). */
  bucketCreated: boolean;
  keyCreated: boolean;
}

export interface StorageInfo {
  caller: string;
  bucket: string | undefined;
  keyIds: string[];
  objects: number | undefined;
  bytes: number | undefined;
}

export class StorageError extends Error {}

/**
 * A caller id that is also a bucket name: lower-case letters, digits and hyphens, not starting or ending with a hyphen.
 * The gateway also allows `_`, so such an id cannot have storage. `rei` is Rei's own and is reserved.
 */
export function validateStorageId(id: string): string | undefined {
  if (id === "rei") return '"rei" is reserved';
  if (id.includes("_"))
    return "an id with an underscore cannot have storage (bucket names allow lower-case letters, digits and hyphens)";
  if (!/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(id))
    return "the id must be lower-case letters, digits and hyphens, and must not start or end with a hyphen";
  return undefined;
}

/** The name Garage gives the key it makes from GARAGE_DEFAULT_ACCESS_KEY. */
export const REI_KEY_NAME = "default access key";

export const bucketOf = (id: string): string => `${CALLER_PREFIX}${id}`;

interface BucketInfo {
  id: string;
  globalAliases: string[];
  objects: number;
  bytes: number;
  unfinishedMultipartUploads?: number;
  keys: { accessKeyId: string; permissions: { read: boolean; write: boolean; owner: boolean } }[];
}
interface KeyInfo {
  accessKeyId: string;
  name: string;
  secretAccessKey?: string;
  permissions: { createBucket: boolean };
  buckets: { id: string; globalAliases: string[]; permissions: { read: boolean; write: boolean; owner: boolean } }[];
}
interface KeySummary {
  id: string;
  name: string;
}

/** The container's own config: the same file the health check uses. */
const GARAGE = ["/garage", "-c", "/etc/garage/garage.toml", "json-api"];

export class GarageAdmin {
  readonly ctx: Ctx;
  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  /** One admin call. `undefined` is "not found" (a missing bucket or key); anything else that fails throws. */
  async call<T>(endpoint: string, payload: unknown): Promise<T | undefined> {
    const r = await this.ctx.shared.exec("garage", [...GARAGE, endpoint, JSON.stringify(payload)], {
      timeoutMs: 30_000,
    });
    if (r.code === 0) return JSON.parse(r.stdout.trim() || "null") as T;
    const text = `${r.stderr}\n${r.stdout}`;
    if (/NoSuchBucket|NoSuchAccessKey|Bucket not found|Key not found|\(404\)/.test(text)) return undefined;
    if (/not running|No such container|is not running/.test(text))
      throw new StorageError("Dodai's Garage is not running. Start it with ./rei start, then try again.");
    const line = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /^Error:/.test(l));
    throw new StorageError(`Garage ${endpoint} failed: ${line ?? (text.trim().slice(-300) || `exit ${r.code}`)}`);
  }

  private bucket(id: string): Promise<BucketInfo | undefined> {
    return this.call<BucketInfo>("GetBucketInfo", { globalAlias: bucketOf(id) });
  }

  /** The caller's keys, oldest first. More than one only after an interrupted rotation. */
  private async keys(id: string): Promise<KeySummary[]> {
    const all = (await this.call<{ id: string; name: string; created?: string }[]>("ListKeys", null)) ?? [];
    return all.filter((k) => k.name === bucketOf(id)).sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""));
  }

  private async makeKey(id: string, bucketId: string): Promise<{ keyId: string; secret: string }> {
    // A new key has createBucket off, and nothing here turns it on.
    const key = await this.call<KeyInfo>("CreateKey", { name: bucketOf(id) });
    if (!key?.secretAccessKey) throw new StorageError("Garage did not return a key");
    await this.allow(bucketId, key.accessKeyId);
    return { keyId: key.accessKeyId, secret: key.secretAccessKey };
  }

  /** read and write only. `owner` is never sent. The call turns on what is sent as true, so repeating it is harmless. */
  private async allow(bucketId: string, keyId: string): Promise<void> {
    await this.call("AllowBucketKey", {
      bucketId,
      accessKeyId: keyId,
      permissions: { read: true, write: true },
    });
  }

  /** Makes the bucket and the key if they are missing and lets the key read and write the bucket. */
  async grant(id: string): Promise<StorageGrant> {
    let bucket = await this.bucket(id);
    const bucketCreated = bucket === undefined;
    bucket ??= await this.call<BucketInfo>("CreateBucket", { globalAlias: bucketOf(id) });
    if (!bucket) throw new StorageError("Garage did not create the bucket");
    const existing = (await this.keys(id))[0];
    if (existing) {
      await this.allow(bucket.id, existing.id);
      return { bucket: bucketOf(id), keyId: existing.id, bucketCreated, keyCreated: false };
    }
    const made = await this.makeKey(id, bucket.id);
    return { bucket: bucketOf(id), keyId: made.keyId, secret: made.secret, bucketCreated, keyCreated: true };
  }

  /** A new key, then the old ones are deleted: no grace. */
  async rotate(id: string): Promise<StorageGrant> {
    const bucket = await this.bucket(id);
    if (!bucket) throw new StorageError(`${id} has no storage. Give it some with ./rei callers set ${id} --storage`);
    const old = await this.keys(id);
    const made = await this.makeKey(id, bucket.id);
    for (const k of old) await this.call("DeleteKey", { id: k.id });
    return { bucket: bucketOf(id), keyId: made.keyId, secret: made.secret, bucketCreated: false, keyCreated: true };
  }

  /** Deletes the key, which removes all of its bucket permissions. The bucket and its data stay. Returns how many keys went. */
  async revoke(id: string): Promise<number> {
    const keys = await this.keys(id);
    for (const k of keys) await this.call("DeleteKey", { id: k.id });
    return keys.length;
  }

  /** What Garage knows about the caller's storage; `bucket` is undefined when it has none. */
  async info(id: string): Promise<StorageInfo> {
    const bucket = await this.bucket(id);
    const keys = await this.keys(id);
    return {
      caller: id,
      bucket: bucket ? bucketOf(id) : undefined,
      keyIds: keys.map((k) => k.id),
      objects: bucket?.objects,
      bytes: bucket?.bytes,
    };
  }

  /** Every caller that has a bucket or a key. */
  async list(): Promise<StorageInfo[]> {
    const buckets = (await this.call<{ globalAliases: string[] }[]>("ListBuckets", null)) ?? [];
    const keys = (await this.call<{ id: string; name: string }[]>("ListKeys", null)) ?? [];
    const ids = new Set<string>();
    for (const b of buckets)
      for (const a of b.globalAliases) if (a.startsWith(CALLER_PREFIX)) ids.add(a.slice(CALLER_PREFIX.length));
    for (const k of keys) if (k.name.startsWith(CALLER_PREFIX)) ids.add(k.name.slice(CALLER_PREFIX.length));
    const out: StorageInfo[] = [];
    for (const id of [...ids].sort()) out.push(await this.info(id));
    return out;
  }

  /**
   * Deletes the caller's bucket, which Garage allows only when it is empty. Refuses while the caller still has a key
   * (revoke first) and names a non-empty bucket instead of emptying it. Returns false when there was nothing to delete.
   */
  async purge(id: string): Promise<boolean> {
    if ((await this.keys(id)).length > 0)
      throw new StorageError(`${id} still has a storage key. Run ./rei callers revoke ${id} first.`);
    const bucket = await this.bucket(id);
    if (!bucket) return false;
    if (bucket.objects > 0 || bucket.bytes > 0 || (bucket.unfinishedMultipartUploads ?? 0) > 0)
      throw new StorageError(
        `${bucketOf(id)} is not empty (${bucket.objects} object${bucket.objects === 1 ? "" : "s"}, ${bucket.bytes} bytes). Empty it from the caller's side, then purge again.`,
      );
    await this.call("DeleteBucket", { id: bucket.id });
    return true;
  }

  /**
   * Takes createBucket away from Rei's own key, so it can use rei-files and make no other bucket. The key is found by the
   * name Garage's --default-bucket bootstrap gave it, so this never reads a secret. Safe to repeat; false when it is not there.
   */
  async restrictReiKey(): Promise<boolean> {
    const all = (await this.call<{ id: string; name: string }[]>("ListKeys", null)) ?? [];
    const key = all.find((k) => k.name === REI_KEY_NAME);
    if (!key) return false;
    await this.call("UpdateKey", { id: key.id, body: { deny: { createBucket: true } } });
    return true;
  }
}

/** For setup: Rei's key loses createBucket once Garage is up. Never fatal; the answer is a warning, or undefined. */
export async function restrictReiStorageKey(ctx: Ctx): Promise<string | undefined> {
  try {
    await new GarageAdmin(ctx).restrictReiKey();
    return undefined;
  } catch (cause) {
    return `Could not take createBucket from Rei's Garage key (${cause instanceof Error ? cause.message : String(cause)}). Run ./rei setup again once Garage is healthy.`;
  }
}
