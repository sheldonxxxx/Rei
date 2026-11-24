import type { Attachment, MessageMention, MessageSkill } from "@rei/protocol";

export interface DraftFile {
  library?: boolean;
  key: string;
  file: File;
  status: "uploading" | "ready" | "failed" | "rejected";
  attachment?: Attachment;
  error?: string;
  pastedText?: string;
}
/** A skill chip in the draft: pinned to the version seen at the draft's latest refresh. */
export interface DraftSkill extends MessageSkill {
  /** The agent can no longer use it (found on restore): the chip stays so the user can see and remove it. */
  unavailable?: boolean;
}
export interface ComposerDraft {
  text: string;
  mentions: MessageMention[];
  files: DraftFile[];
  /** Chips for the next message only; absent in drafts saved before skills could be chosen. */
  selectedSkills?: DraftSkill[];
}
let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  if (!database)
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open("rei-composer", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("drafts");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  return database;
}
export async function loadComposerDraft(sessionId: string): Promise<ComposerDraft | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction("drafts").objectStore("drafts").get(sessionId);
    request.onsuccess = () => resolve(request.result as ComposerDraft | undefined);
    request.onerror = () => reject(request.error);
  });
}
export async function saveComposerDraft(sessionId: string, draft: ComposerDraft): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("drafts", "readwrite");
    const store = transaction.objectStore("drafts");
    if (draft.text || draft.files.length || draft.mentions.length || draft.selectedSkills?.length)
      store.put(draft, sessionId);
    else store.delete(sessionId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
