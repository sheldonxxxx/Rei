// The ChatGPT export converter and `./rei import chatgpt`, on small synthetic exports shaped like the real thing.
import { describe, expect, it } from "vitest";
import { IMPORT_FILE_MAX_BYTES, importCommand, parseImportArgs } from "../src/commands/import.ts";
import { CHATGPT_NOTICE, cleanText, convertConversation, type ExportFiles, FileIndex } from "../src/import/chatgpt.ts";
import { makeRig } from "./fakes.ts";

type Node = { id: string; parent?: string; role?: string; message?: Record<string, unknown> | null };

/** A chat's mapping from nodes; `message` fields default to a plain text message. */
function chat(id: string, nodes: Node[], current: string, extra: Record<string, unknown> = {}) {
  const mapping: Record<string, unknown> = {};
  for (const n of nodes)
    mapping[n.id] = {
      id: n.id,
      parent: n.parent ?? null,
      children: [],
      message: n.message === null ? null : { author: { role: n.role ?? "user" }, ...n.message },
    };
  return {
    conversation_id: id,
    title: `Chat ${id}`,
    create_time: 1_700_000_000.5,
    update_time: 1_700_100_000,
    current_node: current,
    is_archived: false,
    is_starred: false,
    mapping,
    ...extra,
  };
}
const text = (parts: unknown[], at: number, metadata: Record<string, unknown> = {}) => ({
  create_time: at,
  content: { content_type: "text", parts },
  metadata,
});
const noFiles: ExportFiles = { sizes: new Map(), names: {} };
const convert = (c: unknown, files: ExportFiles = noFiles) => convertConversation(c, files).transcript;

