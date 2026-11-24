// Importing past conversations (docs/importing.md): upload a message's files, look up what was imported before, and
// import one chat from a neutral transcript. No model runs.
import { arr, bool, int, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import type {
  ImportAttachment,
  ImportLookupRequest,
  ImportLookupResponse,
  ImportSessionRequest,
  ImportSessionResponse,
  ImportTranscript,
  ImportTurn,
} from "../imports.ts";
import { AttachmentResponseSchema, AttachmentUploadSchema } from "./chat.ts";
import { defineRoute } from "./define.ts";
import { SessionSchema } from "./entities.ts";
import type { Same } from "./same.ts";

/** One turn's text (or one thinking block): generous, since an old chat may hold a long paste. */
const TURN_MAX_CHARS = 1_000_000;

const SourceSchema = str({ pattern: "^[a-z0-9][a-z0-9-]{0,39}$", description: "The app it came from, e.g. chatgpt." });
const SourceIdSchema = str({ minLength: 1, maxLength: 200 });

export const ImportAttachmentSchema = obj({
  name: str({ minLength: 1, maxLength: 500 }),
  mediaType: str({ maxLength: 200 }),
  size: int({ minimum: 0 }),
  attachmentId: opt(str({ minLength: 1, maxLength: 100 })),
  unavailable: opt(str({ minLength: 1, maxLength: 200 })),
});
true satisfies Same<Static<typeof ImportAttachmentSchema>, ImportAttachment>;

export const ImportTurnSchema = obj({
  role: oneOf(["user", "assistant"]),
  at: int({ minimum: 0 }),
  text: str({ maxLength: TURN_MAX_CHARS }),
  model: opt(str({ maxLength: 200 })),
  thinking: opt(arr(str({ maxLength: TURN_MAX_CHARS }), { maxItems: 1000 })),
  attachments: opt(arr(ImportAttachmentSchema, { maxItems: 100 })),
});
true satisfies Same<Static<typeof ImportTurnSchema>, ImportTurn>;

export const ImportTranscriptSchema = obj({
  source: SourceSchema,
  sourceId: SourceIdSchema,
  title: str({ maxLength: 500 }),
  createdAt: int({ minimum: 0 }),
  updatedAt: int({ minimum: 0 }),
  starred: opt(bool()),
  archived: opt(bool()),
  notice: opt(str({ minLength: 1, maxLength: 2000 })),
  turns: arr(ImportTurnSchema, { maxItems: 20_000 }),
});
true satisfies Same<Static<typeof ImportTranscriptSchema>, ImportTranscript>;

export const ImportSessionRequestSchema = obj({ agentId: str(), transcript: ImportTranscriptSchema });
true satisfies Same<Static<typeof ImportSessionRequestSchema>, ImportSessionRequest>;
export const ImportSessionResponseSchema = obj({ session: SessionSchema, created: bool() });
true satisfies Same<Static<typeof ImportSessionResponseSchema>, ImportSessionResponse>;

export const ImportLookupRequestSchema = obj({
  source: SourceSchema,
  sourceIds: arr(SourceIdSchema, { maxItems: 1000 }),
});
true satisfies Same<Static<typeof ImportLookupRequestSchema>, ImportLookupRequest>;
export const ImportLookupResponseSchema = obj({ found: arr(obj({ sourceId: str(), sessionId: str() })) });
true satisfies Same<Static<typeof ImportLookupResponseSchema>, ImportLookupResponse>;

export const importFileRoute = defineRoute({
  method: "POST",
  path: "/api/imports/files",
  tag: "imports",
  summary: "Upload one file of a chat about to be imported.",
  description:
    'Multipart with one `file` field. The file belongs to no chat until an import names its id; unused, it is removed after a day. Errors: "attachment_too_large" (413), "unavailable".',
  multipart: AttachmentUploadSchema,
  response: AttachmentResponseSchema,
});
export const importLookupRoute = defineRoute({
  method: "POST",
  path: "/api/imports/lookup",
  tag: "imports",
  summary: "Which of these source ids were imported already.",
  body: ImportLookupRequestSchema,
  response: ImportLookupResponseSchema,
});
export const importSessionRoute = defineRoute({
  method: "POST",
  path: "/api/imports/sessions",
  tag: "imports",
  summary: "Import one past conversation as a session of an agent, without running a model.",
  description:
    'Idempotent by source and source id: a repeat answers the existing session with created=false. Errors: "unknown_agent", "attachment_unavailable", "bad_request".',
  body: ImportSessionRequestSchema,
  response: ImportSessionResponseSchema,
});

export const importRoutes = [importFileRoute, importLookupRoute, importSessionRoute];
