// A ChatGPT data export, read as Rei's neutral import transcript (docs/importing.md). Only the kept path of each chat is
// read (from `current_node` up through the parents), so abandoned branches (an edited question, a regenerated answer)
// stay out. Pure: the caller reads the files and hands over the parsed JSON and the list of the export's files.

import type { ImportTranscript, ImportTurn } from "@rei/protocol";

export const CHATGPT_NOTICE =
  "Imported from ChatGPT. Tool output (canvas, code runs, generated images, web results) was not part of the export, so it is not shown.";

/** Rei's limit for one turn's text; a longer one is cut (rare: a very long paste). */
const TURN_MAX_CHARS = 1_000_000;
const THINKING_MAX_BLOCKS = 1000;
const TITLE_MAX_CHARS = 500;
/** Private-use characters ChatGPT leaves where it drew citation chips and other widgets. */
const PRIVATE_USE = /[\uE000-\uF8FF]/g;
/** A widget marker in a reply's text: `\uE200<kind>\uE202<field>...\uE201`, for example a citation of search results. */
const MARKER = /\uE200([^\uE200\uE201]*)\uE201/g;
const FIELD = "\uE202";
/** Citation tags some replies carry instead (`<Cite refs={[...]} />`): they point at search results the export lacks. */
const CITE_TAG = /<(?:Cite|FileCite|AsyncImage)\b[^<>]*\/>/g;
/** An inline entity tag (`<Entity category="..." value="Name" />`): it reads as its name. */
const ENTITY_TAG = /<Entity\b[^<>]*\/>/g;
/** The oldest citation form, `\u301012\u2020source\u3011`. */
const OLD_CITATION = /\u3010[^\u3010\u3011\n]{0,80}\u2020[^\u3010\u3011\n]{0,80}\u3011/g;

/** A file of a user turn: the export file that holds its bytes, when there is one. */
export interface LocalAttachment {
  name: string;
  mediaType: string;
  /** Bytes of the export file (0 when it is missing). */
  size: number;
  /** The export file's name (`<id>.dat`); absent when the export does not have it. */
  file?: string;
}

export type LocalTurn = Omit<ImportTurn, "attachments"> & { attachments?: LocalAttachment[] };
export type LocalTranscript = Omit<ImportTranscript, "turns"> & { turns: LocalTurn[] };

/** What the export holds besides the chats: its files with their sizes, and the original names it lists for them. */
export interface ExportFiles {
  /** `.dat` file name to its size in bytes. */
  sizes: ReadonlyMap<string, number>;
  /** `conversation_asset_file_names.json`: `.dat` file name to the name the file had. */
  names: Readonly<Record<string, string>>;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const seconds = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v * 1000) : undefined;
const cut = (text: string, max = TURN_MAX_CHARS): string =>
  text.length <= max ? text : `${text.slice(0, max - 20)}\n\n*(cut on import)*`;

/** Finds export files by attachment id: `<id>.dat` exactly, else the one file whose name starts with the id. */
export class FileIndex {
  readonly #byKey = new Map<string, string>();
  readonly #names: string[];

  constructor(files: ExportFiles) {
    this.#names = [...files.sizes.keys()].filter((f) => f.endsWith(".dat")).sort();
    for (const name of this.#names) {
      const stem = name.slice(0, -4);
      this.#byKey.set(stem, name);
      // `file-<22 characters>-<original name>.dat`: the id is the first two parts.
      const parts = stem.split("-");
      if (parts[0] === "file" && parts[1]) this.#byKey.set(`file-${parts[1].slice(0, 22)}`, name);
    }
  }

  find(id: string): string | undefined {
    if (id === "") return undefined;
    return this.#byKey.get(id) ?? this.#names.find((name) => name.startsWith(id));
  }
}

/** A reference's plain form: a citation's links or an entity's name; images and hidden references leave nothing. */
function plainOf(ref: Json): string {
  const alt = str(ref.alt) ?? "";
  return ref.type === "image_v2" || ref.type === "hidden" || alt.startsWith("![") ? "" : alt;
}

/** What a marker without a reference to pair with stands for: an entity's name or a link; anything else, nothing. */
function markerFallback(marker: string): string {
  const [kind, first, second] = marker.split(FIELD);
  if (kind === "entity" && first) {
    try {
      const parts = JSON.parse(first) as unknown;
      if (Array.isArray(parts)) return String(parts[1] ?? parts[0] ?? "");
    } catch {
      return "";
    }
  }
  if (kind === "url" && first) return second?.startsWith("http") ? `[${first}](${second})` : first;
  return "";
}

/**
 * Applies a message's content references. Older exports give each reference the marker it replaces (`matched_text`).
 * Newer ones do not: their markers come in the order of the references (a sources footnote has no marker), so when the
 * counts agree each marker takes its reference's plain form, and otherwise a marker falls back to what it carries
 * itself. Image carousels are dropped, and the private-use characters go.
 */