describe("ChatGPT export converter", () => {
  it("keeps the chat's current path and leaves abandoned branches out", () => {
    const c = chat(
      "c1",
      [
        { id: "root", message: null },
        { id: "u1", parent: "root", message: text(["First try"], 1_700_000_001) },
        { id: "a1", parent: "u1", role: "assistant", message: text(["Old answer"], 1_700_000_002) },
        { id: "u1b", parent: "root", message: text(["Edited question"], 1_700_000_003) },
        { id: "a1b", parent: "u1b", role: "assistant", message: text(["Kept answer"], 1_700_000_004) },
      ],
      "a1b",
    );
    const { transcript, offPath } = convertConversation(c, noFiles);
    expect(transcript).toMatchObject({
      source: "chatgpt",
      sourceId: "c1",
      title: "Chat c1",
      createdAt: 1_700_000_000_500,
      updatedAt: 1_700_100_000_000,
      notice: CHATGPT_NOTICE,
    });
    expect(transcript.turns).toEqual([
      { role: "user", at: 1_700_000_003_000, text: "Edited question" },
      { role: "assistant", at: 1_700_000_004_000, text: "Kept answer" },
    ]);
    expect(offPath).toBe(2);
  });

  it("merges a reply's thoughts and text into one turn, without the recap", () => {
    const c = chat(
      "c2",
      [
        { id: "u", message: text(["Why is the sky blue?"], 10) },
        {
          id: "t",
          parent: "u",
          role: "assistant",
          message: {
            create_time: 11,
            content: {
              content_type: "thoughts",
              thoughts: [
                { summary: "Recalling scattering", content: "Rayleigh scattering favours short wavelengths." },
                { summary: "", content: "Check the units." },
              ],
            },
            metadata: { model_slug: "model-a" },
          },
        },
        {
          id: "r",
          parent: "t",
          role: "assistant",
          message: { create_time: 12, content: { content_type: "reasoning_recap", content: "Thought for 3s" } },
        },
        {
          id: "a",
          parent: "r",
          role: "assistant",
          message: text(["Because of Rayleigh scattering."], 13, { model_slug: "model-b" }),
        },
      ],
      "a",
    );
    const turns = convert(c).turns;
    expect(turns).toHaveLength(2);
    expect(turns[1]).toEqual({
      role: "assistant",
      at: 11_000,
      model: "model-b",
      thinking: ["**Recalling scattering**\n\nRayleigh scattering favours short wavelengths.", "Check the units."],
      text: "Because of Rayleigh scattering.",
    });
  });

  it("turns citation markers into their links and drops image carousels and chip characters", () => {
    const refs = [
      { type: "grouped_webpages", matched_text: "citeturn0search1", alt: "([Example](https://example.org))" },
      { type: "image_v2", matched_text: "iturn0image0", alt: "![a](https://img.example/a.png)" },
      { type: "sources_footnote", matched_text: " ", alt: "" },
    ];
    expect(cleanText("Fact citeturn0search1.\niturn0image0 Done", refs)).toBe(
      "Fact ([Example](https://example.org)).\n Done",
    );
    const c = chat(
      "c3",
      [
        { id: "u", message: text(["Q"], 1) },
        {
          id: "a",
          parent: "u",
          role: "assistant",
          message: text(["Sea citeturn0search1 level"], 2, { content_references: [refs[0]] }),
        },
      ],
      "a",
    );
    expect(convert(c).turns[1]!.text).toBe("Sea ([Example](https://example.org)) level");
  });

  it("pairs markers with references in order when the export does not say which marker is whose", () => {
    const M = (...fields: string[]) => `\uE200${fields.join("\uE202")}\uE201`;
    const refs = [
      { type: "grouped_webpages", alt: "([One](https://one.example))" },
      { type: "hidden" },
      { type: "entity", alt: "Mount Fuji" },
      { type: "image_group", alt: "![x](https://img.example/x.png)" },
      { type: "sources_footnote", alt: "" },
    ];
    const marked = `A${M("cite", "turn0search1")} B${M("filecite", "turn1file0", "L1-L4")} ${M("entity", '["place","Mount Fuji"]')}.${M("image_group", "{}")}`;
    expect(cleanText(marked, refs)).toBe("A([One](https://one.example)) B Mount Fuji.");
    // When the counts disagree, a marker stands for what it carries itself.
    expect(
      cleanText(
        `See ${M("entity", '["place","Kyoto","city"]')} and ${M("url", "Docs", "https://docs.example")}${M("cite", "turn0view0")}.`,
        [refs[0]],
      ),
    ).toBe("See Kyoto and [Docs](https://docs.example).");
    expect(cleanText(`Bad ${M("entity", "{not json")}end`, [])).toBe("Bad end");
  });

  it("drops citation tags and old citations, and reads entity tags as their names", () => {
    expect(
      cleanText(
        'Tokyo is big.<Cite refs={["turn0search1","turn0search2"]} /> See <Entity category="city" value="Osaka" disambig="Japan"/> too <Cite ref="turn1view0"/>【3†source】.<AsyncImage ref="turn0image1"/>',
        [],
      ),
    ).toBe("Tokyo is big. See Osaka too .");
  });

  it("reads voice messages as their transcripts", () => {
    const voice = (role: string, transcript: string, at: number, parent?: string) => ({
      id: `${role}${at}`,
      ...(parent ? { parent } : {}),
      role,
      message: {
        create_time: at,
        content: {
          content_type: "multimodal_text",
          parts: [
            { content_type: "audio_transcription", text: transcript },
            { content_type: "audio_asset_pointer", asset_pointer: "sediment://x" },
          ],
        },
      },
    });
    const c = chat(
      "c4",
      [voice("user", "Hello there", 1), voice("assistant", "Hi, how are you?", 2, "user1")],
      "assistant2",
    );
    expect(convert(c).turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "Hello there"],
      ["assistant", "Hi, how are you?"],
    ]);
  });

  it("finds attachment files by id, names them, and marks the missing ones", () => {
    const files: ExportFiles = {
      sizes: new Map([
        ["file_0123456789abcdef0123456789abcdef.dat", 2048],
        ["file-AbCdEfGhIjKlMnOpQrStUv-notes.dat", 512],
      ]),
      names: { "file_0123456789abcdef0123456789abcdef.dat": "photo.png" },
    };
    const c = chat(
      "c5",
      [
        {
          id: "u",
          message: text(["See these"], 1, {
            attachments: [
              { id: "file_0123456789abcdef0123456789abcdef", mime_type: "image/png", size: 2048 },
              { id: "file-AbCdEfGhIjKlMnOpQrStUv", name: "notes.txt", mime_type: "text/plain" },
              { id: "file-Missing00000000000000", name: "gone.pdf", mime_type: "application/pdf" },
            ],
          }),
        },
      ],
      "u",
    );
    expect(convert(c, files).turns[0]!.attachments).toEqual([
      { name: "photo.png", mediaType: "image/png", size: 2048, file: "file_0123456789abcdef0123456789abcdef.dat" },
      { name: "notes.txt", mediaType: "text/plain", size: 512, file: "file-AbCdEfGhIjKlMnOpQrStUv-notes.dat" },
      { name: "gone.pdf", mediaType: "application/pdf", size: 0 },
    ]);
    expect(new FileIndex(files).find("file_0123")).toBe("file_0123456789abcdef0123456789abcdef.dat");
    expect(new FileIndex(files).find("")).toBeUndefined();
  });

  it("drops hidden and empty messages and other roles, and keeps star, archive and a default title", () => {
    const c = chat(
      "c6",
      [
        { id: "s", role: "system", message: text([""], 1) },
        {
          id: "h",
          parent: "s",
          message: text(["custom instructions"], 2, { is_visually_hidden_from_conversation: true }),
        },
        { id: "u", parent: "h", message: text(["Real question"], 3) },
        { id: "tool", parent: "u", role: "tool", message: text(["tool output"], 4) },
        { id: "a", parent: "tool", role: "assistant", message: text([""], 5) },
      ],
      "a",
      { title: "", is_starred: true, is_archived: true },
    );
    const t = convert(c);
    expect(t).toMatchObject({ title: "Untitled", starred: true, archived: true });
    expect(t.turns).toEqual([{ role: "user", at: 3000, text: "Real question" }]);
  });
});

