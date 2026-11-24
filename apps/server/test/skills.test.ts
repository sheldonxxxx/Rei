import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SKILL_LIMITS, type SkillFile } from "@rei/protocol";
import { unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  BROWSER_SKILL_ID,
  BROWSER_SKILL_NAME,
  KNOWLEDGE_SKILL_ID,
  KNOWLEDGE_SKILL_NAME,
} from "../src/skills/builtins.ts";
import { unifiedDiff } from "../src/skills/diff.ts";
import { buildSkillMd, parseSkillMd, readFrontmatter, toBase64, validateFiles } from "../src/skills/parse.ts";
import { exportZip, importZip } from "../src/skills/zip.ts";
import { Invalid } from "../src/util/errors.ts";
import { approve, assistantTexts, pending, tool, waitPending } from "./helpers/approvals.ts";
import { startBrowserServer } from "./helpers/browser.ts";
import { type ExecServer, run, startExecServer } from "./helpers/exec.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, say, settled, stepPayloads, workspaceOf } from "./helpers/sessions.ts";
import { toolResults } from "./helpers/web.ts";

let server: { destroy(): Promise<void> } | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const start = async (): Promise<TestServer & { totpSecret: string }> => {
  const s = await startSignedIn();
  server = s;
  return s;
};

const md = (
  name: string,
  description = "Does a thing. Use it when asked.",
  body = "Step one.\nStep two.",
  extra = "",
): string => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`;
const text = (path: string, content: string): SkillFile => ({ path, encoding: "text", content });
const skill = (name = "weekly-report", extra: SkillFile[] = [], description?: string, body?: string): SkillFile[] => [
  text("SKILL.md", md(name, description, body)),
  ...extra,
];
const store = (s: TestServer) => s.host.plane.skills;
/** Saved skills: what is left once the built-in ones are set aside. */
const own = <T extends { id: string }>(list: T[]): T[] => list.filter((k) => !k.id.startsWith("builtin_"));
const edits = async (s: TestServer) =>
  (await s.client.get("/api/edits")).body.entries as {
    target: { kind: string; skillId?: string };
    field: string;
    before: string | null;
    after: string | null;
    author: string;
  }[];
const invalid = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Invalid);
    return (error as Error).message;
  }
  throw new Error("expected an Invalid error");
};

describe("built-in browser skill", () => {
  it("is available only with the browser, loads its workflow on demand, and cannot be changed", async () => {
    const s = await startBrowserServer();
    server = s;
    const list = (await s.client.get("/api/skills")).body.skills;
    expect(list).toContainEqual(
      expect.objectContaining({ id: BROWSER_SKILL_ID, name: BROWSER_SKILL_NAME, builtIn: true }),
    );
    const found = (await s.client.get(`/api/skills/${BROWSER_SKILL_ID}`)).body;
    expect(found.files[0].content).toContain('view="interactive"');
    const id = await chat(s);
    await run(s, id, "hello");
    const prompt = stepPayloads(s, id).join("\n");
    expect(prompt).toContain(`name=\\"${BROWSER_SKILL_NAME}\\"`);
    expect(prompt).not.toContain("take a new snapshot before using more refs");
    await run(s, id, tool("use_skill", { name: BROWSER_SKILL_NAME }));
    expect(toolResults(s, id).at(-1)!.text).toContain("take a new snapshot before using more refs");
    for (const body of [{ files: skill(BROWSER_SKILL_NAME) }, { restore: 1 }, { agents: [] }]) {
      expect((await s.client.call("PATCH", `/api/skills/${BROWSER_SKILL_ID}`, { body })).status).toBe(400);
    }
    expect((await s.client.call("DELETE", `/api/skills/${BROWSER_SKILL_ID}`)).status).toBe(400);
    expect((await s.client.post("/api/skills", { files: skill(BROWSER_SKILL_NAME) })).status).toBe(400);
    const exported = await s.client.get(`/api/skills/${BROWSER_SKILL_ID}/export`);
    expect(exported.status).toBe(200);
    expect((await s.client.get(`/api/skills/${BROWSER_SKILL_ID}`)).body.files).toEqual(found.files);
    await s.destroy();
    const off = await start();
    expect((await off.client.get("/api/skills")).body.skills.map((k: { id: string }) => k.id)).toEqual([
      KNOWLEDGE_SKILL_ID,
    ]);
    expect((await off.client.get(`/api/skills/${BROWSER_SKILL_ID}`)).status).toBe(404);
  });
});

describe("built-in knowledge skill", () => {
  it("is always available with its reference file, loads on demand, and cannot be changed", async () => {
    const s = await start();
    const list = (await s.client.get("/api/skills")).body.skills;
    expect(list).toContainEqual(
      expect.objectContaining({ id: KNOWLEDGE_SKILL_ID, name: KNOWLEDGE_SKILL_NAME, builtIn: true, fileCount: 2 }),
    );
    const found = (await s.client.get(`/api/skills/${KNOWLEDGE_SKILL_ID}`)).body;
    expect(found.files.map((f: SkillFile) => f.path)).toEqual(["SKILL.md", "references/markdown.md"]);
    expect(parseSkillMd(found.files[0].content).description).toMatch(/^Write or reorganize Knowledge pages/);
    expect(found.files[0].content).not.toMatch(/token/i);
    const id = await chat(s);
    await run(s, id, tool("use_skill", { name: KNOWLEDGE_SKILL_NAME }));
    expect(toolResults(s, id).at(-1)!.text).toContain("Page shape");
    for (const body of [{ files: skill(KNOWLEDGE_SKILL_NAME) }, { restore: 1 }, { agents: [] }]) {
      expect((await s.client.call("PATCH", `/api/skills/${KNOWLEDGE_SKILL_ID}`, { body })).status).toBe(400);
    }
    expect((await s.client.call("DELETE", `/api/skills/${KNOWLEDGE_SKILL_ID}`)).status).toBe(400);
    expect((await s.client.post("/api/skills", { files: skill(KNOWLEDGE_SKILL_NAME) })).status).toBe(400);
    expect((await s.client.get(`/api/skills/${KNOWLEDGE_SKILL_ID}/export`)).status).toBe(200);
    expect((await s.client.get(`/api/skills/${KNOWLEDGE_SKILL_ID}`)).body.files).toEqual(found.files);
  });
});

describe("SKILL.md", () => {
  it("reads name, description, allowed-tools and the body", () => {
    const parsed = parseSkillMd(
      md("weekly-report", "Make the report.", "# Steps\n1. Do it", "allowed-tools: read write\nlicense: MIT\n"),
    );
    expect(parsed).toMatchObject({
      name: "weekly-report",
      description: "Make the report.",
      allowedTools: ["read", "write"],
    });
    expect(parsed.body).toContain("# Steps");
    expect(parseSkillMd(md("a", "d", "b", "allowed-tools: [read, write]\n")).allowedTools).toEqual(["read", "write"]);
  });

  it("says which rule failed", () => {
    expect(invalid(() => parseSkillMd("no frontmatter"))).toMatch(/must start with a frontmatter/);
    expect(invalid(() => parseSkillMd("---\nname: a\n"))).toMatch(/not closed/);
    expect(invalid(() => parseSkillMd("---\nname: [oops\n---\nbody"))).toMatch(/not valid YAML/);
    expect(invalid(() => parseSkillMd("---\n- a\n- b\n---\nbody"))).toMatch(/frontmatter must be/);
    expect(invalid(() => parseSkillMd("---\ndescription: d\n---\nbody"))).toMatch(/needs a name/);
    expect(invalid(() => parseSkillMd(md("Bad_Name")))).toMatch(/not allowed/);
    expect(invalid(() => parseSkillMd(md("-lead")))).toMatch(/not allowed/);
    expect(invalid(() => parseSkillMd(md("double--hyphen")))).toMatch(/not allowed/);
    expect(invalid(() => parseSkillMd(md("a".repeat(65))))).toMatch(/not allowed/);
    expect(invalid(() => parseSkillMd("---\nname: ok\n---\nbody"))).toMatch(/needs a description/);
    expect(invalid(() => parseSkillMd(md("ok", "x".repeat(SKILL_LIMITS.descriptionChars + 1))))).toMatch(
      /at most 1024/,
    );
    expect(invalid(() => parseSkillMd(md("ok", "d", "b", "metadata:\n  a: 1\n")))).toMatch(/metadata/);
    expect(invalid(() => parseSkillMd(`${md("ok")}${"x".repeat(SKILL_LIMITS.skillMdChars)}`))).toMatch(
      /at most 200000/,
    );
  });

  it("builds SKILL.md for an agent's skill and keeps the optional fields of an earlier version", () => {
    const built = buildSkillMd({
      name: "a-b",
      description: "Does: things",
      body: "Body",
      keep: { license: "MIT", "allowed-tools": "read", other: "dropped" },
    });
    const { data, body } = readFrontmatter(built);
    expect(data).toEqual({ name: "a-b", description: "Does: things", license: "MIT", "allowed-tools": "read" });
    expect(body.trim()).toBe("Body");
    expect(parseSkillMd(built).description).toBe("Does: things");
  });
});

describe("a skill's files", () => {
  it("puts SKILL.md first and sorts the rest", () => {
    const { files, bytes } = validateFiles([
      text("scripts/b.py", "b"),
      text("SKILL.md", md("a")),
      text("references/a.md", "a"),
    ]);
    expect(files.map((f) => f.path)).toEqual(["SKILL.md", "references/a.md", "scripts/b.py"]);
    expect(bytes).toBeGreaterThan(0);
  });

  it("refuses paths that leave the folder, repeats, bad encodings and a missing SKILL.md", () => {
    const base = text("SKILL.md", md("a"));
    for (const path of ["../x", "a/../x", "/abs", "a//b", "./x", "C:\\x", "a\\b", ""])
      expect(invalid(() => validateFiles([base, text(path, "x")]))).toMatch(/path|relative|empty/i);
    expect(invalid(() => validateFiles([base, text("x", "1"), text("x", "2")]))).toMatch(/twice/);
    expect(invalid(() => validateFiles([base, { path: "x", encoding: "base64", content: "not base64!" }]))).toMatch(
      /base64/,
    );
    expect(invalid(() => validateFiles([base, { path: "x", encoding: "latin1" as never, content: "x" }]))).toMatch(
      /text.*base64|base64/,
    );
    expect(invalid(() => validateFiles([text("docs/SKILL.md", md("a"))]))).toMatch(/at the top/);
    expect(invalid(() => validateFiles([]))).toMatch(/at least/);
    expect(invalid(() => validateFiles([{ path: "SKILL.md", encoding: "base64", content: "AAAA" }]))).toMatch(
      /must be text/,
    );
  });

  it("caps the number of files and the total size", () => {
    const base = text("SKILL.md", md("a"));
    const many = Array.from({ length: SKILL_LIMITS.files }, (_, i) => text(`f${i}`, "x"));
    expect(invalid(() => validateFiles([base, ...many]))).toMatch(/at most 100 files/);
    expect(invalid(() => validateFiles([base, text("big", "x".repeat(SKILL_LIMITS.totalBytes))]))).toMatch(
      /at most 1 MB/,
    );
    // Binary counts as bytes, not as base64 characters.
    const half = toBase64(new Uint8Array(600_000));
    expect(validateFiles([base, { path: "a.bin", encoding: "base64", content: half }]).bytes).toBeGreaterThan(600_000);
    expect(
      invalid(() =>
        validateFiles([
          base,
          { path: "a.bin", encoding: "base64", content: half },
          { path: "b.bin", encoding: "base64", content: half },
        ]),
      ),
    ).toMatch(/at most 1 MB/);
  });
});

describe("zip", () => {
  const zipOf = (entries: Record<string, string | Uint8Array>): Uint8Array =>
    zipSync(
      Object.fromEntries(
        Object.entries(entries).map(([k, v]) => [k, typeof v === "string" ? new TextEncoder().encode(v) : v]),
      ),
    );

  it("round-trips a skill: one folder named after it, text as text and binary as base64", () => {
    const files: SkillFile[] = [
      text("SKILL.md", md("round-trip")),
      text("scripts/run.sh", "echo hi\n"),
      { path: "assets/logo.bin", encoding: "base64", content: toBase64(new Uint8Array([0, 1, 2, 255])) },
    ];
    const bytes = exportZip("round-trip", files, Date.now());
    expect(Object.keys(unzipSync(bytes)).sort()).toEqual([
      "round-trip/SKILL.md",
      "round-trip/assets/logo.bin",
      "round-trip/scripts/run.sh",
    ]);
    const back = importZip(bytes);
    expect(validateFiles(back).files).toEqual(validateFiles(files).files);
  });

  it("reads SKILL.md at the top, or inside one folder, and ignores the junk a Mac adds", () => {
    expect(
      importZip(zipOf({ "SKILL.md": md("top"), "a.txt": "a" }))
        .map((f) => f.path)
        .sort(),
    ).toEqual(["SKILL.md", "a.txt"]);
    expect(
      importZip(
        zipOf({
          "my/SKILL.md": md("in-folder"),
          "my/x/y.txt": "y",
          "__MACOSX/my/._SKILL.md": "junk",
          "my/.DS_Store": "junk",
        }),
      )
        .map((f) => f.path)
        .sort(),
    ).toEqual(["SKILL.md", "x/y.txt"]);
  });

  it("refuses a bad layout, '..' paths, absolute paths, non-zips, symlinks and too many or too big files", () => {
    expect(invalid(() => importZip(zipOf({ "a/SKILL.md": md("x"), "b/other.txt": "x" })))).toMatch(
      /at the top or inside one folder/,
    );
    expect(invalid(() => importZip(zipOf({ "readme.txt": "x" })))).toMatch(/at the top or inside one folder/);
    expect(invalid(() => importZip(zipOf({ "SKILL.md": md("x"), "../evil": "x" })))).toMatch(/must not contain|folder/);
    expect(invalid(() => importZip(zipOf({ "/abs/SKILL.md": md("x") })))).toMatch(/absolute/);
    expect(invalid(() => importZip(new TextEncoder().encode("this is not a zip file at all")))).toMatch(
      /not a valid \.zip/,
    );
    // A symbolic link: unix host (3), mode 0120777 in the high 16 bits of the external attributes.
    const link = zipSync({
      "SKILL.md": new TextEncoder().encode(md("x")),
      link: [new TextEncoder().encode("/etc/passwd"), { os: 3, attrs: (0o120777 << 16) >>> 0 }],
    });
    expect(invalid(() => importZip(link))).toMatch(/symbolic link/);
    const many: Record<string, Uint8Array> = { "SKILL.md": new TextEncoder().encode(md("x")) };
    for (let i = 0; i < SKILL_LIMITS.files + 1; i++) many[`f${i}`] = new Uint8Array([1]);
    expect(invalid(() => importZip(zipSync(many)))).toMatch(/at most 100 files/);
    // 3 MB of zeros compresses to almost nothing: refused from the directory's sizes, before inflating.
    expect(
      invalid(() =>
        importZip(zipSync({ "SKILL.md": new TextEncoder().encode(md("x")), "big.bin": new Uint8Array(3_000_000) })),
      ),
    ).toMatch(/when unpacked/);
  });
});

describe("unified diff", () => {
  it("shows what changed with context, and nothing for equal text", () => {
    const diff = unifiedDiff("a\nb\nc\nd\ne\nf\ng\nh", "a\nb\nc\nD\ne\nf\ng\nh", "v1", "new");
    expect(diff.split("\n").slice(0, 2)).toEqual(["--- v1", "+++ new"]);
    expect(diff).toContain("-d");
    expect(diff).toContain("+D");
    expect(diff).toContain(" c");
    expect(unifiedDiff("same", "same", "v1", "new")).toBe("");
  });
});

describe("the skill store", () => {
  it("saves, versions, restores, scopes by agent, and deletes", async () => {
    const s = await start();
    const st = store(s);
    const saved = st.save({
      files: skill("weekly-report"),
      author: "agent",
      sessionId: null,
      note: "Saved from chat",
      log: false,
    });
    expect(saved).toMatchObject({ created: true, changed: true });
    expect(saved.skill).toMatchObject({
      name: "weekly-report",
      version: 1,
      author: "agent",
      fileCount: 1,
      agents: null,
    });
    // The same files again: nothing changes.
    expect(st.save({ files: skill("weekly-report"), author: "user", note: "x", log: true })).toMatchObject({
      created: false,
      changed: false,
    });
    const v2 = st.save({
      files: skill("weekly-report", [text("references/a.md", "a")], "Changed description."),
      author: "user",
      note: "Edited on the Skills page",
      log: true,
    });
    expect(v2.skill).toMatchObject({ version: 2, description: "Changed description.", fileCount: 2, author: "user" });
    const got = st.get(saved.skill.id)!;
    expect(got.versions.map((v) => [v.version, v.author, v.note])).toEqual(
      [
        [1, "agent", "Saved from chat"],
        [2, "user", "Edited on the Skills page"],
      ].reverse(),
    );
    expect(st.get(saved.skill.id, 1)!.files).toHaveLength(1);
    // Restore makes a new version from an old one.
    expect(st.restore(saved.skill.id, 1)).toMatchObject({
      version: 3,
      description: "Does a thing. Use it when asked.",
    });
    expect(invalid(() => st.restore(saved.skill.id, 9))).toMatch(/no version 9/);
    // The name can't change while editing.
    expect(
      invalid(() =>
        st.save({ files: skill("other-name"), author: "user", note: "x", log: true, expectId: saved.skill.id }),
      ),
    ).toMatch(/can't be changed/);
    expect((await edits(s)).filter((e) => e.target.kind === "skill").map((e) => e.field)).toEqual(["restore", "files"]); // newest first
    // Agent scoping: a second agent sees nothing until it is listed.
    const now = Date.now();
    s.host.plane.store.db.run(
      "INSERT INTO agents (id, name, avatar, default_profile, instructions, home_session_id, created_at) VALUES ('agt_two', 'Two', 'bot:cat', 'standard', '', NULL, ?)",
      now,
    );
    expect(own(st.list("agt_two"))).toHaveLength(1);
    st.setAgents(saved.skill.id, ["agt_two"]);
    const first = s.host.plane.store.defaultAgentId()!;
    expect(own(st.list(first))).toEqual([]);
    expect(own(st.list("agt_two"))).toHaveLength(1);
    expect(st.byName("weekly-report", first)).toBeUndefined();
    expect(st.byName("weekly-report", "agt_two")).toBeDefined();
    expect(invalid(() => st.setAgents(saved.skill.id, ["agt_nobody"]))).toMatch(/no agent/);
    st.setAgents(saved.skill.id, null);
    expect(own(st.list(first))).toHaveLength(1);
    expect(st.remove(saved.skill.id)).toBe(true);
    expect(st.remove(saved.skill.id)).toBe(false);
    expect(own(st.list())).toEqual([]);
    expect(s.host.plane.store.db.get("SELECT 1 AS x FROM skill_versions")).toBeUndefined();
  });
});

describe("the Skills page's routes", () => {
  it("imports files, then a zip with the same name as a new version, and serves the detail", async () => {
    const s = await start();
    const made = await s.client.post("/api/skills", { files: skill("from-files", [text("references/a.md", "ref")]) });
    expect(made.status).toBe(200);
    expect(made.body.skill).toMatchObject({ name: "from-files", version: 1, author: "user", fileCount: 2 });
    const id = made.body.skill.id as string;
    const zip = exportZip(
      "from-files",
      validateFiles(skill("from-files", [text("references/a.md", "changed")])).files,
      Date.now(),
    );
    const again = await s.client.post("/api/skills", { zip: toBase64(zip) });
    expect(again.body.skill).toMatchObject({ id, version: 2 });
    const detail = (await s.client.get(`/api/skills/${id}`)).body;
    expect(detail.version).toBe(2);
    expect(detail.files.map((f: SkillFile) => f.path)).toEqual(["SKILL.md", "references/a.md"]);
    expect(detail.versions.map((v: { version: number; note: string }) => [v.version, v.note])).toEqual([
      [2, "Imported"],
      [1, "Imported"],
    ]);
    expect((await s.client.get(`/api/skills/${id}?version=1`)).body.files[1].content).toBe("ref");
    expect((await s.client.get(`/api/skills/${id}?version=zero`)).status).toBe(400);
    expect((await s.client.get("/api/skills/skl_nope")).status).toBe(404);
    expect(own((await s.client.get("/api/skills")).body.skills)).toHaveLength(1);
  });

  it("says why an import is refused", async () => {
    const s = await start();
    const bad = await s.client.post("/api/skills", { files: [text("SKILL.md", "no frontmatter")] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/frontmatter/);
    expect((await s.client.post("/api/skills", { zip: "###" })).status).toBe(400);
    expect(
      (await s.client.post("/api/skills", { zip: toBase64(new TextEncoder().encode("not a zip")) })).body.error.message,
    ).toMatch(/not a valid \.zip/);
    expect((await s.client.post("/api/skills", {})).status).toBe(400);
    expect((await s.client.post("/api/skills", "[1]")).status).toBe(400);
    const huge = await s.client.post("/api/skills", { zip: "A".repeat(8_100_000) });
    expect(huge.status).toBe(413);
    expect(huge.body.error.code).toBe("too_large");
    expect(own((await s.client.get("/api/skills")).body.skills)).toEqual([]);
  });

  it("exports a version as a zip named after the skill", async () => {
    const s = await start();
    const { id } = (await s.client.post("/api/skills", { files: skill("exported", [text("scripts/x.sh", "echo")]) }))
      .body.skill;
    const res = await s.client.raw("GET", `/api/skills/${id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/zip/);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="?exported/);
    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual(["exported/SKILL.md", "exported/scripts/x.sh"]);
    expect((await s.client.raw("GET", "/api/skills/skl_nope/export")).status).toBe(404);
  });

  it("PATCH edits the files (a new version), restores, sets agents, and logs each", async () => {
    const s = await start();
    const { id } = (await s.client.post("/api/skills", { files: skill("edited") })).body.skill;
    const edited = await s.client.call("PATCH", `/api/skills/${id}`, {
      body: { files: skill("edited", [text("references/n.md", "n")], "New description.") },
    });
    expect(edited.body.skill).toMatchObject({ version: 2, description: "New description.", author: "user" });
    expect((await s.client.get(`/api/skills/${id}`)).body.versions[0].note).toBe("Edited on the Skills page");
    const renamed = await s.client.call("PATCH", `/api/skills/${id}`, { body: { files: skill("other") } });
    expect(renamed.status).toBe(400);
    expect(renamed.body.error.message).toMatch(/can't be changed/);
    expect(
      (await s.client.call("PATCH", `/api/skills/${id}`, { body: { files: skill("edited"), restore: 1 } })).status,
    ).toBe(400);
    expect((await s.client.call("PATCH", `/api/skills/${id}`, { body: { restore: 1.5 } })).status).toBe(400);
    expect((await s.client.call("PATCH", `/api/skills/${id}`, { body: { restore: 7 } })).status).toBe(400);
    expect((await s.client.call("PATCH", `/api/skills/${id}`, { body: { restore: 1 } })).body.skill).toMatchObject({
      version: 3,
      fileCount: 1,
    });
    const agent = s.host.plane.store.defaultAgentId()!;
    expect(
      (await s.client.call("PATCH", `/api/skills/${id}`, { body: { agents: [agent] } })).body.skill.agents,
    ).toEqual([agent]);
    expect((await s.client.call("PATCH", `/api/skills/${id}`, { body: { agents: "all" } })).status).toBe(400);
    expect(
      (await s.client.call("PATCH", `/api/skills/${id}`, { body: { agents: null } })).body.skill.agents,
    ).toBeNull();
    expect((await s.client.call("PATCH", "/api/skills/skl_nope", { body: { restore: 1 } })).status).toBe(404);
    const log = (await edits(s)).filter((e) => e.target.kind === "skill");
    expect(log.map((e) => e.field)).toEqual(["agents", "agents", "restore", "files"]); // newest first
    expect(log.every((e) => e.author === "user" && e.target.skillId === id)).toBe(true);
  });

  it("DELETE removes the skill and says so in the edit log", async () => {
    const s = await start();
    const { id } = (await s.client.post("/api/skills", { files: skill("doomed") })).body.skill;
    expect((await s.client.call("DELETE", `/api/skills/${id}`)).status).toBe(200);
    expect((await s.client.get(`/api/skills/${id}`)).status).toBe(404);
    expect((await s.client.call("DELETE", `/api/skills/${id}`)).status).toBe(404);
    expect((await edits(s)).find((e) => e.target.kind === "skill" && e.field === "delete")).toMatchObject({
      before: "doomed",
      after: null,
    });
  });

  it("needs a signed-in client", async () => {
    const s = await start();
    expect((await s.client.call("GET", "/api/skills", { cookie: false })).status).toBe(401);
    expect((await s.client.call("POST", "/api/skills", { body: { files: skill() }, csrf: false })).status).toBe(403);
  });
});

