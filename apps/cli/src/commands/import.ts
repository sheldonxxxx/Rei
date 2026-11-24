// `./rei import chatgpt <export-dir> --agent <id>`: brings past ChatGPT chats into Rei, one chat at a time, through the
// app's import API (docs/importing.md). It reads the unzipped export where it runs and talks to Rei over HTTP, so it can
// import into a Rei on another machine. Nothing runs a model; a chat imported before is skipped.

import { join } from "node:path";
import type {
  AgentsResponse,
  Attachment,
  AuthStateResponse,
  ImportAttachment,
  ImportLookupResponse,
  ImportSessionResponse,
  ImportTranscript,
} from "@rei/protocol";
import { appUrls, type Ctx } from "../ctx.ts";
import { convertConversation, type ExportFiles, FileIndex, type LocalTranscript } from "../import/chatgpt.ts";

/** Rei's limit for one file (ATTACHMENT_MAX_BYTES, 1 GiB); a larger one is named in the chat but not carried. */
export const IMPORT_FILE_MAX_BYTES = 1024 * 1024 * 1024;
const LOOKUP_BATCH = 1000;
const CLIENT = "cli/1";

export const IMPORT_HELP = `./rei import chatgpt <export-dir> --agent <agent-id> [options]

Import past ChatGPT chats from an unzipped data export into one agent's chats. Each chat keeps its title, dates and
star (pinned); questions and answers become searchable. No model runs. A chat imported before is skipped, so you can
run it again after a failure.

  --agent <id>     The agent the chats belong to (run without it to list the agents)
  --server <url>   Where Rei answers (default: this machine's Rei, from REI_PUBLISH)
  --token <token>  A device token to use (or set REI_TOKEN); without one you are asked for your password
  --only <ids>     Only these chats: conversation ids, comma separated
  --limit <n>      At most this many chats
  --dry-run        Read and convert the export, send nothing

See docs/importing.md.`;

interface Options {
  source: string;
  dir: string;
  agent?: string;
  server?: string;
  token?: string;
  only?: Set<string>;
  limit?: number;
  dryRun: boolean;
}

const VALUE_FLAGS = new Set(["--agent", "--server", "--token", "--only", "--limit"]);

/** Parses the command line; a string is the usage error to show. */
export function parseImportArgs(args: string[]): Options | string {
  const positional: string[] = [];
  const values = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 && name !== arg ? arg.slice(eq + 1) : args[++i];
      if (value === undefined || value === "") return `${name} needs a value.`;
      values.set(name, value);
    } else if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("-")) return `Unknown option ${arg}.`;
    else positional.push(arg);
  }
  const [source, dir, ...extra] = positional;
  if (source !== "chatgpt")
    return source ? `Rei can import from chatgpt, not "${source}".` : "Name the source: chatgpt.";
  if (!dir) return "Name the folder of the unzipped export.";
  if (extra.length) return `Unexpected ${extra.join(" ")}.`;
  const limit = values.get("--limit");
  if (limit !== undefined && !/^[1-9][0-9]*$/.test(limit)) return "--limit must be a positive whole number.";
  const only = values.get("--only");
  const agent = values.get("--agent");
  const server = values.get("--server");
  const token = values.get("--token");
  return {
    source,
    dir,
    dryRun,
    ...(agent ? { agent } : {}),
    ...(server ? { server: server.replace(/\/+$/, "") } : {}),
    ...(token ? { token } : {}),
    ...(only
      ? {
          only: new Set(
            only
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        }
      : {}),
    ...(limit ? { limit: Number(limit) } : {}),
  };
}

class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A file to send as the one `file` field of a multipart request. */
class Upload {
  readonly blob: Blob;
  readonly name: string;
  constructor(blob: Blob, name: string) {
    this.blob = blob;
    this.name = name;
  }
}

/** The app's HTTP API, as a native client with a device token. */
class Api {
  readonly #ctx: Ctx;
  readonly #base: string;
  token: string | undefined;
  constructor(ctx: Ctx, base: string, token?: string) {
    this.#ctx = ctx;
    this.#base = base;
    this.token = token;
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let headers: Record<string, string> = { "x-rei-client": CLIENT };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let payload: BodyInit | undefined;
    let streamed = false;
    if (body instanceof Upload) {
      const upload = multipartUpload(body.blob, body.name);
      headers = { ...headers, ...upload.headers };
      payload = upload.body;
      streamed = true;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.#ctx.fetch(`${this.#base}${path}`, {
        method,
        headers,
        ...(payload ? { body: payload } : {}),
        ...(streamed ? { duplex: "half" } : {}),
      } as RequestInit);
    } catch {
      throw new ApiError(0, "unreachable", `Rei did not answer at ${this.#base}.`);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const error = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new ApiError(res.status, error?.code ?? "http_error", error?.message ?? `HTTP ${res.status}`);
    }
    return json as T;
  }
}