// ---- the command ----------------------------------------------------------------------------------------------------

const EXPORT = "/exports/chatgpt";
const SERVER = "http://rei.test:9999";

interface Call {
  method: string;
  path: string;
  auth: string | null;
  length: string | null;
  body: unknown;
}

/** A Rei that answers the import API; `present` source ids are already imported. */
function fakeRei(o: { present?: string[]; failOn?: string; totp?: boolean } = {}) {
  const calls: Call[] = [];
  let uploads = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (init?.body instanceof ReadableStream) {
      const form = await new Response(init.body, {
        headers: { "content-type": headers.get("content-type") ?? "" },
      }).formData();
      const file = form.get("file") as File;
      body = { file: file.name, type: file.type, text: await file.text() };
    } else if (typeof init?.body === "string") body = JSON.parse(init.body);
    calls.push({
      method,
      path: url.pathname,
      auth: headers.get("authorization"),
      length: headers.get("content-length"),
      body,
    });
    if (headers.get("x-rei-client") !== "cli/1")
      return Response.json({ error: { code: "no_client" } }, { status: 400 });
    switch (`${method} ${url.pathname}`) {
      case "GET /api/auth/state":
        return Response.json({ setupRequired: false, signedIn: false, totpEnabled: o.totp ?? false });
      case "POST /api/auth/login":
        return Response.json({ ok: true, deviceId: "dev1", token: "tok-from-login" });
      case "POST /api/auth/logout":
        return Response.json({ ok: true });
      case "GET /api/agents":
        return Response.json({
          agents: [
            { id: "agt_1", name: "Rei" },
            { id: "agt_2", name: "Archivist" },
          ],
          defaultAgentId: "agt_1",
        });
      case "POST /api/imports/lookup": {
        const ids = (body as { sourceIds: string[] }).sourceIds;
        return Response.json({
          found: ids.filter((id) => o.present?.includes(id)).map((id) => ({ sourceId: id, sessionId: `ses_${id}` })),
        });
      }
      case "POST /api/imports/files":
        uploads++;
        return Response.json({ attachment: { id: `att_${uploads}`, name: "x", mediaType: "text/plain", size: 1 } });
      case "POST /api/imports/sessions": {
        const t = (body as { transcript: { sourceId: string; title: string } }).transcript;
        if (t.sourceId === o.failOn)
          return Response.json({ error: { code: "bad", message: "Nope." } }, { status: 400 });
        return Response.json({ session: { id: `ses_${t.sourceId}`, title: t.title }, created: true });
      }
      default:
        return new Response("not found", { status: 404 });
    }
  }) as typeof fetch;
  return { calls, fetchFn };
}

