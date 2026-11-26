import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { arr, lit, obj, opt, str, union } from "@earendil-works/pi-schema";
import type { ImageFailureReason } from "@rei/protocol";
import type { AttachmentRow, AttachmentService } from "../attachments/service.ts";
import { MODEL_ONLY } from "../pi/callers.ts";
import { POLICY_MEMO, policyTool, type ToolCatalog } from "../pi/policy-ext.ts";
import { recordImageUsage } from "../usage/images.ts";
import {
  type ImageReference,
  type ImageWorker,
  ImageWorkerError,
  MAX_PROMPT_LENGTH,
  MAX_REFERENCE_BYTES,
  MAX_REFERENCES,
} from "./worker.ts";

const TOOL = "image_generate";
const DESTINATION = "chatgpt.com";
const INPUT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const PNG_HEADER = [137, 80, 78, 71, 13, 10, 26, 10];
const decoder = new TextDecoder();

function imageFormat(header: Uint8Array): { ext: string; type: string } {
  if (PNG_HEADER.every((value, index) => header[index] === value)) return { ext: "png", type: "image/png" };
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return { ext: "jpg", type: "image/jpeg" };
  if (decoder.decode(header.subarray(0, 4)) === "RIFF" && decoder.decode(header.subarray(8, 12)) === "WEBP")
    return { ext: "webp", type: "image/webp" };
  const gif = decoder.decode(header.subarray(0, 6));
  if (gif === "GIF87a" || gif === "GIF89a") return { ext: "gif", type: "image/gif" };
  throw new Error("Codex returned an unsupported image file.");
}

/**
 * The saved image's file name: the model's short name, or else the prompt's first words, as a slug of letters and
 * digits in any script (so "香港夜景" stays readable). "codex-image" when neither leaves anything.
 */
export function imageFileName(name: string | undefined, prompt: string, ext: string): string {
  const slug = (text: string, words: number, chars: number) =>
    text
      .normalize("NFKC")
      .split(/[^\p{L}\p{M}\p{N}]+/u)
      .filter(Boolean)
      .slice(0, words)
      .join("-")
      .toLowerCase()
      .slice(0, chars)
      .replace(/-+$/, "");
  const base = (name && slug(name, 12, 60)) || slug(prompt, 6, 40) || "codex-image";
  return `${base}.${ext}`;
}