export function cleanText(text: string, references: unknown): string {
  const refs = list(references).map(obj);
  const matched = refs
    .filter((r) => typeof r.matched_text === "string" && r.matched_text.trim() !== "")
    .sort((a, b) => (b.matched_text as string).length - (a.matched_text as string).length);
  for (const ref of matched) {
    const marker = ref.matched_text as string;
    if (text.includes(marker)) text = text.split(marker).join(plainOf(ref));
  }
  const inOrder = refs.filter((r) => r.matched_text === undefined && r.type !== "sources_footnote");
  const markers = text.match(MARKER)?.length ?? 0;
  let next = 0;
  text = text.replace(MARKER, (_whole, marker: string) => {
    const ref = markers === inOrder.length ? inOrder[next++] : undefined;
    return ref ? plainOf(ref) : markerFallback(marker);
  });
  return text
    .replace(CITE_TAG, "")
    .replace(ENTITY_TAG, (tag) => /\bvalue="([^"]*)"/.exec(tag)?.[1] ?? "")
    .replace(OLD_CITATION, "")
    .replace(PRIVATE_USE, "")
    .trim();
}

/** The text of a message's parts: its strings and the transcripts of voice parts. */
function partsText(content: Json): string[] {
  const out: string[] = [];
  for (const part of list(content.parts)) {
    if (typeof part === "string") out.push(part);
    else if (obj(part).content_type === "audio_transcription") out.push(str(obj(part).text) ?? "");
  }
  return out;
}

/** The ids of the messages on the chat's kept path, oldest first. */
function keptPath(mapping: Json, current: string | undefined): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  for (let id = current; id !== undefined && id in mapping && !seen.has(id); id = str(obj(mapping[id]).parent)) {
    seen.add(id);
    path.push(id);
  }
  return path.reverse();
}

export interface Converted {
  transcript: LocalTranscript;
  /** Messages off the kept path (abandoned branches), left out. */
  offPath: number;
}

/** One chat of `conversations-NNN.json` as an import transcript. */
export function convertConversation(raw: unknown, files: ExportFiles, index = new FileIndex(files)): Converted {
  const c = obj(raw);
  const mapping = obj(c.mapping);
  const path = keptPath(mapping, str(c.current_node));
  const createdAt = seconds(c.create_time) ?? 0;
  const turns: LocalTurn[] = [];
  let lastAt = createdAt;
  for (const id of path) {
    const message = obj(obj(mapping[id]).message);
    if (Object.keys(message).length === 0) continue;
    const role = obj(message.author).role;
    const content = obj(message.content);
    const type = content.content_type;
    const meta = obj(message.metadata);
    if (meta.is_visually_hidden_from_conversation === true) continue;
    const at = seconds(message.create_time) ?? lastAt;
    lastAt = at;
    if (role === "user") {
      if (type !== "text" && type !== "multimodal_text") continue;
      const attachments = list(meta.attachments).map((a): LocalAttachment => {
        const att = obj(a);
        const fileId = str(att.id) ?? "";
        const file = index.find(fileId);
        return {
          name: str(att.name) || (file ? files.names[file] : undefined) || fileId || "attachment",
          mediaType: str(att.mime_type) || "application/octet-stream",
          size: file ? (files.sizes.get(file) ?? 0) : 0,
          ...(file ? { file } : {}),
        };
      });
      const text = partsText(content)
        .filter((t) => t !== "")
        .join("\n")
        .trim();
      turns.push({ role: "user", at, text: cut(text), ...(attachments.length ? { attachments } : {}) });
      continue;
    }
    if (role !== "assistant") continue;
    let turn = turns.at(-1);
    if (turn?.role !== "assistant") {
      turn = { role: "assistant", at, text: "" };
      turns.push(turn);
    }
    const model = str(meta.model_slug);
    if (model) turn.model = model;
    if (type === "thoughts") {
      for (const t of list(content.thoughts).map(obj)) {
        const summary = (str(t.summary) ?? "").trim();
        const body = (str(t.content) ?? "").trim();
        const block = `${summary ? `**${summary}**\n\n` : ""}${body}`;
        if (block !== "" && (turn.thinking?.length ?? 0) < THINKING_MAX_BLOCKS)
          turn.thinking = [...(turn.thinking ?? []), cut(block)];
      }
    } else if (type === "text" || type === "multimodal_text") {
      const text = cleanText(partsText(content).join("\n"), meta.content_references);
      if (text !== "") turn.text = cut(turn.text ? `${turn.text}\n\n${text}` : text);
    }
    // reasoning_recap ("Thought for 12s"), code, execution output and the like are not carried.
  }
  const kept = turns.filter((t) => t.text !== "" || t.attachments?.length || t.thinking?.length);
  const pathSet = new Set(path);
  const offPath = Object.entries(mapping).filter(
    ([id, node]) => !pathSet.has(id) && Object.keys(obj(obj(node).message)).length > 0,
  ).length;
  return {
    transcript: {
      source: "chatgpt",
      sourceId: str(c.conversation_id) ?? str(c.id) ?? "",
      title: (str(c.title) || "Untitled").slice(0, TITLE_MAX_CHARS),
      createdAt,
      updatedAt: seconds(c.update_time) ?? createdAt,
      archived: c.is_archived === true,
      starred: c.is_starred === true,
      notice: CHATGPT_NOTICE,
      turns: kept,
    },
    offPath,
  };
}
