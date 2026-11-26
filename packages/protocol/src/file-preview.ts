/** Preview classification uses known extensions first; uploads often arrive as octet-stream. */
export type FilePreviewKind =
  | "text"
  | "markdown"
  | "html"
  | "csv"
  | "tsv"
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "office"
  | "unsupported";
const extensions: Record<string, [FilePreviewKind, string]> = {};
const add = (names: string, kind: FilePreviewKind, type: string) => {
  for (const name of names.split(" ")) extensions[name] = [kind, type];
};
add(
  "txt log ini cfg conf env sh bash zsh py js jsx ts tsx css scss sql c h cpp hpp java go rs rb php swift toml yaml yml json jsonl xml tex diff patch eml",
  "text",
  "text/plain",
);
add("md markdown mdx", "markdown", "text/markdown");
add("html htm", "html", "text/html");
add("csv", "csv", "text/csv");
add("tsv", "tsv", "text/tab-separated-values");
for (const [ext, type] of Object.entries({
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  gif: "gif",
  webp: "webp",
  avif: "avif",
  bmp: "bmp",
  ico: "x-icon",
  svg: "svg+xml",
}))
  add(ext, "image", `image/${type}`);
add("pdf", "pdf", "application/pdf");
for (const [ext, type] of Object.entries({ mp3: "mpeg", wav: "wav", ogg: "ogg", m4a: "mp4", aac: "aac", flac: "flac" }))
  add(ext, "audio", `audio/${type}`);
for (const [ext, type] of Object.entries({ mp4: "mp4", webm: "webm", mov: "quicktime", ogv: "ogg" }))
  add(ext, "video", `video/${type}`);
add(
  "doc docx dot dotx xls xlsx xlt xltx xlsm xltm xlsb ppt pptx pps ppsx pot potx odt ods odp rtf",
  "office",
  "application/pdf",
);
const officeTypes = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/rtf",
  "text/rtf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
]);
export function filePreview(file: { name: string; mediaType: string }): {
  kind: FilePreviewKind;
  mediaType: string;
  extension: string;
} {
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  const known = extensions[extension];
  if (known) return { kind: known[0], mediaType: known[1], extension };
  const mediaType = file.mediaType.toLowerCase().split(";")[0]!.trim();
  const matched = Object.entries(extensions).find(([, [, type]]) => type === mediaType);
  if (matched) return { kind: matched[1][0], mediaType, extension: matched[0] };
  if (officeTypes.has(mediaType)) {
    const ext = mediaType.includes("opendocument.spreadsheet")
      ? "ods"
      : mediaType.includes("opendocument.presentation")
        ? "odp"
        : mediaType.includes("spreadsheet")
          ? "xlsx"
          : mediaType.includes("presentation")
            ? "pptx"
            : mediaType.includes("ms-excel")
              ? "xls"
              : mediaType.includes("ms-powerpoint")
                ? "ppt"
                : mediaType.includes("rtf")
                  ? "rtf"
                  : mediaType.includes("msword")
                    ? "doc"
                    : mediaType.includes("opendocument.text")
                      ? "odt"
                      : "docx";
    return { kind: "office", mediaType: "application/pdf", extension: ext };
  }
  return { kind: mediaType.startsWith("text/") ? "text" : "unsupported", mediaType: "text/plain", extension };
}
export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

export const INLINE_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const inlineImageTypes = new Set<string>(INLINE_IMAGE_MEDIA_TYPES);
const inlineTextKinds = new Set<FilePreviewKind>(["text", "markdown", "html", "csv", "tsv"]);
const inlineTextTypes = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
]);

/**
 * Classifies an attachment when Sandbox is disabled: only model-supported images and plain text files can be inlined
 * without a workspace. Returns null for binaries (PDF, Office, archives, audio, video).
 */
export function inlineAttachmentKind(file: { name: string; mediaType: string }): "image" | "text" | null {
  const preview = filePreview(file);
  if (preview.kind === "image") {
    return inlineImageTypes.has(preview.mediaType) ? "image" : null;
  }
  if (inlineTextKinds.has(preview.kind)) return "text";
  const mediaType = file.mediaType.toLowerCase().split(";")[0]!.trim();
  if (
    mediaType.startsWith("text/") ||
    inlineTextTypes.has(mediaType) ||
    mediaType.endsWith("+json") ||
    mediaType.endsWith("+xml")
  ) {
    return "text";
  }
  return null;
}
