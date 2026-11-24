/** A reference always pins immutable bytes, independently of the file's current version. */
export interface FileReference {
  fileId: string;
  versionId: string;
  location?: { sheet?: string; cell?: string; slide?: number; page?: number };
}
export interface LibraryVersion extends FileReference {
  attachmentId: string;
  number: number;
  name: string;
  mediaType: string;
  size: number;
  createdAt: number;
  creator: string;
}
export interface LibraryFile {
  id: string;
  name: string;
  origin: "upload" | "agent";
  creator: string;
  createdAt: number;
  updatedAt: number;
  folderId: string | null;
  favorite: boolean;
  trashedAt: number | null;
  current: LibraryVersion;
}
export interface LibraryFolder {
  id: string;
  name: string;
  parentId: string | null;
}
export interface LibraryDetail {
  folder?: LibraryFolder | null;
  file: LibraryFile;
  versions: LibraryVersion[];
  chats: { id: string; title: string }[];
}
export interface LibraryList {
  files: LibraryFile[];
  folders: LibraryFolder[];
  nextCursor: string | null;
}