export function createImageExtension(
  treeId: string,
  attachments: AttachmentService,
  catalog: ToolCatalog,
  worker: ImageWorker,
): Extension {
  const store = attachments.store;
  const tool = policyTool(
    catalog,
    {
      actionClass: "send",
      connector: "codex-images",
      operation: "generate",
      approvalOnce: { reason: "Codex receives the prompt and the selected reference images", allowStandard: true },
      destination: () => DESTINATION,
      // Approval binds the prompt and the exact immutable attachment/version references.
      binding: () => DESTINATION,
      summary: ({ references }: { references?: readonly unknown[] }) =>
        references?.length
          ? `Edit an image with Codex using ${references.length} ${references.length === 1 ? "reference image" : "reference images"}`
          : "Generate an image with Codex",
    },
    {
      name: TOOL,
      callers: MODEL_ONLY,
      replay: "unsafe",
      description:
        "Generate an image from a prompt, or edit an existing image by providing reference images from this chat or exact Library versions. The finished image is saved to the Library automatically (do not call publish_files for it) and also appears as a file card under your reply. The result gives its fileId. To show it inside your reply, place it where you want with `![alt](file:<fileId>)`; the alt text is shown as its caption, and images in neighbouring paragraphs sit side by side. Give each image a short descriptive `name` (e.g. hong-kong-night) so the saved files are easy to tell apart.",
      parameters: obj({
        prompt: str({ minLength: 1, maxLength: MAX_PROMPT_LENGTH }),
        name: opt(str({ maxLength: 80 })),
        references: opt(
          arr(
            union([
              obj({ type: lit("attachment"), attachmentId: str() }),
              obj({ type: lit("library"), fileId: str(), versionId: str() }),
            ]),
            { minItems: 1, maxItems: MAX_REFERENCES },
          ),
        ),
      }),
      execute: async (args, api, context) => {
        try {
          const session = store.sessionByConversation(treeId, String(api.conversationId));
          const run = session && store.runningRun(session.id);
          if (!session || !run) throw new Error("No active chat run is available for this image.");
          const prompt = args.prompt.trim();
          if (!prompt) throw new Error("Describe the image you want to generate or edit.");
          const key = `${session.id}:${api.callId}:image`;
          const prior = attachments.library?.published(key);
          if (prior) {
            await store.addFileOutputs(session.id, run.id, [prior]);
            return { output: [{ type: "text", text: JSON.stringify({ file: prior }) }] };
          }
          const checked = await catalog.revalidate(
            treeId,
            TOOL,
            args,
            await api.memo(POLICY_MEMO, context),
            String(api.taskId),
            String(api.conversationId),
            context,
          );
          const rows: AttachmentRow[] = [];
          let total = 0;
          const libraryOff = store.agentCapabilities(session.agent_id).library === "off";
          for (const ref of args.references ?? []) {
            if (ref.type === "library" && libraryOff)
              throw new Error("File Library access is disabled for this agent.");
            const row =
              ref.type === "attachment"
                ? attachments.accessible(ref.attachmentId, session.id)
                : attachments.row(attachments.library?.resolve(ref).id ?? "");
            if (!row || !INPUT_TYPES.has(row.media_type) || row.size <= 0)
              throw new Error("Each reference must be an available PNG, JPEG, WebP or GIF image.");
            total += row.size;
            if (total > MAX_REFERENCE_BYTES) throw new Error("Reference images can total at most 20 MiB.");
            rows.push(row);
          }
          const references: ImageReference[] = [];
          for (const row of rows) {
            context.abortSignal?.throwIfAborted();
            const bytes = await attachments.bytes(row, MAX_REFERENCE_BYTES);
            const { type } = imageFormat(bytes);
            references.push({ type, bytes });
          }
          context.abortSignal?.throwIfAborted();
          checked.assert();
          const started = Date.now();
          const edit = references.length > 0;
          // Usage counters only; a failed counter write must never fail the image. A cancelled request is not counted.
          const count = (failure?: ImageFailureReason) => {
            try {
              recordImageUsage(store.db, Date.now(), {
                edit,
                ms: Date.now() - started,
                ...(failure ? { failure } : {}),
              });
            } catch {
              // the counters are best effort
            }
          };
          let bytes: Uint8Array<ArrayBuffer>;
          try {
            bytes = await worker.generate(prompt, references, context.abortSignal);
          } catch (error) {
            if (!context.abortSignal?.aborted) count(error instanceof ImageWorkerError ? error.reason : "error");
            throw error;
          }
          count();
          context.abortSignal?.throwIfAborted();
          const { ext, type } = imageFormat(bytes);
          const file = await attachments.upload(
            session.id,
            new File([bytes], imageFileName(args.name, prompt, ext), { type }),
            undefined,
            store.getAgent(session.agent_id)?.name ?? "Agent",
            key,
          );
          await store.addFileOutputs(session.id, run.id, [file]);
          return {
            output: [
              {
                type: "text",
                text: JSON.stringify({
                  file,
                  status: "saved_to_library",
                  note: "Already saved to the Library; do not call publish_files. To show it inline, write ![alt](file:<fileId>) in your reply.",
                }),
              },
            ],
          };
        } catch (error) {
          return {
            isError: true,
            output: [{ type: "text", text: error instanceof Error ? error.message : "The image request failed." }],
          };
        }
      },
    },
  );
  return defineExtension({ name: "codex-images", tools: [tool] });
}