/** A rig with an export of three chats over two files, and a fake Rei. */
function rigWithExport(o: Parameters<typeof fakeRei>[0] & { answers?: string[] | null } = {}) {
  const rig = makeRig({ answers: o.answers === undefined ? null : o.answers });
  const rei = fakeRei(o);
  (rig.ctx as { fetch: typeof fetch }).fetch = rei.fetchFn;
  const put = (name: string, text: string) => rig.host.files.set(`${EXPORT}/${name}`, { text, mode: 0o644 });
  const qa = (id: string, q: string, a: string, attachments: unknown[] = []) =>
    chat(
      id,
      [
        { id: "u", message: text([q], 1_700_000_001, attachments.length ? { attachments } : {}) },
        { id: "a", parent: "u", role: "assistant", message: text([a], 1_700_000_002) },
      ],
      "a",
    );
  put(
    "conversations-000.json",
    JSON.stringify([
      qa("c1", "One?", "Yes, one.", [
        { id: "file_aaa", name: "a.txt", mime_type: "text/plain" },
        { id: "file_gone", name: "gone.png", mime_type: "image/png" },
      ]),
      qa("c2", "Two?", "Yes, two."),
    ]),
  );
  put("conversations-001.json", JSON.stringify([qa("c3", "Three?", "Yes, three."), chat("empty", [], "x")]));
  put("file_aaa.dat", "hello");
  put("conversation_asset_file_names.json", JSON.stringify({ "file_aaa.dat": "a.txt" }));
  return { ...rig, rei };
}
const run = (rig: ReturnType<typeof rigWithExport>, ...args: string[]) =>
  importCommand(rig.ctx, ["chatgpt", EXPORT, "--server", SERVER, ...args]);

