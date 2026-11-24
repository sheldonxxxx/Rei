import type { ImageFailureReason } from "@rei/protocol";

export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
export const MAX_REFERENCES = 5;
export const MAX_PROMPT_LENGTH = 4000;

/** A failed image request whose cause is known, so Usage can count it by reason. */
export class ImageWorkerError extends Error {
  readonly reason: ImageFailureReason;
  constructor(message: string, reason: ImageFailureReason) {
    super(message);
    this.reason = reason;
  }
}

export interface ImageReference {
  type: string;
  bytes: Uint8Array;
}

export interface ImageWorker {
  generate(prompt: string, references: ImageReference[], signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
}