/**
 * One file as a `multipart/form-data` body that reads it as it is sent. A FormData with a file-backed Blob would be
 * simpler, but fetch reads that ahead of the socket (a 400 MB file costs about as much memory), while a stream it pulls
 * from holds a chunk at a time. The length is known, so the request is not chunked.
 */
export function multipartUpload(
  blob: Blob,
  name: string,
): { body: ReadableStream<Uint8Array>; headers: Record<string, string> } {
  const boundary = `----rei-import-${crypto.randomUUID()}`;
  // As browsers write it: quotes and line breaks escaped, everything else as UTF-8.
  const filename = name.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(blob.type) ? blob.type : "application/octet-stream";
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  async function* parts(): AsyncGenerator<Uint8Array> {
    yield head;
    for await (const chunk of blob.stream()) yield chunk;
    yield tail;
  }
  const source = parts();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await source.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel() {
        await source.return(undefined);
      },
    },
    { highWaterMark: 0 },
  );
  return {
    body,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(head.byteLength + blob.size + tail.byteLength),
    },
  };
}

/** The export's files: the chat files in order, the `.dat` files with their sizes, and the names it lists for them. */
function readExport(ctx: Ctx, dir: string): { chatFiles: string[]; files: ExportFiles } | string {
  const names = ctx.host.list(dir);
  if (!names) return `There is no folder at ${dir}.`;
  const chatFiles = names.filter((n) => /^conversations(-\d+)?\.json$/.test(n)).sort();
  if (chatFiles.length === 0) return `${dir} has no conversations-*.json: is it an unzipped ChatGPT export?`;
  const sizes = new Map<string, number>();
  for (const n of names) if (n.endsWith(".dat")) sizes.set(n, ctx.host.stat(join(dir, n))?.size ?? 0);
  let assetNames: Record<string, string> = {};
  const listed = ctx.host.readText(join(dir, "conversation_asset_file_names.json"));
  if (listed) {
    try {
      const parsed = JSON.parse(listed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) assetNames = parsed as Record<string, string>;
    } catch {
      // Without it, files keep the names the chats give them.
    }
  }
  return { chatFiles, files: { sizes, names: assetNames } };
}

async function signIn(ctx: Ctx, api: Api): Promise<boolean> {
  const state = await api.call<AuthStateResponse>("GET", "/api/auth/state");
  if (state.setupRequired) {
    ctx.out.line("Rei has no account yet. Create it in the web app first.");
    return false;
  }
  if (!ctx.prompter.interactive) {
    ctx.out.line("Pass --token (or set REI_TOKEN) to import without a terminal.");
    return false;
  }
  const password = await ctx.prompter.askHidden("Rei password: ");
  const totpCode = state.totpEnabled ? (await ctx.prompter.ask("Authenticator code: ")).trim() : undefined;
  const signed = await api.call<{ token?: string }>("POST", "/api/auth/login", {
    password,
    ...(totpCode ? { totpCode } : {}),
    deviceLabel: "rei import",
  });
  if (!signed.token) throw new ApiError(500, "no_token", "Rei did not give this client a device token.");
  api.token = signed.token;
  return true;
}

interface Tally {
  imported: number;
  present: number;
  failed: number;
  empty: number;
  missingFiles: number;
  largeFiles: number;
  uploadFailed: number;
  turns: number;
}

/** Uploads a chat's files and answers the transcript Rei takes: uploaded files by id, the others named with why. */
async function withFiles(
  ctx: Ctx,
  api: Api | undefined,
  dir: string,
  local: LocalTranscript,
  tally: Tally,
): Promise<ImportTranscript> {
  const turns: ImportTranscript["turns"] = [];
  for (const turn of local.turns) {
    if (!turn.attachments) {
      turns.push(turn as ImportTranscript["turns"][number]);
      continue;
    }
    const attachments: ImportAttachment[] = [];
    for (const file of turn.attachments) {
      const named = { name: file.name, mediaType: file.mediaType, size: file.size };
      if (!file.file) {
        tally.missingFiles++;
        attachments.push({ ...named, unavailable: "Not in export" });
      } else if (file.size > IMPORT_FILE_MAX_BYTES) {
        tally.largeFiles++;
        attachments.push({ ...named, unavailable: "Too large to import" });
      } else if (!api) attachments.push(named);
      else {
        // A file-backed Blob, streamed from disk as the request is sent: a large file is never held whole.
        const blob = await ctx.host.openFile(join(dir, file.file), file.mediaType);
        try {
          if (!blob) throw new ApiError(0, "unreadable", "unreadable");
          const up = await api.call<{ attachment: Attachment }>(
            "POST",
            "/api/imports/files",
            new Upload(blob, file.name),
          );
          attachments.push({ ...named, attachmentId: up.attachment.id });
        } catch (error) {
          if (error instanceof ApiError && error.code === "unreachable") throw error;
          tally.uploadFailed++;
          attachments.push({ ...named, unavailable: "Could not be uploaded" });
        }
      }
    }
    turns.push({ ...turn, attachments });
  }
  return { ...local, turns };
}