describe("use_skill, read_skill_file and save_skill in a chat", () => {
  const seed = (
    s: TestServer,
    files = skill(
      "weekly-report",
      [
        text("references/api.md", "# API\nGET /x"),
        { path: "assets/p.bin", encoding: "base64", content: toBase64(new Uint8Array([0, 1, 2])) },
      ],
      "Make the weekly report. Use on Mondays.",
      "1. Collect.\n2. Write.",
    ),
  ): string => store(s).save({ files, author: "user", note: "Imported", log: false }).skill.id;

  it("lists skills by name and description in the Capabilities index, the built-in knowledge skill from the start", async () => {
    const s = await start();
    const none = await chat(s);
    await say(s, none, "hi");
    await settled(s, none);
    const before = stepPayloads(s, none)[0]!;
    expect(before).toContain("save_skill");
    expect(before).toContain("skill_saving");
    expect(before).toContain("Skills (read one with use_skill");
    expect(before).toContain(KNOWLEDGE_SKILL_NAME);
    seed(s);
    const id = await chat(s);
    await say(s, id, "hi");
    await settled(s, id);
    // Its qualified name while skills are wrapped in plugins (issue 08 makes them standalone).
    expect(stepPayloads(s, id)[0]).toMatch(
      /- (weekly-report\/)?weekly-report: Make the weekly report\. Use on Mondays\./,
    );
  });

  it("use_skill returns the instructions and the file list, records the version, and says there is no sandbox", async () => {
    const s = await start();
    const skillId = seed(s);
    const id = await chat(s);
    await say(s, id, tool("use_skill", { name: "weekly-report" }));
    await settled(s, id);
    const result = toolResults(s, id).at(-1)!;
    expect(result.isError).toBe(false);
    expect(result.text).toContain('Skill "weekly-report" (version 1)');
    expect(result.text).toContain("1. Collect.");
    expect(result.text).toContain("Files: SKILL.md, assets/p.bin, references/api.md");
    expect(result.text).toMatch(/no sandbox/);
    expect(
      s.host.plane.store.db.all<{ skill_id: string; version: number }>("SELECT skill_id, version FROM skill_uses"),
    ).toEqual([{ skill_id: skillId, version: 1 }]);
    await say(s, id, tool("use_skill", { name: "nope" }));
    await settled(s, id, 2);
    expect(toolResults(s, id).at(-1)).toMatchObject({ isError: true });
    expect(toolResults(s, id).at(-1)!.text).toContain("Available skills: rei-knowledge, weekly-report.");
  });

  it("use_skill copies the files into the sandbox, replacing an older copy", async () => {
    const x: ExecServer = await startExecServer();
    server = x;
    x.host.plane.skills.save({
      files: skill("weekly-report", [text("scripts/run.sh", "echo hi\n")]),
      author: "user",
      note: "Imported",
      log: false,
    });
    const id = await chat(x);
    await run(x, id, tool("use_skill", { name: "weekly-report" }));
    const dir = join(x.root, workspaceOf(x, id), ".skills", "weekly-report", id);
    expect(toolResults(x, id).at(-1)!.text).toContain(`.skills/weekly-report`);
    expect(readFileSync(join(dir, "scripts", "run.sh"), "utf8")).toBe("echo hi\n");
    expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
    const other = await chat(x);
    await run(x, other, tool("use_skill", { name: "weekly-report" }));
    // A new version drops the files it no longer has.
    x.host.plane.skills.save({
      files: skill("weekly-report", [text("references/b.md", "b")]),
      author: "user",
      note: "Imported",
      log: false,
    });
    await run(x, id, tool("use_skill", { name: "weekly-report" }));
    expect(existsSync(join(dir, "scripts", "run.sh"))).toBe(false);
    expect(readFileSync(join(dir, "references", "b.md"), "utf8")).toBe("b");
    expect(
      readFileSync(join(x.root, workspaceOf(x, id), ".skills", "weekly-report", other, "scripts", "run.sh"), "utf8"),
    ).toBe("echo hi\n");
  });

  it("read_skill_file reads a text file, refuses a binary or missing one, and cuts a long one", async () => {
    const s = await start();
    seed(s);
    const long = "y".repeat(40_050);
    store(s).save({
      files: skill("long-one", [text("references/big.md", long)]),
      author: "user",
      note: "Imported",
      log: false,
    });
    const id = await chat(s);
    const read = async (name: string, path: string, runs: number) => {
      await say(s, id, tool("read_skill_file", { name, path }));
      await settled(s, id, runs);
      return toolResults(s, id).at(-1)!;
    };
    expect((await read("weekly-report", "references/api.md", 1)).text).toBe("# API\nGET /x");
    const binary = await read("weekly-report", "assets/p.bin", 2);
    expect(binary.isError).toBe(true);
    expect(binary.text).toMatch(/binary file \(3 bytes\)/);
    const missing = await read("weekly-report", "nope.md", 3);
    expect(missing.text).toContain("Its files: SKILL.md, assets/p.bin, references/api.md");
    const cut = await read("long-one", "references/big.md", 4);
    expect(cut.text).toContain("… (cut at 40000 characters of 40050)");
    expect(cut.text.length).toBeLessThan(40_200);
  });

  it("read_skill_file defaults to the skill loaded last with use_skill, and says so when there is none", async () => {
    const s = await start();
    seed(s);
    const id = await chat(s);
    await say(s, id, tool("read_skill_file", { path: "references/api.md" }));
    await settled(s, id, 1);
    const none = toolResults(s, id).at(-1)!;
    expect(none.isError).toBe(true);
    expect(none.text).toContain("no skill has been loaded with use_skill");
    await say(s, id, tool("use_skill", { name: "weekly-report" }));
    await settled(s, id, 2);
    expect(toolResults(s, id).at(-1)!.text).toContain(
      'read_skill_file({ name: "weekly-report", path: "references/api.md" })',
    );
    await say(s, id, tool("read_skill_file", { path: "references/api.md" }));
    await settled(s, id, 3);
    expect(toolResults(s, id).at(-1)!.text).toBe("# API\nGET /x");
  });

  it("save_skill always asks, once only, with the SKILL.md on the card; approving saves version 1", async () => {
    const s = await start();
    const id = await chat(s);
    await say(
      s,
      id,
      tool("save_skill", {
        name: "meeting-notes",
        description: "Turn notes into minutes. Use after meetings.",
        body: "1. Read.\n2. Summarise.",
        files: [{ path: "references/t.md", content: "template" }],
      }),
    );
    const [a] = await waitPending(s, id, 1);
    expect(a).toMatchObject({
      tool: "save_skill",
      actionClass: "configure",
      connector: "skills",
      operation: "skill.save",
      lengths: ["once"],
    });
    expect(a!.preview).toMatchObject({
      kind: "skill",
      op: "create",
      name: "meeting-notes",
      description: "Turn notes into minutes. Use after meetings.",
      files: ["references/t.md"],
    });
    expect((a!.preview as { skillMd: string }).skillMd).toContain("name: meeting-notes");
    expect((a!.preview as { skillMd: string }).skillMd).toContain("1. Read.");
    expect(own(store(s).list())).toEqual([]);
    await approve(s, id);
    const [saved] = own(store(s).list());
    expect(saved).toMatchObject({ name: "meeting-notes", version: 1, author: "agent", fileCount: 2 });
    expect(
      s.host.plane.store.db.get<{ session_id: string; note: string }>("SELECT session_id, note FROM skill_versions"),
    ).toEqual({ session_id: id, note: "Saved from chat" });
    expect(assistantTexts((await s.client.get(`/api/sessions/${id}`)).body).at(-1)).toBeTruthy();
  });

  it("a new version of a skill shows a diff, keeps the other files and the optional fields, and 'no change' is said", async () => {
    const s = await start();
    store(s).save({
      files: [
        text("SKILL.md", md("meeting-notes", "Old description.", "Old body.", "license: MIT\n")),
        text("references/t.md", "template"),
      ],
      author: "user",
      note: "Imported",
      log: false,
    });
    const id = await chat(s);
    await say(s, id, tool("save_skill", { name: "meeting-notes", description: "New description.", body: "New body." }));
    const [a] = await waitPending(s, id, 1);
    const preview = a!.preview as { op: string; fromVersion: number; diff: string; files: string[]; skillMd: string };
    expect(preview).toMatchObject({ op: "update", fromVersion: 1, files: ["references/t.md"] });
    expect(preview.diff).toContain("--- v1");
    expect(preview.diff).toContain("-Old body.");
    expect(preview.diff).toContain("+New body.");
    expect(preview.skillMd).toContain("license: MIT");
    await approve(s, id);
    expect(own(store(s).list())[0]).toMatchObject({ version: 2, description: "New description.", fileCount: 2 });
    // The same call again changes nothing: the card still shows, and the result says so.
    await say(s, id, tool("save_skill", { name: "meeting-notes", description: "New description.", body: "New body." }));
    await approve(s, id);
    expect(own(store(s).list())[0]!.version).toBe(2);
    expect(toolResults(s, id).at(-1)!.text).toMatch(/nothing changed/);
  });

  it("an invalid skill is refused with the reason and no card", async () => {
    const s = await start();
    const id = await chat(s);
    const tries: [object, RegExp][] = [
      [{ name: "Bad Name", description: "d", body: "b" }, /Not done: .*not allowed/],
      [{ name: "ok", description: "", body: "b" }, /Not done: .*description/],
      [{ name: "ok", description: "d", body: "b", files: [{ path: "../x", content: "x" }] }, /Not done: .*path/],
      [
        { name: "ok", description: "d", body: "b", files: [{ path: "SKILL.md", content: "x" }] },
        /Not done: .*SKILL\.md is built/,
      ],
    ];
    let runs = 0;
    for (const [args, re] of tries) {
      await say(s, id, tool("save_skill", args));
      await settled(s, id, ++runs);
      expect(toolResults(s, id).at(-1)!.text).toMatch(re);
    }
    expect(await pending(s)).toEqual([]);
    expect(own(store(s).list())).toEqual([]);
  });

  it("a skill another agent owns can't be overwritten by this agent", async () => {
    const s = await start();
    const skillId = seed(s);
    s.host.plane.store.db.run(
      "INSERT INTO agents (id, name, avatar, default_profile, instructions, home_session_id, created_at) VALUES ('agt_two', 'Two', 'bot:cat', 'standard', '', NULL, ?)",
      Date.now(),
    );
    store(s).setAgents(skillId, ["agt_two"]);
    const id = await chat(s);
    await say(s, id, tool("save_skill", { name: "weekly-report", description: "Mine now.", body: "x" }));
    await settled(s, id);
    expect(toolResults(s, id).at(-1)!.text).toMatch(/already exists and is not available to this agent/);
    await say(s, id, tool("use_skill", { name: "weekly-report" }));
    await settled(s, id, 2);
    expect(toolResults(s, id).at(-1)).toMatchObject({ isError: true });
  });
});

describe("built-in knowledge skill source", () => {
  it("is embedded from its Markdown files: run `npm run build:skills -w @rei/server` after editing them", async () => {
    const { render } = await import("../scripts/build-knowledge-skill.ts");
    const generated = readFileSync(join(import.meta.dirname, "../src/skills/knowledge-files.generated.ts"), "utf8");
    expect(generated).toBe(render());
  });
});