describe("rei import chatgpt", () => {
  it("parses its options", () => {
    expect(parseImportArgs(["chatgpt", "/x", "--agent=a", "--only", "c1, c2", "--limit", "3", "--dry-run"])).toEqual({
      source: "chatgpt",
      dir: "/x",
      agent: "a",
      only: new Set(["c1", "c2"]),
      limit: 3,
      dryRun: true,
    });
    expect(parseImportArgs(["claude", "/x"])).toContain("chatgpt");
    expect(parseImportArgs(["chatgpt"])).toContain("folder");
    expect(parseImportArgs(["chatgpt", "/x", "--limit", "0"])).toContain("--limit");
    expect(parseImportArgs(["chatgpt", "/x", "--agent"])).toContain("needs a value");
    expect(parseImportArgs(["chatgpt", "/x", "--bogus"])).toContain("Unknown option");
  });

  it("imports each chat with its files, one at a time, and sums up", async () => {
    const rig = rigWithExport();
    expect(await run(rig, "--agent", "agt_2", "--token", "tok")).toBe(0);
    const sessions = rig.rei.calls.filter((c) => c.path === "/api/imports/sessions");
    expect(sessions.map((c) => (c.body as { transcript: { sourceId: string } }).transcript.sourceId)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    expect(rig.rei.calls.every((c) => c.auth === "Bearer tok")).toBe(true);
    const first = sessions[0]!.body as { agentId: string; transcript: { turns: { attachments?: unknown[] }[] } };
    expect(first.agentId).toBe("agt_2");
    expect(first.transcript.turns[0]!.attachments).toEqual([
      { name: "a.txt", mediaType: "text/plain", size: 5, attachmentId: "att_1" },
      { name: "gone.png", mediaType: "image/png", size: 0, unavailable: "Not in export" },
    ]);
    expect(rig.rei.calls.find((c) => c.path === "/api/imports/files")!.body).toEqual({
      file: "a.txt",
      type: "text/plain",
      text: "hello",
    });
    expect(rig.out.text).toContain("Importing into Archivist");
    expect(rig.out.text).toContain('imported "Chat c1" (2 turns)');
    expect(rig.out.text).toContain("Imported 3 chat(s) (6 turns). Already there: 0. Failed: 0. Empty, skipped: 1.");
    expect(rig.out.text).toContain("Files not carried: 1 not in the export, 0 over 1 GiB, 0 failed to upload.");
    // A token you passed is yours: it is not signed out.
    expect(rig.rei.calls.some((c) => c.path === "/api/auth/logout")).toBe(false);
  });

  it("skips chats already imported, honours --only and --limit, and reports failures", async () => {
    const rig = rigWithExport({ present: ["c1"], failOn: "c3" });
    expect(await run(rig, "--agent", "agt_1", "--token", "tok", "--only", "c1,c3")).toBe(1);
    const sent = rig.rei.calls.filter((c) => c.path === "/api/imports/sessions");
    expect(sent.map((c) => (c.body as { transcript: { sourceId: string } }).transcript.sourceId)).toEqual(["c3"]);
    expect(rig.rei.calls.some((c) => c.path === "/api/imports/files")).toBe(false);
    expect(rig.out.text).toContain('failed "Chat c3" (2 turns): Nope.');
    expect(rig.out.text).toContain("Imported 0 chat(s) (2 turns). Already there: 1. Failed: 1.");

    const limited = rigWithExport();
    expect(await run(limited, "--agent", "agt_1", "--token", "tok", "--limit", "2")).toBe(0);
    expect(limited.rei.calls.filter((c) => c.path === "/api/imports/sessions")).toHaveLength(2);
  });

  it("signs in with your password for the run and signs that device out after", async () => {
    const rig = rigWithExport({ answers: ["correct horse battery", "123456"], totp: true });
    expect(await run(rig, "--agent", "agt_1", "--only", "c2")).toBe(0);
    expect(rig.prompter.asked).toEqual(["Rei password: ", "Authenticator code: "]);
    expect(rig.rei.calls.find((c) => c.path === "/api/auth/login")!.body).toEqual({
      password: "correct horse battery",
      totpCode: "123456",
      deviceLabel: "rei import",
    });
    expect(rig.rei.calls.at(-1)).toMatchObject({ path: "/api/auth/logout", auth: "Bearer tok-from-login" });
  });

  it("needs a token without a terminal, and lists the agents when none is named", async () => {
    const rig = rigWithExport();
    expect(await run(rig, "--agent", "agt_1")).toBe(1);
    expect(rig.out.text).toContain("Pass --token");
    const listing = rigWithExport();
    expect(await run(listing, "--token", "tok")).toBe(2);
    expect(listing.out.text).toContain("agt_1  Rei (default)");
    expect(listing.out.text).toContain("agt_2  Archivist");
  });

  it("carries a file over the old 25 MiB limit as a streamed upload, and names one over 1 GiB", async () => {
    const rig = rigWithExport();
    const big = 30 * 1024 * 1024;
    rig.host.sized.set(`${EXPORT}/file_aaa.dat`, big);
    expect(await run(rig, "--agent", "agt_1", "--token", "tok", "--only", "c1")).toBe(0);
    const upload = rig.rei.calls.find((c) => c.path === "/api/imports/files")!;
    expect((upload.body as { text: string }).text).toHaveLength(big);
    // A known length: the request is not chunked, so a proxy can check it against its body limit up front.
    expect(Number(upload.length)).toBeGreaterThan(big);

    const huge = rigWithExport();
    huge.host.sized.set(`${EXPORT}/file_aaa.dat`, 1024 * 1024 * 1024 + 1);
    expect(await run(huge, "--agent", "agt_1", "--token", "tok", "--only", "c1")).toBe(0);
    expect(huge.rei.calls.some((c) => c.path === "/api/imports/files")).toBe(false);
    const sent = huge.rei.calls.find((c) => c.path === "/api/imports/sessions")!.body as {
      transcript: { turns: { attachments?: { unavailable?: string }[] }[] };
    };
    expect(sent.transcript.turns[0]!.attachments![0]!.unavailable).toBe("Too large to import");
    expect(huge.out.text).toContain("1 over 1 GiB");
  });

  it("a dry run converts everything and sends nothing", async () => {
    const rig = rigWithExport();
    rig.host.files.set(`${EXPORT}/file_big.dat`, { text: "x".repeat(10), mode: 0o644 });
    expect(await run(rig, "--dry-run")).toBe(0);
    expect(rig.rei.calls).toEqual([]);
    expect(rig.out.text).toContain("Would import 3 chat(s) (6 turns).");
    expect(IMPORT_FILE_MAX_BYTES).toBe(1024 * 1024 * 1024);
  });

  it("says what is wrong with the folder", async () => {
    const rig = rigWithExport();
    expect(await importCommand(rig.ctx, ["chatgpt", "/nowhere", "--dry-run"])).toBe(1);
    expect(rig.out.text).toContain("There is no folder at /nowhere.");
    rig.host.files.set("/other/readme.txt", { text: "hi", mode: 0o644 });
    expect(await importCommand(rig.ctx, ["chatgpt", "/other", "--dry-run"])).toBe(1);
    expect(rig.out.text).toContain("is it an unzipped ChatGPT export?");
    expect(await importCommand(rig.ctx, ["chatgpt"])).toBe(2);
  });

  it("stops when Rei does not answer", async () => {
    const rig = rigWithExport();
    (rig.ctx as { fetch: typeof fetch }).fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await run(rig, "--agent", "agt_1", "--token", "tok")).toBe(1);
    expect(rig.out.text).toContain(`Rei did not answer at ${SERVER}.`);
  });
});
