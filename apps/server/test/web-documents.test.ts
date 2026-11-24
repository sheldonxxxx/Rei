import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { initializeDatabase } from "../src/db/schema.ts";
import { openSqliteDb } from "../src/node/sqlite-db.ts";
import type { CachedPage } from "../src/web/cache.ts";
import { DOCUMENT_TTL_MS, WebDocumentStore } from "../src/web/documents.ts";
import { sectionsOf } from "./helpers/sections.ts";

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) (db as unknown as { close?: () => void }).close?.();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function openDb(file?: string): { db: Db; file: string } {
  const path = file ?? join(dirs[dirs.push(mkdtempSync(join(tmpdir(), "rei-webdocs-"))) - 1] as string, "app.db");
  const db = openSqliteDb(path);
  initializeDatabase(db);
  dbs.push(db);
  return { db, file: path };
}

const page = (n: number, text = `# Page ${n}\n\nBody ${n}.\n`): CachedPage => ({
  title: `T${n}`,
  url: `https://x.example/final/${n}`,
  text,
  quality: "success",
  extractor: "readability",
  sections: sectionsOf(text),
});

describe("the web document store", () => {
  it("keeps a page per agent and URL with its sections, quality, final URL and content hash", async () => {
    const now = 1_000;
    const { db } = openDb();
    const docs = new WebDocumentStore(db, () => now);
    const stored = await docs.put("agt_a", "ses_1", "https://x.example/1", { ...page(1), note: "From embedded data." });
    expect(stored).toMatchObject({
      agentId: "agt_a",
      requestedUrl: "https://x.example/1",
      url: "https://x.example/final/1",
      title: "T1",
      quality: "success",
      extractor: "readability",
      note: "From embedded data.",
      fetchedAt: 1_000,
      expiresAt: 1_000 + DOCUMENT_TTL_MS,
    });
    expect(stored.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const got = docs.get("agt_a", "https://x.example/1")!;
    expect(got.sections).toEqual(sectionsOf(page(1).text));
    expect(got.text).toBe(page(1).text);
    expect(got.id).toBe(stored.id);
    // Another agent never sees it, even with the same URL.
    expect(docs.get("agt_b", "https://x.example/1")).toBeUndefined();
    expect(docs.has("agt_b", "https://x.example/1")).toBe(false);
    expect(docs.has("agt_a", "https://x.example/1")).toBe(true);
  });

  it("replaces an older copy in place: same id, new text and hash, the latest session", async () => {
    let now = 0;
    const { db } = openDb();
    const docs = new WebDocumentStore(db, () => now);
    const first = await docs.put("agt_a", "ses_1", "https://x.example/1", page(1));
    now = 5_000;
    const second = await docs.put("agt_a", "ses_2", "https://x.example/1", page(1, "# Changed\n"));
    expect(second.id).toBe(first.id);
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(second.fetchedAt).toBe(5_000);
    expect(db.all("SELECT session_id FROM web_documents")).toEqual([{ session_id: "ses_2" }]);
    // The same text is the same hash.
    const third = await docs.put("agt_a", "ses_2", "https://x.example/1", page(1, "# Changed\n"));
    expect(third.contentHash).toBe(second.contentHash);
  });

  it("expires pages after the time to live, and drops expired rows on write and on purge", async () => {
    let now = 0;
    const { db } = openDb();
    const docs = new WebDocumentStore(db, () => now, { ttlMs: 1_000 });
    await docs.put("agt_a", "s", "https://x.example/1", page(1));
    await docs.put("agt_b", "s", "https://x.example/2", page(2));
    now = 999;
    expect(docs.get("agt_a", "https://x.example/1")).toBeDefined();
    now = 1_000;
    expect(docs.get("agt_a", "https://x.example/1")).toBeUndefined();
    expect(docs.has("agt_a", "https://x.example/1")).toBe(false);
    // A write drops its own agent's expired rows only.
    await docs.put("agt_a", "s", "https://x.example/3", page(3));
    expect(docs.list("agt_a").map((d) => d.url)).toEqual(["https://x.example/3"]);
    expect(docs.list("agt_b")).toHaveLength(1);
    expect(docs.purgeExpired()).toBe(1);
    expect(docs.list("agt_b")).toEqual([]);
  });

  it("drops the least recently used beyond the page cap, per agent", async () => {
    let now = 0;
    const { db } = openDb();
    const docs = new WebDocumentStore(db, () => now, { maxDocuments: 3 });
    for (let i = 0; i < 3; i++) {
      now = i;
      await docs.put("agt_a", "s", `u${i}`, page(i));
    }
    await docs.put("agt_b", "s", "other", page(9));
    now = 10;
    expect(docs.get("agt_a", "u0")).toBeDefined(); // u0 is now the most recently used
    now = 11;
    await docs.put("agt_a", "s", "u3", page(3));
    expect(docs.list("agt_a").map((d) => d.url)).toEqual(["u3", "u0", "u2"]);
    expect(docs.list("agt_b")).toHaveLength(1);
  });

  it("drops the least recently used beyond the character cap, and keeps nothing of a page over it alone", async () => {
    let now = 0;
    const { db } = openDb();
    const docs = new WebDocumentStore(db, () => now, { maxChars: 100 });
    now = 1;
    await docs.put("agt_a", "s", "a", page(1, "a".repeat(60)));
    now = 2;
    await docs.put("agt_a", "s", "b", page(2, "b".repeat(30)));
    now = 3;
    await docs.put("agt_a", "s", "c", page(3, "c".repeat(30)));
    expect(docs.list("agt_a").map((d) => d.url)).toEqual(["c", "b"]);
    now = 4;
    const huge = await docs.put("agt_a", "s", "huge", page(4, "h".repeat(101)));
    // The caller still gets the page; the store does not keep it (and it pushed nothing else out).
    expect(huge.text).toHaveLength(101);
    expect(docs.get("agt_a", "huge")).toBeUndefined();
    expect(docs.list("agt_a").map((d) => d.url)).toEqual(["c", "b"]);
  });

  it("survives a restart: a new store on the same database file reads the page", async () => {
    const now = 0;
    const { db, file } = openDb();
    await new WebDocumentStore(db, () => now).put("agt_a", "s", "https://x.example/1", page(1));
    (db as unknown as { close: () => void }).close();
    dbs.splice(dbs.indexOf(db), 1);
    const reopened = openDb(file).db;
    expect(new WebDocumentStore(reopened, () => now).get("agt_a", "https://x.example/1")?.title).toBe("T1");
  });
});
