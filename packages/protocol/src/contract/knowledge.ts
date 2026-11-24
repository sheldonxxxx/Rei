// Knowledge pages, library folders, files and versions (issue 17). Request and response types still live in
// ../knowledge.ts and ../library.ts as interfaces; each schema here is checked against its interface at compile time.
import { arr, bool, int, lit, nullable, num, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import type {
  KnowledgeActor,
  KnowledgeOverview,
  KnowledgePage,
  KnowledgePageDetail,
  KnowledgeRevision,
  KnowledgeSearchHit,
  KnowledgeTreeNode,
} from "../knowledge.ts";
import type { LibraryDetail, LibraryFile, LibraryFolder, LibraryList, LibraryVersion } from "../library.ts";
import { OkSchema } from "./auth.ts";
import { defineRoute, named } from "./define.ts";
import { FileLocationSchema } from "./entities.ts";
import type { Same } from "./same.ts";

// ---- knowledge ------------------------------------------------------------------------------------------------------

export const KnowledgeActorSchema = named(
  "KnowledgeActor",
  obj({ kind: oneOf(["user", "agent"]), id: nullable(str()), name: str() }),
);
true satisfies Same<Static<typeof KnowledgeActorSchema>, KnowledgeActor>;

export const KnowledgeMetadataSchema = named("KnowledgeMetadata", obj({ tags: arr(str()) }));
const KnowledgeMetadataInputSchema = obj({ tags: opt(arr(str())) });

export const KnowledgePageSchema = named(
  "KnowledgePage",
  obj({
    id: str(),
    parentId: nullable(str()),
    title: str(),
    description: str(),
    metadata: KnowledgeMetadataSchema,
    revision: int(),
    locked: bool(),
    pinned: bool(),
    inbox: bool(),
    external: bool(),
    createdBy: KnowledgeActorSchema,
    createdAt: num(),
    updatedBy: KnowledgeActorSchema,
    updatedAt: num(),
    activityAt: num(),
    trashedAt: nullable(num()),
  }),
);
true satisfies Same<Static<typeof KnowledgePageSchema>, KnowledgePage>;

export const KnowledgeTreeNodeSchema = named(
  "KnowledgeTreeNode",
  obj({
    id: str(),
    parentId: nullable(str()),
    title: str(),
    description: str(),
    activityAt: num(),
    updatedAt: num(),
    updatedBy: KnowledgeActorSchema,
    locked: bool(),
    pinned: bool(),
    inbox: bool(),
    childCount: int(),
    path: opt(str()),
    trashedAt: opt(nullable(num())),
  }),
);
true satisfies Same<Static<typeof KnowledgeTreeNodeSchema>, KnowledgeTreeNode>;

const revisionFields = {
  metadata: KnowledgeMetadataSchema,
  revision: int(),
  title: str(),
  description: str(),
  actor: KnowledgeActorSchema,
  sessionId: nullable(str()),
  sessionTitle: nullable(str()),
  runId: nullable(str()),
  external: bool(),
  note: nullable(str()),
  createdAt: num(),
  updatedAt: num(),
};
export const KnowledgeRevisionSchema = named("KnowledgeRevision", obj(revisionFields));
true satisfies Same<Static<typeof KnowledgeRevisionSchema>, KnowledgeRevision>;
export const KnowledgeRevisionDetailSchema = obj({ ...revisionFields, body: str() });
true satisfies Same<Static<typeof KnowledgeRevisionDetailSchema>, KnowledgeRevision & { body: string }>;

export const KnowledgePageDetailSchema = named(
  "KnowledgePageDetail",
  obj({
    page: KnowledgePageSchema,
    body: str(),
    ancestors: arr(obj({ id: str(), title: str() })),
    children: arr(KnowledgeTreeNodeSchema),
    backlinks: arr(obj({ id: str(), title: str(), path: str() })),
    files: arr(
      obj({
        fileId: str(),
        versionId: nullable(str()),
        name: nullable(str()),
        available: bool(),
        contentVersionId: nullable(str()),
        mediaType: nullable(str()),
      }),
    ),
    revisions: arr(KnowledgeRevisionSchema),
  }),
);
true satisfies Same<Static<typeof KnowledgePageDetailSchema>, KnowledgePageDetail>;

export const KnowledgeSearchHitSchema = named(
  "KnowledgeSearchHit",
  obj({
    pageId: str(),
    title: str(),
    path: str(),
    section: str(),
    snippet: str(),
    updatedAt: num(),
    matched: arr(oneOf(["keyword", "meaning"])),
  }),
);
true satisfies Same<Static<typeof KnowledgeSearchHitSchema>, KnowledgeSearchHit>;

export const KnowledgeOverviewSchema = obj({
  pinned: arr(KnowledgeTreeNodeSchema),
  recent: arr(KnowledgeTreeNodeSchema),
  week: arr(obj({ actor: KnowledgeActorSchema, created: int(), edited: int() })),
  inbox: obj({ id: str(), count: int(), newest: arr(KnowledgeTreeNodeSchema) }),
  external: arr(KnowledgeTreeNodeSchema),
  locked: arr(KnowledgeTreeNodeSchema),
  trashCount: int(),
  pageCount: int(),
  meaning: obj({
    state: oneOf(["off", "indexing", "ready", "down"]),
    sections: int(),
    embedded: int(),
    lastError: nullable(str()),
  }),
});
true satisfies Same<Static<typeof KnowledgeOverviewSchema>, KnowledgeOverview>;

export const KnowledgePagesResponseSchema = obj({ pages: arr(KnowledgeTreeNodeSchema) });
export const KnowledgeSearchQuerySchema = obj({
  q: opt(str()),
  tags: opt(str({ description: "JSON array of tags; all must match." })),
  limit: opt(str({ description: "1–20 results; default 20." })),
  under: opt(str({ description: "Only pages under this page." })),
});
export const KnowledgeSearchResponseSchema = obj({ hits: arr(KnowledgeSearchHitSchema) });
export const KnowledgeFileUsageResponseSchema = obj({ pages: arr(obj({ id: str(), title: str(), path: str() })) });
export const CreateKnowledgePageRequestSchema = obj({
  metadata: opt(KnowledgeMetadataInputSchema),
  sourceMarkdown: opt(str()),
  parentId: opt(nullable(str())),
  title: opt(str()),
  description: opt(str()),
  body: opt(str()),
});
export const SaveKnowledgePageRequestSchema = obj({
  metadata: opt(KnowledgeMetadataInputSchema),
  sourceMarkdown: opt(str()),
  title: opt(str()),
  description: opt(str()),
  body: opt(str()),
  baseRevision: int({ description: "The revision the editor opened; a newer one answers 409 conflict." }),
});
export const PatchKnowledgePageRequestSchema = obj({
  task: opt(obj({ index: int(), done: bool() })),
  parentId: opt(nullable(str())),
  locked: opt(bool()),
  pinned: opt(bool()),
});
export const RestoreKnowledgeRevisionRequestSchema = obj({ revision: int(), baseRevision: int() });
export const PurgeRequestSchema = obj({ confirm: opt(bool({ description: "Must be true." })) });
export const KnowledgeTrashResponseSchema = obj({ trashed: int() });
export const KnowledgePurgeResponseSchema = obj({ deleted: int() });
export const KnowledgeSectionQuerySchema = obj({ ref: opt(str({ description: "A section reference; default top." })) });
export const KnowledgeSectionResponseSchema = obj({ revision: int(), text: str() });

const CONFLICT = 'A stale baseRevision answers 409 "conflict" with `revision` and `current` beside the error.';

export const knowledgeTagsRoute = defineRoute({
  method: "GET",
  path: "/api/knowledge/tags",
  tag: "knowledge",
  summary: "Tag suggestions from live pages.",
  response: obj({ tags: arr(str()) }),
});
export const knowledgeTreeRoute = defineRoute({
  method: "GET",
  path: "/api/knowledge/tree",
  tag: "knowledge",
  summary: "Every live page, without bodies.",
  response: KnowledgePagesResponseSchema,
});
export const knowledgeOverviewRoute = defineRoute({
  method: "GET",
  path: "/api/knowledge/overview",
  tag: "knowledge",
  summary: "The Knowledge home: pinned, recent, this week, inbox and meaning search.",
  response: KnowledgeOverviewSchema,
});
export const knowledgeTrashRoute = defineRoute({
  method: "GET",
  path: "/api/knowledge/trash",
  tag: "knowledge",
  summary: "Pages in the trash.",
  response: KnowledgePagesResponseSchema,
});
export const knowledgeSearchRoute = defineRoute({
  method: "GET",
  path: "/api/knowledge/search",
  tag: "knowledge",
  summary: "Search pages by keyword and meaning; at most 20 hits.",
  query: KnowledgeSearchQuerySchema,
  response: KnowledgeSearchResponseSchema,
});
export const knowledgeFileUsageRoute = defineRoute({
  method: "GET",
  path: "/api/knowledge/file-usage/:fileId",
  tag: "knowledge",
  summary: "Live pages that link to a Library file.",
  response: KnowledgeFileUsageResponseSchema,
});
export const createKnowledgePageRoute = defineRoute({
  method: "POST",
  path: "/api/knowledge/pages",
  tag: "knowledge",
  summary: "Create a page.",
  body: CreateKnowledgePageRequestSchema,
  response: KnowledgePageDetailSchema,
  status: 201,
});
export const knowledgePageRoute = defineRoute({
  method: "GET",
  path: "/api/knowledge/pages/:id",
  tag: "knowledge",
  summary: "One page with its body, family, links, files and revisions.",
  response: KnowledgePageDetailSchema,
});
export const knowledgeRevisionRoute = defineRoute({
  method: "GET",
  path: "/api/knowledge/pages/:id/revisions/:revision",
  tag: "knowledge",
  summary: "One revision of a page, with its body.",
  response: KnowledgeRevisionDetailSchema,
});
export const saveKnowledgePageRoute = defineRoute({
  method: "PUT",
  path: "/api/knowledge/pages/:id",
  tag: "knowledge",
  summary: "The editor's save: title, description and body as a whole, against the revision it opened.",
  description: CONFLICT,
  body: SaveKnowledgePageRequestSchema,
  response: KnowledgePageDetailSchema,
});
export const patchKnowledgePageRoute = defineRoute({
  method: "PATCH",
  path: "/api/knowledge/pages/:id",
  tag: "knowledge",
  summary: "Small changes from the reader: tick a task, move, lock, pin.",
  description: CONFLICT,
  body: PatchKnowledgePageRequestSchema,
  response: KnowledgePageDetailSchema,
});
export const restoreKnowledgeRevisionRoute = defineRoute({
  method: "POST",
  path: "/api/knowledge/pages/:id/restore-revision",
  tag: "knowledge",
  summary: "Make an old revision the newest one.",
  description: CONFLICT,
  body: RestoreKnowledgeRevisionRequestSchema,
  response: KnowledgePageDetailSchema,
});
export const trashKnowledgePageRoute = defineRoute({
  method: "POST",
  path: "/api/knowledge/pages/:id/trash",
  tag: "knowledge",
  summary: "Move a page and its subtree to the trash.",
  response: KnowledgeTrashResponseSchema,
});
export const restoreKnowledgePageRoute = defineRoute({
  method: "POST",
  path: "/api/knowledge/pages/:id/restore",
  tag: "knowledge",
  summary: "Bring a page back from the trash.",
  response: KnowledgePageDetailSchema,
});
export const purgeKnowledgePageRoute = defineRoute({
  method: "DELETE",
  path: "/api/knowledge/pages/:id",
  tag: "knowledge",
  summary: "Delete a page permanently.",
  description: 'Errors: "confirmation_required" (without confirm: true).',
  body: PurgeRequestSchema,
  response: KnowledgePurgeResponseSchema,
});
export const knowledgeMarkdownRoute = defineRoute({
  method: "GET",
  path: "/api/knowledge/pages/:id/markdown",
  tag: "knowledge",
  summary: "One page as a Markdown download.",
  raw: { kind: "binary", contentType: "text/markdown" },
});
export const knowledgeSectionRoute = defineRoute({
  method: "GET",
  path: "/api/knowledge/pages/:id/section",
  tag: "knowledge",
  summary: "One section's text, for the editor's conflict view.",
  query: KnowledgeSectionQuerySchema,
  response: KnowledgeSectionResponseSchema,
});

// ---- library --------------------------------------------------------------------------------------------------------

export const LibraryVersionSchema = named(
  "LibraryVersion",
  obj({
    fileId: str(),
    versionId: str(),
    location: opt(FileLocationSchema),
    attachmentId: str(),
    number: int(),
    name: str(),
    mediaType: str(),
    size: int(),
    createdAt: num(),
    creator: str(),
  }),
);
true satisfies Same<Static<typeof LibraryVersionSchema>, LibraryVersion>;
export const LibraryFileSchema = named(
  "LibraryFile",
  obj({
    id: str(),
    name: str(),
    origin: oneOf(["upload", "agent"]),
    creator: str(),
    createdAt: num(),
    updatedAt: num(),
    folderId: nullable(str()),
    favorite: bool(),
    trashedAt: nullable(num()),
    current: LibraryVersionSchema,
  }),
);
true satisfies Same<Static<typeof LibraryFileSchema>, LibraryFile>;
export const LibraryFolderSchema = named("LibraryFolder", obj({ id: str(), name: str(), parentId: nullable(str()) }));
true satisfies Same<Static<typeof LibraryFolderSchema>, LibraryFolder>;
export const LibraryDetailSchema = obj({
  folder: opt(nullable(LibraryFolderSchema)),
  file: LibraryFileSchema,
  versions: arr(LibraryVersionSchema),
  chats: arr(obj({ id: str(), title: str() })),
});
true satisfies Same<Static<typeof LibraryDetailSchema>, LibraryDetail>;
export const LibraryListSchema = obj({
  files: arr(LibraryFileSchema),
  folders: arr(LibraryFolderSchema),
  nextCursor: nullable(str()),
});
true satisfies Same<Static<typeof LibraryListSchema>, LibraryList>;

const flag = () => lit("1");
export const LibraryListQuerySchema = obj({
  q: opt(str()),
  trash: opt(flag()),
  favorite: opt(flag()),
  folder: opt(str()),
  origin: opt(str()),
  type: opt(str({ description: "A preview kind, e.g. image, pdf, office." })),
  sort: opt(str({ description: "name, oldest, or newest first (the default)." })),
  cursor: opt(str()),
});
export const LibraryFileResponseSchema = obj({ file: LibraryFileSchema });
export const UploadFileQuerySchema = obj({ folder: opt(str()) });
export const UploadFormSchema = obj({ file: str({ description: "Exactly one file part, at most 1 GiB." }) });
export const PatchFileRequestSchema = obj({
  name: opt(str()),
  favorite: opt(bool()),
  folderId: opt(nullable(str())),
  trashed: opt(bool()),
});
export const UploadVersionQuerySchema = obj({
  baseVersionId: opt(str({ description: "Required: the version this one replaces." })),
});
export const RestoreVersionRequestSchema = obj({ versionId: str(), baseVersionId: str() });
export const FileContentQuerySchema = obj({ thumbnail: opt(flag()) });
export const CompatibilityQuerySchema = obj({ session: opt(str()) });
export const LibraryFoldersResponseSchema = obj({ folders: arr(LibraryFolderSchema) });
export const SaveFolderRequestSchema = obj({ name: str(), parentId: opt(nullable(str())) });
export const LibraryFolderResponseSchema = obj({ folder: LibraryFolderSchema });

export const filesRoute = defineRoute({
  method: "GET",
  path: "/api/files",
  tag: "library",
  summary: "One page of Library files, with every folder.",
  query: LibraryListQuerySchema,
  response: LibraryListSchema,
});
export const uploadFileRoute = defineRoute({
  method: "POST",
  path: "/api/files",
  tag: "library",
  summary: "Upload a file to the Library.",
  description: 'Errors: "attachment_too_large" (413), "bad_folder", "bad_request".',
  query: UploadFileQuerySchema,
  multipart: UploadFormSchema,
  response: LibraryFileResponseSchema,
});
export const fileRoute = defineRoute({
  method: "GET",
  path: "/api/files/:id",
  tag: "library",
  summary: "One file with its versions and the chats that use it.",
  response: LibraryDetailSchema,
});
export const patchFileRoute = defineRoute({
  method: "PATCH",
  path: "/api/files/:id",
  tag: "library",
  summary: "Rename, favorite, move or trash a file.",
  description: 'Errors: "not_found", "bad_name", "bad_folder", "bad_request".',
  body: PatchFileRequestSchema,
  response: LibraryFileResponseSchema,
  fieldCodes: { name: "bad_name", folderId: "bad_folder" },
});
export const purgeFileRoute = defineRoute({
  method: "DELETE",
  path: "/api/files/:id",
  tag: "library",
  summary: "Delete a file permanently.",
  description: 'Errors: "confirmation_required" (without confirm: true), "not_found".',
  body: PurgeRequestSchema,
  response: OkSchema,
});
export const uploadFileVersionRoute = defineRoute({
  method: "POST",
  path: "/api/files/:id/versions",
  tag: "library",
  summary: "Upload a new version of a file.",
  description: 'Errors: "base_version_required", "version_conflict" (409), "attachment_too_large" (413).',
  query: UploadVersionQuerySchema,
  multipart: UploadFormSchema,
  response: LibraryFileResponseSchema,
});
export const restoreFileVersionRoute = defineRoute({
  method: "POST",
  path: "/api/files/:id/restore-version",
  tag: "library",
  summary: "Make an old version the current one.",
  description: 'Errors: "version_conflict" (409).',
  body: RestoreVersionRequestSchema,
  response: LibraryFileResponseSchema,
});
export const fileContentRoute = defineRoute({
  method: "GET",
  path: "/api/files/:id/versions/:versionId/content",
  tag: "library",
  summary: "A version's bytes: a download, or an inline image with thumbnail=1.",
  query: FileContentQuerySchema,
  raw: { kind: "binary", contentType: "application/octet-stream" },
});
export const fileHtmlRoute = defineRoute({
  method: "GET",
  path: "/api/files/:id/versions/:versionId/html",
  tag: "library",
  summary: "An HTML version, sandboxed for the preview frame.",
  description: 'Errors: "bad_format", "preview_too_large" (413).',
  raw: { kind: "binary", contentType: "text/html" },
});
export const fileCompatibilityRoute = defineRoute({
  method: "GET",
  path: "/api/files/:id/versions/:versionId/compatibility",
  tag: "library",
  summary: "An office document converted to PDF for preview.",
  query: CompatibilityQuerySchema,
  raw: { kind: "binary", contentType: "application/pdf" },
});
export const libraryFoldersRoute = defineRoute({
  method: "GET",
  path: "/api/library/folders",
  tag: "library",
  summary: "Every Library folder.",
  response: LibraryFoldersResponseSchema,
});
export const createLibraryFolderRoute = defineRoute({
  method: "POST",
  path: "/api/library/folders",
  tag: "library",
  summary: "Create a folder.",
  description: 'Errors: "bad_name", "bad_folder", "bad_request".',
  body: SaveFolderRequestSchema,
  response: LibraryFolderResponseSchema,
  fieldCodes: { name: "bad_name", parentId: "bad_folder" },
});
export const updateLibraryFolderRoute = defineRoute({
  method: "PATCH",
  path: "/api/library/folders/:id",
  tag: "library",
  summary: "Rename or move a folder.",
  description: 'Errors: "not_found", "bad_name", "bad_folder", "bad_request".',
  body: SaveFolderRequestSchema,
  response: LibraryFolderResponseSchema,
  fieldCodes: { name: "bad_name", parentId: "bad_folder" },
});
export const deleteLibraryFolderRoute = defineRoute({
  method: "DELETE",
  path: "/api/library/folders/:id",
  tag: "library",
  summary: "Delete a folder; its files and folders move to the top.",
  response: OkSchema,
});

export const knowledgeRoutes = [
  knowledgeTagsRoute,
  knowledgeTreeRoute,
  knowledgeOverviewRoute,
  knowledgeTrashRoute,
  knowledgeSearchRoute,
  knowledgeFileUsageRoute,
  createKnowledgePageRoute,
  knowledgePageRoute,
  knowledgeRevisionRoute,
  saveKnowledgePageRoute,
  patchKnowledgePageRoute,
  restoreKnowledgeRevisionRoute,
  trashKnowledgePageRoute,
  restoreKnowledgePageRoute,
  purgeKnowledgePageRoute,
  knowledgeMarkdownRoute,
  knowledgeSectionRoute,
] as const;
export const libraryRoutes = [
  filesRoute,
  uploadFileRoute,
  fileRoute,
  patchFileRoute,
  purgeFileRoute,
  uploadFileVersionRoute,
  restoreFileVersionRoute,
  fileContentRoute,
  fileHtmlRoute,
  fileCompatibilityRoute,
  libraryFoldersRoute,
  createLibraryFolderRoute,
  updateLibraryFolderRoute,
  deleteLibraryFolderRoute,
] as const;
