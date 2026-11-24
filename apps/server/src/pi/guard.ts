// The one way our code creates, forks or reconfigures a conversation, so the approval policy extension is always in the
// selection. Plus an audit that reads every conversation's resolved selection.
import type { Context } from "@earendil-works/chord/context";
import type {
  AgentChange,
  Conversation,
  ConversationCreateOptions,
  ConversationId,
  ConversationRecord,
  Cursor,
  EntryId,
  Extension,
  Harness,
  Page,
  Tx,
} from "@earendil-works/pi-durable";
import { configure } from "@earendil-works/pi-durable";

export interface MissingPolicy {
  id: ConversationId;
  extensions: string[];
}

export interface Guard {
  readonly policy: Extension;
  /** The same change with the policy forced into any extension selection it writes. */
  ensure(change?: AgentChange): AgentChange;
  root(harness: Harness, context: Context, agent?: AgentChange): Promise<Conversation>;
  createConversation(harness: Harness, options: ConversationCreateOptions, context: Context): Promise<Conversation>;
  fork(from: Conversation, at: EntryId, options: ConversationCreateOptions, context: Context): Promise<Conversation>;
  /** For a tool's commit that creates a child conversation: replaces `configure(tx, id, change)`. */
  configure(tx: Tx, id: ConversationId, change: AgentChange): Promise<void>;
  reconfigure(conversation: Conversation, change: AgentChange, context: Context): Promise<void>;
  /** Every conversation whose resolved selection lacks the policy extension. */
  audit(harness: Harness, context: Context): Promise<MissingPolicy[]>;
  /** Puts the policy back into a conversation that lacks it (the host default plus the policy). */
  repair(conversation: Conversation, context: Context): Promise<void>;
}

type Selection = AgentChange["extensions"];

export function createGuard(policy: Extension): Guard {
  const has = (list: readonly Extension[] | undefined) => list?.some((e) => e.name === policy.name) ?? false;

  function ensure(change: AgentChange = {}): AgentChange {
    const selection: Selection = change.extensions;
    // Unset (or null) follows the host default selection, which holds every installed extension with the policy last.
    if (selection === undefined || selection === null) return change;
    if (Array.isArray(selection)) {
      // Last, so the policy sees the arguments the other hooks settled on.
      const list = selection as readonly Extension[];
      return { ...change, extensions: has(list) ? list : [...list, policy] };
    }
    const edit = selection as { add?: readonly Extension[]; remove?: readonly Extension[] };
    return {
      ...change,
      extensions: {
        add: has(edit.add) ? (edit.add ?? []) : [...(edit.add ?? []), policy],
        remove: (edit.remove ?? []).filter((e) => e.name !== policy.name),
      },
    };
  }
  const guardOptions = (options: ConversationCreateOptions): ConversationCreateOptions =>
    options.agent ? { ...options, agent: ensure(options.agent) } : options;

  return {
    policy,
    ensure,
    root: (harness, context, agent = {}) => harness.root(context, { agent: ensure(agent) }),
    createConversation: (harness, options, context) => harness.createConversation(guardOptions(options), context),
    fork: (from, at, options, context) => from.fork(at, guardOptions(options), context),
    configure: (tx, id, change) => configure(tx, id, ensure(change)),
    reconfigure: (conversation, change, context) => conversation.configure(ensure(change), context),
    async audit(harness, context) {
      const bad: MissingPolicy[] = [];
      let cursor: Cursor | undefined;
      do {
        const page: Page<ConversationRecord, Cursor> = await harness.commit(
          (tx) => tx.scanConversations({}, 100, cursor),
          context,
        );
        for (const record of page.items) {
          const conversation = await harness.conversation(record.id, context);
          if (!conversation) continue;
          const agent = await conversation.agent(context);
          if (!agent.extensions.some((e) => e.name === policy.name))
            bad.push({ id: record.id, extensions: agent.extensions.map((e) => e.name) });
        }
        cursor = page.next;
      } while (cursor);
      return bad;
    },
    async repair(conversation, context) {
      // `{ add }` edits the host default selection, so every installed extension is back and the policy is in it.
      await conversation.configure({ extensions: { add: [policy] } }, context);
    },
  };
}
