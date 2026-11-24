import type { Attachment, FileReference, LibraryFile, LibraryVersion } from "@rei/protocol";
export const fileContentUrl = (ref: FileReference) =>
  `/api/files/${encodeURIComponent(ref.fileId)}/versions/${encodeURIComponent(ref.versionId)}/content`;
export const libraryHref = (id?: string) => `/library${id ? `/${encodeURIComponent(id)}` : ""}`;
export const versionAttachment = (version: LibraryVersion): Attachment => ({
  id: version.attachmentId,
  name: version.name,
  mediaType: version.mediaType,
  size: version.size,
  fileId: version.fileId,
  versionId: version.versionId,
});
export const libraryAttachment = (file: LibraryFile) => ({ ...versionAttachment(file.current), name: file.name });
export const fileBytes = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KiB`
      : size < 1024 * 1024 * 1024
        ? `${(size / 1024 / 1024).toFixed(1)} MiB`
        : `${(size / 1024 / 1024 / 1024).toFixed(2)} GiB`;
