// Keeps the request prefix byte-identical between the model calls of one run, so the provider's prompt cache holds.

type Message = { role?: unknown; timestamp?: unknown; content?: unknown };
type SystemMessage = Message & { sections?: unknown; toolsAdded?: unknown; toolsRemoved?: unknown };

/** A message's identity across calls: its role and time, and a digest of everything in it. */
interface MessageKey {
  role: unknown;
  timestamp: unknown;
  digest: string;
}

interface RunState {
  /** The first conversation message the home window kept on this run's first call. */
  windowStart?: MessageKey;
  /**
   * The system messages the run's first call carried: the leading one (the baseline) and every one, as digests. Later
   * ones are mid-run updates.
   */
  systems?: { baseline: string; known: Set<string> };
}

const RUNS_KEPT = 256;

/** FNV-1a (two 32-bit lanes) and the length of the message's JSON: synchronous and portable, ample for one run. */
function digest(message: unknown): string {
  const text = JSON.stringify(message) ?? "";
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return `${text.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}

const keyOf = (message: Message): MessageKey => ({
  role: message.role,
  timestamp: message.timestamp,
  digest: digest(message),
});

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
      : "";

const nonEmpty = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

/** A system message that only replaces prompt sections: no instruction text and no tool change. */
function sectionsOnly(message: SystemMessage): boolean {
  return (
    message.role === "system" &&
    textOf(message.content).trim() === "" &&
    !nonEmpty(message.toolsAdded) &&
    !nonEmpty(message.toolsRemoved)
  );
}

/**
 * Per-run state that keeps one run's model calls on a stable prefix. Two things moved it within a run:
 *
 * - The home window (`homeMessages`) dropped older turns whenever the estimate passed its budget, so a single large
 *   call, such as a failed one with a long body, rewrote the start of the request mid-run. The window start is now
 *   chosen on a run's first call and held for the rest of it (`windowStart`).
 * - A prompt section that changed mid-run (the knowledge pointer after a write) is a `pi.system` entry. Providers
 *   without mid-conversation system messages fold every system message into the leading one, so the change rewrote
 *   the first message of the request. Such section updates are held back until the next run (`deferSectionUpdates`).
 *
 * The state lives in memory only. After a restart a run starts over as if on its first call.
 */
export class RunPins {
  readonly #runs = new Map<string, RunState>();

  #state(runId: string): RunState {
    let state = this.#runs.get(runId);
    if (state) {
      // Most recently used last, so the oldest run is the one dropped.
      this.#runs.delete(runId);
    } else {
      state = {};
    }
    this.#runs.set(runId, state);
    if (this.#runs.size > RUNS_KEPT) this.#runs.delete(this.#runs.keys().next().value!);
    return state;
  }

  /** The index in `messages` of the window start pinned for this run, or undefined when none is pinned or found. */
  windowStart(runId: string, messages: readonly Message[]): number | undefined {
    const pinned = this.#runs.get(runId)?.windowStart;
    if (!pinned) return undefined;
    const index = messages.findIndex(
      (m) => m.role === pinned.role && m.timestamp === pinned.timestamp && digest(m) === pinned.digest,
    );
    return index >= 0 ? index : undefined;
  }

  pinWindowStart(runId: string, message: Message): void {
    this.#state(runId).windowStart = keyOf(message);
  }

  /**
   * The messages without section-only system messages that appeared after the run's first call. The next run's first
   * call carries them. The leading system message always stays, and so do messages with instruction text or tool
   * changes: they change the request either way. A different leading message (another conversation's call, or a
   * compaction that rendered a new one) starts the record over and drops nothing.
   */
  deferSectionUpdates<T>(runId: string, messages: T[]): T[] {
    const state = this.#state(runId);
    const systems = (messages as Message[]).filter((m) => m.role === "system");
    const [lead, ...rest] = systems;
    if (!lead) return messages;
    const baseline = digest(lead);
    if (state.systems?.baseline !== baseline) {
      state.systems = { baseline, known: new Set([baseline, ...rest.map(digest)]) };
      return messages;
    }
    const known = state.systems.known;
    const late = new Set(rest.filter((m) => sectionsOnly(m) && !known.has(digest(m))));
    return late.size === 0 ? messages : messages.filter((m) => !late.has(m as Message));
  }
}