export async function importCommand(ctx: Ctx, args: string[]): Promise<number> {
  const parsed = parseImportArgs(args);
  if (typeof parsed === "string") {
    ctx.out.line(`rei import: ${parsed}\n\n${IMPORT_HELP}`);
    return 2;
  }
  const o = parsed;
  const read = readExport(ctx, o.dir);
  if (typeof read === "string") {
    ctx.out.line(read);
    return 1;
  }
  const base = o.server ?? appUrls(ctx).fetchBase;
  const token = o.token ?? ctx.env.REI_TOKEN;
  const api = o.dryRun ? undefined : new Api(ctx, base, token || undefined);
  let signedIn = false;
  const tally: Tally = {
    imported: 0,
    present: 0,
    failed: 0,
    empty: 0,
    missingFiles: 0,
    largeFiles: 0,
    uploadFailed: 0,
    turns: 0,
  };
  try {
    if (api) {
      if (!api.token) {
        if (!(await signIn(ctx, api))) return 1;
        signedIn = true;
      }
      const agents = await api.call<AgentsResponse>("GET", "/api/agents");
      const agent = agents.agents.find((a) => a.id === o.agent);
      if (!agent) {
        ctx.out.line(o.agent ? `There is no agent ${o.agent}. The agents are:` : "Choose an agent with --agent:");
        for (const a of agents.agents)
          ctx.out.line(`  ${a.id}  ${a.name}${a.id === agents.defaultAgentId ? " (default)" : ""}`);
        return 2;
      }
      ctx.out.line(`Importing into ${agent.name} at ${base}.`);
    } else ctx.out.line("Dry run: nothing is sent.");

    const index = new FileIndex(read.files);
    let considered = 0;
    let done = false;
    for (const chatFile of read.chatFiles) {
      if (done) break;
      // One file at a time (each is tens of MB), so the whole export is never in memory at once.
      let chats: unknown[];
      try {
        const parsedFile = JSON.parse(ctx.host.readText(join(o.dir, chatFile)) ?? "[]") as unknown;
        chats = Array.isArray(parsedFile) ? parsedFile : [];
      } catch {
        ctx.out.line(`${chatFile} is not valid JSON; skipped.`);
        continue;
      }
      const idOf = (c: unknown) => {
        const r = (c ?? {}) as { conversation_id?: unknown; id?: unknown };
        return typeof r.conversation_id === "string" ? r.conversation_id : typeof r.id === "string" ? r.id : "";
      };
      let picked = o.only ? chats.filter((c) => o.only!.has(idOf(c))) : chats;
      if (o.limit !== undefined) picked = picked.slice(0, Math.max(0, o.limit - considered));
      considered += picked.length;
      if (o.limit !== undefined && considered >= o.limit) done = true;
      const present = new Set<string>();
      if (api)
        for (let i = 0; i < picked.length; i += LOOKUP_BATCH) {
          const ids = picked
            .slice(i, i + LOOKUP_BATCH)
            .map(idOf)
            .filter(Boolean);
          const found = await api.call<ImportLookupResponse>("POST", "/api/imports/lookup", {
            source: "chatgpt",
            sourceIds: ids,
          });
          for (const f of found.found) present.add(f.sourceId);
        }
      for (const chat of picked) {
        const id = idOf(chat);
        if (present.has(id)) {
          tally.present++;
          continue;
        }
        const { transcript } = convertConversation(chat, read.files, index);
        if (transcript.sourceId === "" || transcript.turns.length === 0) {
          tally.empty++;
          continue;
        }
        const ready = await withFiles(ctx, api, o.dir, transcript, tally);
        tally.turns += ready.turns.length;
        const label = `"${ready.title}" (${ready.turns.length} turns)`;
        if (!api) {
          tally.imported++;
          ctx.out.line(`  would import ${label}`);
          continue;
        }
        try {
          const res = await api.call<ImportSessionResponse>("POST", "/api/imports/sessions", {
            agentId: o.agent,
            transcript: ready,
          });
          if (res.created) tally.imported++;
          else tally.present++;
          ctx.out.line(`  ${res.created ? "imported" : "already there"} ${label}`);
        } catch (error) {
          if (error instanceof ApiError && error.code === "unreachable") throw error;
          tally.failed++;
          ctx.out.line(`  failed ${label}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    ctx.out.line("");
    ctx.out.line(
      `${o.dryRun ? "Would import" : "Imported"} ${tally.imported} chat(s) (${tally.turns} turns). Already there: ${tally.present}. Failed: ${tally.failed}. Empty, skipped: ${tally.empty}.`,
    );
    ctx.out.line(
      `Files not carried: ${tally.missingFiles} not in the export, ${tally.largeFiles} over 1 GiB${o.dryRun ? "" : `, ${tally.uploadFailed} failed to upload`}.`,
    );
    return tally.failed > 0 ? 1 : 0;
  } catch (error) {
    ctx.out.line(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    // A password sign-in made a device for this run only.
    if (api && signedIn) await api.call("POST", "/api/auth/logout").catch(() => undefined);
  }
}
