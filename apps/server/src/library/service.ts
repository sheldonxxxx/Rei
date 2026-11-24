import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Attachment,
  FileReference,
  LibraryDetail,
  LibraryFile,
  LibraryFolder,
  LibraryList,
  LibraryVersion,
  TaintLabel,
} from "@rei/protocol";
import { filePreview, MESSAGE_MAX_ATTACHMENT_BYTES, MESSAGE_MAX_ATTACHMENTS } from "@rei/protocol";
import { OFFICE_PREVIEW_MAX_BYTES, officePreview, officePreviewTooLarge } from "../attachments/office-preview.ts";
import type { AttachmentRow, AttachmentService, UploadStream } from "../attachments/service.ts";
import type { AppStore } from "../store/store.ts";
import { badRequest, HttpError, notFound } from "../util/errors.ts";
import { newId } from "../util/ids.ts";

const fromBase64 = (data: string): Uint8Array<ArrayBuffer> | undefined => {
  try {
    if (data.length > 35_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return undefined;
    const raw = atob(data);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
};
type Row = {
  id: string;
  name: string;
  origin: "upload" | "agent";
  creator: string;
  created_at: number;
  updated_at: number;
  folder_id: string | null;
  favorite: number;
  trashed_at: number | null;
  purged_at: number | null;
  current_version: string;
  taint: string;
};
type VersionRow = {
  id: string;
  file_id: string;
  number: number;
  attachment_id: string;
  creator: string;
  created_at: number;
};
/**
 * Media in a tool result arrives inline (base64, already in memory), so it keeps the gateway's own bounds rather than
 * the upload limit: at most 25 MiB an item and 100 MiB a result (apps/gateway/src/core/mcp/flatten.ts).
 */
const RETAINED_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const RETAINED_MEDIA_TOTAL_BYTES = 100 * 1024 * 1024;

export const cleanName = (value: unknown) => {
  if (typeof value !== "string" || !value.trim() || value.length > 240 || /[\x00-\x1f\x7f]/.test(value))
    throw badRequest("bad_name", "Use a name of 1 to 240 characters without control characters.");
  return value.trim();
};
export class LibraryService {
  readonly store: AppStore;
  readonly attachments: AttachmentService;
  constructor(store: AppStore, attachments: AttachmentService) {
    this.store = store;
    this.attachments = attachments;
  }
  get db() {
    return this.store.db;
  }
  row(id: string, includeTrash = true): Row {
    const row = this.db.get<Row>("SELECT * FROM library_files WHERE id = ? AND purged_at IS NULL", id);
    if (!row || (!includeTrash && row.trashed_at !== null)) throw notFound("That library file is unavailable.");
    return row;
  }
  version(row: VersionRow): LibraryVersion {
    const a = this.attachments.row(row.attachment_id);
    if (!a) throw notFound("The file version is unavailable.");
    return {
      fileId: row.file_id,
      versionId: row.id,
      attachmentId: row.attachment_id,
      number: row.number,
      name: a.name,
      mediaType: a.media_type,
      size: a.size,
      creator: row.creator,
      createdAt: row.created_at,
    };
  }
  file(row: Row): LibraryFile {
    const current = this.db.get<VersionRow>(
      "SELECT * FROM library_versions WHERE id = ? AND file_id = ?",
      row.current_version,
      row.id,
    );
    if (!current) throw notFound("The file version is unavailable.");
    return {
      id: row.id,
      name: row.name,
      origin: row.origin,
      creator: row.creator,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      folderId: row.folder_id,
      favorite: !!row.favorite,
      trashedAt: row.trashed_at,
      current: this.version(current),
    };
  }
  detail(id: string): LibraryDetail {
    const file = this.file(this.row(id));
    return {
      file,
      folder: this.folders().find((folder) => folder.id === file.folderId) ?? null,
      versions: this.db
        .all<VersionRow>("SELECT * FROM library_versions WHERE file_id = ? ORDER BY number DESC", id)
        .map((v) => this.version(v)),
      chats: this.db.all<{ id: string; title: string }>(
        "SELECT DISTINCT s.id, s.title FROM library_links l JOIN sessions s ON s.id = l.session_id WHERE l.file_id = ? AND s.deleted_at IS NULL ORDER BY s.updated_at DESC",
        id,
      ),
    };
  }
  list(
    query: {
      q?: string;
      trash?: boolean;
      favorite?: boolean;
      folder?: string;
      origin?: string;
      type?: string;
      sort?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ): LibraryList {
    const limit = Math.max(1, Math.min(200, query.limit ?? 100));
    const where = ["purged_at IS NULL", query.trash ? "trashed_at IS NOT NULL" : "trashed_at IS NULL"];
    const values: (string | number)[] = [];
    if (query.q) {
      where.push("instr(lower(name), lower(?)) > 0");
      values.push(query.q.slice(0, 240));
    }
    if (query.favorite) where.push("favorite = 1");
    if (query.folder) {
      where.push("folder_id = ?");
      values.push(query.folder);
    }
    if (query.origin) {
      where.push("origin = ?");
      values.push(query.origin);
    }
    // Type filtering precedes pagination so pages cannot be spuriously empty.
    const sorted = this.db.all<Row>(
      `SELECT * FROM library_files WHERE ${where.join(" AND ")} ORDER BY ${query.sort === "name" ? "name COLLATE NOCASE, id" : query.sort === "oldest" ? "updated_at, id" : "updated_at DESC, id DESC"}`,
      ...values,
    );
    const filtered = query.type
      ? sorted.filter((r) => {
          const f = this.file(r);
          const kind = filePreview({ name: f.name, mediaType: f.current.mediaType }).kind;
          return query.type === "office" ? kind === "office" : kind === query.type;
        })
      : sorted;
    const start = query.cursor ? Math.max(0, filtered.findIndex((r) => r.id === query.cursor) + 1) : 0;
    const page = filtered.slice(start, start + limit);
    return {
      files: page.map((r) => this.file(r)),
      folders: this.folders(),
      nextCursor: start + page.length < filtered.length ? page.at(-1)!.id : null,
    };
  }
  folders(): LibraryFolder[] {
    return this.db
      .all<{ id: string; name: string; parent_id: string | null }>(
        "SELECT * FROM library_folders ORDER BY name COLLATE NOCASE",
      )
      .map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id }));
  }
  folder(id: unknown): string | null {
    if (id === null || id === undefined || id === "") return null;
    if (typeof id !== "string" || !this.db.get("SELECT 1 FROM library_folders WHERE id = ?", id))
      throw badRequest("bad_folder", "That folder is unavailable.");
    return id;
  }
  saveFolder(name: unknown, parentId: unknown, id?: string): LibraryFolder {
    const parent = this.folder(parentId),
      label = cleanName(name);
    if (id) {
      if (!this.db.get("SELECT 1 FROM library_folders WHERE id = ?", id)) throw notFound("That folder is unavailable.");
      let ancestor = parent;
      while (ancestor) {
        if (ancestor === id) throw badRequest("bad_folder", "A folder cannot contain itself.");
        ancestor =
          this.db.get<{ parent_id: string | null }>("SELECT parent_id FROM library_folders WHERE id = ?", ancestor)
            ?.parent_id ?? null;
      }
      this.db.run("UPDATE library_folders SET name = ?, parent_id = ? WHERE id = ?", label, parent, id);
    } else {
      id = newId("folder", this.store.clock.now());
      this.db.run("INSERT INTO library_folders VALUES (?, ?, ?)", id, label, parent);
    }
    return { id, name: label, parentId: parent };
  }
  deleteFolder(id: string) {
    this.db.transaction(() => {
      this.db.run("UPDATE library_files SET folder_id = NULL WHERE folder_id = ?", id);
      this.db.run("UPDATE library_folders SET parent_id = NULL WHERE parent_id = ?", id);
      this.db.run("DELETE FROM library_folders WHERE id = ?", id);
    });
  }
  patch(id: string, patch: { name?: unknown; favorite?: unknown; folderId?: unknown; trashed?: unknown }): LibraryFile {
    const row = this.row(id);
    if (
      (patch.favorite !== undefined && typeof patch.favorite !== "boolean") ||
      (patch.trashed !== undefined && typeof patch.trashed !== "boolean")
    )
      throw badRequest("bad_request", "Invalid file metadata.");
    this.db.run(
      "UPDATE library_files SET name = ?, favorite = ?, folder_id = ?, trashed_at = ?, updated_at = ? WHERE id = ?",
      patch.name === undefined ? row.name : cleanName(patch.name),
      patch.favorite === undefined ? row.favorite : patch.favorite ? 1 : 0,
      patch.folderId === undefined ? row.folder_id : this.folder(patch.folderId),
      patch.trashed === undefined ? row.trashed_at : patch.trashed ? (row.trashed_at ?? this.store.clock.now()) : null,
      this.store.clock.now(),
      id,
    );
    return this.file(this.row(id));
  }
  /** Promotes the existing attachment envelope; no byte copy or lifetime-coupling to trace blobs. */
  importAttachment(
    a: AttachmentRow,
    origin: "upload" | "agent" = "upload",
    creator = "You",
    update?: { fileId: string; baseVersionId: string },
    publishKey?: string,
  ): LibraryFile {
    return this.db.transaction(() => {
      if (publishKey) {
        const prior = this.db.get<VersionRow>("SELECT * FROM library_versions WHERE publish_key = ?", publishKey);
        if (prior) return this.file(this.row(prior.file_id));
      }
      const existing = this.db.get<VersionRow>("SELECT * FROM library_versions WHERE attachment_id = ?", a.id);
      if (existing) return this.file(this.row(existing.file_id));
      const previous = update ? this.row(update.fileId, false) : undefined;
      if (previous && previous.current_version !== update!.baseVersionId)
        throw new HttpError(
          409,
          "version_conflict",
          "The file changed. Read its latest version before publishing a revision.",
        );
      const fileId = previous?.id ?? newId("file", this.store.clock.now()),
        versionId = newId("ver", this.store.clock.now());
      const number = previous
        ? (this.db.get<{ n: number }>("SELECT MAX(number) AS n FROM library_versions WHERE file_id = ?", fileId)?.n ??
            0) + 1
        : 1;
      const now = this.store.clock.now();
      const labels = a.session_id ? (this.store.getSessionRow(a.session_id)?.taint ?? '["private"]') : '["private"]';
      if (!previous)
        this.db.run(
          "INSERT INTO library_files(id,name,origin,creator,created_at,updated_at,current_version,taint) VALUES (?,?,?,?,?,?,?,?)",
          fileId,
          a.name,
          origin,
          creator,
          a.created_at,
          now,
          versionId,
          JSON.stringify([...new Set(["private", ...JSON.parse(labels)])]),
        );
      else
        this.db.run(
          "UPDATE library_files SET current_version = ?, updated_at = ?, taint = ? WHERE id = ?",
          versionId,
          now,
          JSON.stringify([...new Set([...JSON.parse(previous.taint), ...JSON.parse(labels)])]),
          fileId,
        );
      this.db.run(
        "INSERT INTO library_versions VALUES (?,?,?,?,?,?,?)",
        versionId,
        fileId,
        number,
        a.id,
        creator,
        now,
        publishKey ?? null,
      );
      this.db.run("UPDATE attachments SET file_id = ?, version_id = ? WHERE id = ?", fileId, versionId, a.id);
      if (a.session_id)
        this.db.run(
          "INSERT OR IGNORE INTO library_links VALUES (?,?,?,?,?)",
          fileId,
          versionId,
          a.session_id,
          "",
          "source",
        );
      return this.file(this.row(fileId));
    });
  }
  published(key: string): Attachment | undefined {
    const row = this.db.get<VersionRow>("SELECT * FROM library_versions WHERE publish_key = ?", key);
    return row ? this.resolve({ fileId: row.file_id, versionId: row.id }, false) : undefined;
  }
  resolve(ref: FileReference, active = true): Attachment {
    const file = this.row(ref.fileId, !active);
    const v = this.db.get<VersionRow>(
      "SELECT * FROM library_versions WHERE id = ? AND file_id = ?",
      ref.versionId,
      file.id,
    );
    if (!v) throw notFound("That file version is unavailable.");
    const a = this.attachments.row(v.attachment_id)!;
    return {
      id: a.id,
      name: a.name,
      size: a.size,
      mediaType: a.media_type,
      fileId: file.id,
      versionId: v.id,
      ...(ref.location ? { location: ref.location } : {}),
    };
  }
  select(_sessionId: string, refs: unknown): Attachment[] {
    if (!Array.isArray(refs) || refs.length > MESSAGE_MAX_ATTACHMENTS)
      throw badRequest("bad_request", "Choose at most 10 library files.");
    const result = refs.map((r: unknown) => {
      if (
        !r ||
        typeof r !== "object" ||
        typeof (r as FileReference).fileId !== "string" ||
        typeof (r as FileReference).versionId !== "string"
      )
        throw badRequest("bad_request", "Invalid file reference.");
      const ref = r as FileReference;
      if (
        ref.location !== undefined &&
        (!ref.location ||
          typeof ref.location !== "object" ||
          JSON.stringify(ref.location).length > 500 ||
          Object.entries(ref.location).some(
            ([key, value]) =>
              !["sheet", "cell", "slide", "page"].includes(key) ||
              (["sheet", "cell"].includes(key)
                ? typeof value !== "string"
                : !Number.isInteger(value) || Number(value) < 1),
          ))
      )
        throw badRequest("bad_request", "Invalid file location.");
      return this.resolve(ref);
    });
    if (
      new Set(result.map((a) => a.id)).size !== result.length ||
      result.reduce((n, a) => n + a.size, 0) > MESSAGE_MAX_ATTACHMENT_BYTES
    )
      throw badRequest("bad_request", "Choose distinct files totaling at most 2 GiB.");
    return result;
  }
  link(sessionId: string, files: Attachment[], runId = "", kind = "input") {
    for (const file of files)
      if (file.fileId && file.versionId) {
        this.db.run(
          "INSERT OR IGNORE INTO library_links VALUES (?,?,?,?,?)",
          file.fileId,
          file.versionId,
          sessionId,
          runId,
          kind,
        );
        const row = this.row(file.fileId);
        this.store.addTaint(sessionId, JSON.parse(row.taint) as TaintLabel[]);
      }
  }
  async retainMedia(
    sessionId: string,
    media: import("@rei/protocol").McpResultMedia[],
  ): Promise<{ mediaId: string; name: string; mediaType: string }[]> {
    const result: { mediaId: string; name: string; mediaType: string }[] = [];
    let total = 0;
    for (const [index, item] of media.slice(0, 10).entries()) {
      const bytes =
        typeof item.data === "string"
          ? fromBase64(item.data)
          : typeof item.text === "string"
            ? new TextEncoder().encode(item.text)
            : undefined;
      if (!bytes || bytes.length > RETAINED_MEDIA_MAX_BYTES || total + bytes.length > RETAINED_MEDIA_TOTAL_BYTES)
        continue;
      total += bytes.length;
      const ext: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
        "image/svg+xml": "svg",
        "audio/mpeg": "mp3",
        "audio/wav": "wav",
        "text/html": "html",
        "text/plain": "txt",
        "application/pdf": "pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
      };
      const uriName = item.uri?.split("/").pop()?.split("?")[0];
      const name =
        uriName && uriName.includes(".") ? uriName : `tool-result-${index + 1}.${ext[item.mimeType] ?? "bin"}`;
      const a = await this.attachments.upload(
        sessionId,
        new File([bytes], name, { type: item.mimeType }),
        undefined,
        "Agent",
        undefined,
        false,
      );
      result.push({ mediaId: a.id, name: a.name, mediaType: a.mediaType });
    }
    return result;
  }
  async upload(file: File | UploadStream, folderId: string | null = null): Promise<LibraryFile> {
    const a = await this.attachments.upload("", file);
    if (!a.fileId) throw new Error("Upload was not saved to the library");
    return folderId ? this.patch(a.fileId, { folderId }) : this.file(this.row(a.fileId));
  }
  async restoreVersion(id: string, versionId: string, baseVersionId: string): Promise<LibraryFile> {
    const source = this.resolve({ fileId: id, versionId }, false);
    const a = await this.attachments.upload(
      "",
      await this.attachments.source(this.attachments.row(source.id)!, source.name, source.mediaType),
      { fileId: id, baseVersionId },
      "You",
    );
    return this.file(this.row(a.fileId!));
  }
  async purge(id: string) {
    const file = this.row(id);
    if (file.trashed_at === null) throw badRequest("not_trashed", "Move the file to Trash first.");
    this.db.run("UPDATE library_files SET purged_at = ? WHERE id = ?", this.store.clock.now(), id);
    await this.collect();
  }
  async collect() {
    this.db.run(
      "DELETE FROM library_links WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = library_links.session_id AND s.deleted_at IS NULL)",
    );
    this.db.run(
      "UPDATE library_files SET purged_at = ? WHERE trashed_at < ? AND purged_at IS NULL",
      this.store.clock.now(),
      this.store.clock.now() - 30 * 86_400_000,
    );
    const unused = this.db.all<AttachmentRow>(
      "SELECT a.* FROM attachments a JOIN library_versions v ON v.attachment_id = a.id JOIN library_files f ON f.id = v.file_id WHERE f.purged_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM attachment_refs r WHERE r.attachment_id = a.id)",
    );
    for (const a of unused) {
      // Ask for the bytes to go first: a Garage outage then costs a retry, not the intent, and if SQLite refused the
      // row deletions next the object is already owned by nothing and will be reclaimed.
      this.attachments.registry.scheduleDelete(a.object_id);
      this.db.run("DELETE FROM library_versions WHERE attachment_id = ?", a.id);
      this.db.run("DELETE FROM attachments WHERE id = ?", a.id);
    }
    // A purge is something the user asked for and is waiting on, so try to actually remove the bytes now.
    await this.attachments.maintenance?.drain();
  }
  #conversions = 0;
  async compatibility(ref: FileReference, sessionId: string): Promise<Uint8Array<ArrayBuffer>> {
    const a = this.resolve(ref, false),
      session = this.store.getSessionRow(sessionId);
    if (!session || !this.attachments.workspaces)
      throw new HttpError(
        503,
        "preview_unavailable",
        "Choose a chat with an execution sandbox for compatibility preview.",
      );
    if (filePreview(a).kind !== "office") throw badRequest("bad_format", "Compatibility preview is for Office files.");
    if (a.size > OFFICE_PREVIEW_MAX_BYTES) throw officePreviewTooLarge();
    if (this.#conversions >= 2)
      throw new HttpError(429, "preview_busy", "Other previews are being prepared. Try again shortly.");
    this.#conversions++;
    try {
      const backend = this.attachments.workspaces.forTree(session.tree_id);
      await backend.ready(session.tree_id);
      const env = backend.env(session.tree_id);
      const row = this.attachments.row(a.id)!;
      return await officePreview(
        env,
        (path) => this.attachments.copyToWorkspace(row, env, path, BACKGROUND_CONTEXT),
        filePreview(a).extension,
      );
    } finally {
      this.#conversions--;
    }
  }
}
