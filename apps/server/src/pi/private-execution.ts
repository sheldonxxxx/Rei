import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Conversation, ConversationId, EntryId, Extension } from "@earendil-works/pi-durable";
import {
  createRegistry,
  defineExtension,
  GenerationTask,
  Harness,
  hook,
  ProviderDoc,
} from "@earendil-works/pi-durable";
import { createGuard } from "./guard.ts";
import type { PiStorageOpener } from "./types.ts";

export interface PrivateSnapshots {
  create(treeId: string, executionId: string, signal: AbortSignal): Promise<{ path: string; dispose(): Promise<void> }>;
  sweep(): Promise<void>;
}
export interface PrivateExecution {
  sourceTree: string;
  sourceConversation: string;
  cut: string;
  id: string;
  model: { provider: string; modelId: string };
  instructions: string;
  input: string;
  extensions: Extension[];
  policy: Extension;
  models: Models;
  signal: AbortSignal;
  prepare(fork: Conversation, providerSessionId: string): Promise<string>;
  allowedTools: readonly string[];
}
/** Native conversation execution with disposable persistence and no attachment to product sessions. */
export async function executePrivateFork(
  snapshots: PrivateSnapshots,
  openStorage: PiStorageOpener,
  input: PrivateExecution,
): Promise<void> {
  const runContext = withAbortSignal(input.signal, context);
  const snapshot = await snapshots.create(input.sourceTree, input.id, input.signal);
  let harness: Harness | undefined;
  let aborted: (() => void) | undefined;
  try {
    input.signal.throwIfAborted();
    const registry = createRegistry();
    for (const extension of [...input.extensions, input.policy]) registry.install(extension);
    harness = await Harness.open(
      await openStorage(snapshot.path),
      { models: input.models, registry, settings: { retry: { enabled: false }, compaction: { backgroundTokens: 0 } } },
      runContext,
    );
    const inspection = await harness.inspect(runContext);
    if (inspection.scheduling !== "paused") throw new Error("SNAPSHOT_SCHEDULER_ACTIVE");
    for (const submission of inspection.submissions) await harness.abortSubmission(submission.id, runContext);
    for (const task of inspection.tasks) await harness.abortTask(task.record.id, runContext);
    // Drain descendants before their owners. Missing task definitions can be orphaned only after owned work ends.
    for (const task of [...inspection.tasks].sort((a, b) => Number(b.record.id) - Number(a.record.id))) {
      await harness.abortTask(task.record.id, runContext);
      await harness.waitForTask(task.record.id, runContext);
    }
    // Only abort handlers of registered core tasks can run; review-only models must reject unbound calls.
    await harness.waitForIdle(runContext);
    if ((await harness.inspect(runContext)).tasks.length) throw new Error("SNAPSHOT_TASKS_REMAIN");
    input.signal.throwIfAborted();
    const source = await harness.conversation(Number(input.sourceConversation) as ConversationId, runContext);
    if (!source) throw new Error("SOURCE_CONVERSATION_MISSING");
    const provider = await source.commit(async (tx) => (await tx.doc(ProviderDoc, source.id)).sessionId, runContext);
    const cache = defineExtension({
      name: "private_cache",
      hooks: [
        hook(GenerationTask, {
          beforeRequest(request) {
            return {
              messages: request.messages.map((message) =>
                message.role !== "system"
                  ? message
                  : {
                      ...message,
                      toolsAdded: message.toolsAdded?.filter((tool) => input.allowedTools.includes(tool.name)),
                      toolsRemoved: message.toolsRemoved?.filter((tool) => input.allowedTools.includes(tool.name)),
                    },
              ),
            };
          },
          beforeProviderRequest(request) {
            if (!request.model.api.startsWith("openai-") || !request.payload || typeof request.payload !== "object")
              return;
            return { payload: { ...request.payload, prompt_cache_key: provider } };
          },
        }),
      ],
    });
    registry.install(cache);
    const fork = await createGuard(input.policy).fork(
      source,
      Number(input.cut) as EntryId,
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: input.model,
          instructions: input.instructions,
          extensions: [...input.extensions, cache, input.policy],
          thinkingLevel: "off",
          maxTurns: 4,
        },
      },
      runContext,
    );
    const privateProvider = await fork.commit(async (tx) => (await tx.doc(ProviderDoc, fork.id)).sessionId, runContext);
    const preparedInput = await input.prepare(fork, privateProvider);
    aborted = () => {
      void fork.abort(context, { background: true }).catch(() => undefined);
    };
    input.signal.addEventListener("abort", aborted, { once: true });
    input.signal.throwIfAborted();
    await (await fork.submit({ type: "input", content: preparedInput }, runContext)).wait(runContext);
    input.signal.throwIfAborted();
  } finally {
    if (aborted) input.signal.removeEventListener("abort", aborted);
    try {
      await harness?.close(context);
    } finally {
      await snapshot.dispose();
    }
  }
}
