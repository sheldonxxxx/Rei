import type { Context } from "@earendil-works/chord/context";
import type { ToolCall } from "@earendil-works/pi-ai";
import { AssistantEntry, type HookApi, LiveDoc } from "@earendil-works/pi-durable";

export const APPROVAL_CHECKPOINT_MEMO = "rei:approval-checkpoint";

/** Read the committed assistant entry that owns the current tool tasks. Unoffered tools cannot acquire approval. */
export async function approvalRound(callId: string, api: HookApi, context: Context) {
  const tools = (await api.snapshot(LiveDoc, api.conversationId, context))?.tools;
  if (!tools?.length || tools.length > 64 || tools.some((tool) => tool.unoffered)) return;
  if (!tools.some((tool) => tool.callId === callId && tool.taskId === api.taskId)) return;
  const entries = await api.entries({}, tools.length + 1, undefined, context);
  const entry = entries.items.find((entry) => entry.kind === AssistantEntry.kind);
  const assistant = entry?.model?.find((message) => message.role === "assistant");
  const calls = assistant?.content.filter((part): part is ToolCall => part.type === "toolCall");
  if (!entry || calls?.length !== tools.length || !calls.every((call, i) => call.id === tools[i]!.callId)) return;
  if (new Set(calls.map((call) => call.id)).size !== calls.length) return;
  return { entryId: entry.id, calls };
}
