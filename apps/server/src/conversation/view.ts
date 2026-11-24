// The Conversation View of a session, read from Pi on request (GET, transcript pages) and pushed to watchers as one
// snapshot, then patches (the session stream). Every read goes to Pi's committed state; nothing here is a second copy of
// the transcript. A watcher hub per session recomputes the newest window when Pi commits to the conversation, or when
// Rei changes something the view shows (a card, a settlement), and sends what changed.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryRecord, InboxState, LiveState, Observation } from "@earendil-works/pi-durable";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import type {
  Attachment,
  ChatItem,
  ReiConversationViewV2,
  Session,
  SessionEvent,
  SessionPatch,
  SurfaceDetailResponse,
} from "@rei/protocol";
import type { OpenTree, TreeManager, TreeSession } from "../pi/trees.ts";
import { sessionStream } from "../store/events.ts";
import type { AppStore } from "../store/store.ts";
import { detailOf, SurfacesDoc, type SurfacesState } from "../surfaces/model.ts";
import { badRequest, notFound } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";
import { activeVersion, type BranchRow, chainOf, versionsByCut } from "./branches.ts";
import { type InputData, isInputData } from "./ledger.ts";
import type { RunRow } from "./runs.ts";
import { buildView, type OverlayRow, type ViewModel } from "./view-model.ts";

const context = BACKGROUND_CONTEXT;

/** Entries of the newest window (and of a transcript page) unless asked otherwise. */
export const DEFAULT_WINDOW = 100;
export const MAX_WINDOW = 500;
/**
 * The least time between two patches for live text. Text after a quiet spell goes out at once; text that follows within
 * this time is gathered into the next patch. Other changes (a run's status, an entry, an overlay) go out at once.
 */
const COALESCE_MS = 30;

/** What a window reads from Pi. */
interface PiRead {
  entries: EntryRecord[];
  before: EntryRecord | undefined;
  live: LiveState;
  inbox: InboxState;
  surfaces: SurfacesState;
}

export interface ViewDeps {
  store: AppStore;
  trees: TreeManager;
  log: Logger;
}

/** An entry that continues an input above it (a reply or a tool result): a window does not start with one. */
const continues = (entry: EntryRecord): boolean => {
  const role = entry.model?.[0]?.role;
  return (
    entry.kind === "pi.assistant" || role === "assistant" || role === "toolResult" || entry.kind === "pi.toolResult"
  );
};

/** `e:<id>` (or a bare entry id) as an entry id. */
function entryOf(cursor: string): number {
  const raw = cursor.startsWith("e:") ? cursor.slice(2) : cursor;
  if (!/^\d+$/.test(raw)) throw badRequest("bad_cursor", "That page cursor is not valid.");
  return Number(raw);
}

interface Hub {
  sessionId: string;
  conversationId: string | null;
  epoch: string;
  rev: number;
  listeners: Set<(event: SessionEvent) => void>;
  last: ReiConversationViewV2 | undefined;
  observation: Observation<unknown> | undefined;
  live: LiveState | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** When the last recompute was scheduled to run (performance.now()). */
  lastAt: number;
  /** What the last recompute read from Pi, reused while only live text changes. */
  piRead: PiRead | undefined;
  /** Something other than live text changed since the last recompute read Pi. */
  stale: boolean;
  /** The newest entry and Pi's other documents as the observation last saw them. */
  piKey: string | undefined;
  running: Promise<void>;
  unsubscribe: () => void;
  forkSource?: { conversationId: string; hidden: boolean };
}

export class ViewService {
  readonly #d: ViewDeps;
  readonly #hubs = new Map<string, Hub>();

  constructor(deps: ViewDeps) {
    this.#d = deps;
  }

  async #open(sessionId: string): Promise<{ tree: OpenTree; ts: TreeSession }> {
    const row = this.#d.store.getSessionRow(sessionId);
    if (!row) throw notFound("That session does not exist.");
    const tree = await this.#d.trees.open(row.tree_id);
    const ts = tree.session(sessionId);
    if (!ts) throw notFound("That session does not exist.");
    return { tree, ts };
  }

  /**
   * One window of the transcript, oldest first: the newest `limit` entries, or those up to and including `before`
   * (`e:<id>`), widened backwards so it never starts in the middle of a reply. `newest` adds queued inputs and cards.
   */
  async view(
    sessionId: string,
    options: {
      before?: string;
      limit?: number;
      live?: LiveState;
      /** The newest window's Pi reads from the last call, when only live text changed since (the session stream). */
      reuse?: PiRead;
      onRead?: (read: PiRead) => void;
    } = {},
  ): Promise<ViewModel & { newest: boolean }> {
    const { store } = this.#d;
    const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_WINDOW), MAX_WINDOW);
    const max = options.before !== undefined ? entryOf(options.before) : undefined;
    const { ts } = await this.#open(sessionId);
    const row = store.getSessionRow(sessionId);
    if (!row) throw notFound("That session does not exist.");
    const read: PiRead = options.reuse && max === undefined ? options.reuse : await this.#readPi(ts, limit, max);
    options.onRead?.(read);
    const { entries, before, live, inbox, surfaces } = read;
    const newest = max === undefined;
    const runs = new Map<string, RunRow>();
    for (const run of store.runs.forSession(sessionId)) runs.set(run.id, run);
    const queued = new Map<string, InputData>();
    for (const item of inbox.items ?? []) {
      const data = (item.entry as { data?: unknown } | undefined)?.data;
      if (isInputData(data)) queued.set(data.runId, data);
    }
    // Inputs Pi has no entry for (staging failed) are written as data-only entries; queued admissions wait in the outbox.
    const files = new Map<string, Attachment[]>();
    const ledger = ts.sync.ledger;
    const branches = store.branchesOf(sessionId);
    for (const [runId, list] of Object.entries(ledger.inherited ?? {})) files.set(runId, list);
    for (const [runId, record] of Object.entries(ledger.byId)) if (record.files?.length) files.set(runId, record.files);
    const openRequest = store.manualCompactions.open(sessionId).at(-1);
    const manual = openRequest
      ? {
          requestId: openRequest.request_id,
          status: openRequest.status,
          ...(openRequest.error_message ? { error: openRequest.error_message } : {}),
        }
      : undefined;
    const model = buildView({
      sessionId,
      origin: row.origin,
      entries,
      before: before !== undefined ? String(before.id) : undefined,
      live: options.live ?? live,
      inbox,
      runs,
      order: ledger.order,
      queued,
      files,
      overlays: activeOverlays(store.overlaysFor(sessionId), runs, branches.length > 0),
      surfaces,
      ...(manual ? { manualCompaction: manual } : {}),
      newest,
    });
    if (branches.length) addVersions(model.items, entries, before, branches, String(ts.conv.id));
    return { ...model, newest };
  }

  /** The Pi side of a window: its entries (widened to whole replies), the entry before it, and the live and inbox state. */
  async #readPi(ts: TreeSession, limit: number, max: number | undefined): Promise<PiRead> {
    const page = await ts.conv.entries(
      { order: "descending", ...(max !== undefined ? { maxEntryId: max as never } : {}) },
      limit + 1,
      undefined,
      context,
    );
    let desc = [...page.items];
    let before: EntryRecord | undefined = desc.length > limit ? desc[limit] : undefined;
    desc = desc.slice(0, limit);
    // Widen to the input a top reply belongs to (bounded, so a huge tool loop cannot make a page unbounded).
    for (
      let extra = 0;
      before !== undefined && desc.length > 0 && continues(desc.at(-1)!) && extra < 2_000;
      extra += 50
    ) {
      const more = await ts.conv.entries(
        { order: "descending", maxEntryId: Number(before.id) as never },
        51,
        undefined,
        context,
      );
      const got = more.items.slice(0, 50);
      before = more.items.length > 50 ? more.items[50] : undefined;
      desc.push(...got);
      if (got.length === 0) break;
    }
    const entries = desc.reverse();
    const { live, inbox, surfaces } = await ts.conv.commit(
      async (tx) => ({
        live: JSON.parse(JSON.stringify(await tx.doc(LiveDoc, ts.conv.id))) as LiveState,
        inbox: JSON.parse(JSON.stringify(await tx.doc(InboxDoc, ts.conv.id))) as InboxState,
        surfaces: JSON.parse(JSON.stringify(await tx.doc(SurfacesDoc, ts.conv.id))) as SurfacesState,
      }),
      context,
    );
    return { entries, before, live, inbox, surfaces };
  }

  /** The newest view in the stream's shape. */
  async snapshot(
    sessionId: string,
    live?: LiveState,
    reuse?: PiRead,
    onRead?: (read: PiRead) => void,
  ): Promise<ReiConversationViewV2> {
    const session = this.#d.store.getSession(sessionId);
    if (!session) throw notFound("That session does not exist.");
    const model = await this.view(sessionId, {
      ...(live ? { live } : {}),
      ...(reuse ? { reuse } : {}),
      ...(onRead ? { onRead } : {}),
    });
    return {
      version: 2,
      session: await this.withForkSource(session, this.#hubs.get(sessionId)),
      items: model.items,
      runs: model.runs,
      before: model.before,
      live: model.live,
      overlays: model.overlays,
    };
  }

  /** A link into a fork's source transcript is meaningful only while the source message is visible. */
  async withForkSource(session: Session, hub?: Hub): Promise<Session> {
    const from = session.forkedFrom;
    if (!from) return session;
    const store = this.#d.store;
    const source = store.getSessionRow(from.sessionId);
    const conversationId = source?.pi_conversation_id;
    if (!conversationId) return session;
    let cached = hub?.forkSource;
    if (cached?.conversationId !== conversationId) {
      let hidden: boolean;
      try {
        hidden =
          store.branchesOf(from.sessionId).length > 0 &&
          (await this.findItem(from.sessionId, from.messageId)) === undefined;
      } catch (error) {
        if (!store.getSessionRow(from.sessionId)) return session;
        throw error;
      }
      cached = { conversationId, hidden };
      if (hub) hub.forkSource = cached;
    }
    return cached.hidden ? { ...session, forkedFrom: { ...from, onAnotherVersion: true } } : session;
  }

  /** A source swap can change the header of an open fork. */
  refreshForkSources(sourceId: string): void {
    for (const hub of this.#hubs.values()) {
      const row = this.#d.store.getSessionRow(hub.sessionId);
      if (row?.forked_from_session_id === sourceId) this.#schedule(hub);
    }
  }

  /**
   * An item of the session's transcript by id, looked for in the newest window and then page by page back (Edit, fork,
   * a component press name items the client has shown).
   */
  /** One surface with its revisions, actions and failures (the Inspector), as this session sees it. */
  async surfaceDetail(sessionId: string, surfaceId: string): Promise<SurfaceDetailResponse> {
    const { ts } = await this.#open(sessionId);
    const state = await ts.conv.commit(
      async (tx) => JSON.parse(JSON.stringify(await tx.doc(SurfacesDoc, ts.conv.id))) as SurfacesState,
      context,
    );
    const record = state.surfaces[surfaceId];
    if (!record) throw notFound("That surface does not exist.");
    return detailOf(state, record, sessionId);
  }

  /** Opens the session's tree (its runs are then in the registry). */
  async ensureOpen(sessionId: string): Promise<void> {
    await this.#open(sessionId);
  }

  async findItem(sessionId: string, itemId: string): Promise<ChatItem | undefined> {
    const found = await this.around(sessionId, itemId);
    return found?.items[found.at];
  }

  /** The page of items an item is on, and where (history context reads its neighbours). */
  around(
    sessionId: string,
    itemId: string,
  ): Promise<{ items: ChatItem[]; at: number; before: string | null } | undefined> {
    return this.#page(sessionId, (i) => i.id === itemId);
  }

  /** The newest item that matches, looked for page by page back. */
  async findWhere(sessionId: string, match: (item: ChatItem) => boolean): Promise<ChatItem | undefined> {
    const found = await this.#page(sessionId, match, true);
    return found?.items[found.at];
  }

  async #page(
    sessionId: string,
    match: (item: ChatItem) => boolean,
    newest = false,
  ): Promise<{ items: ChatItem[]; at: number; before: string | null } | undefined> {
    let before: string | undefined;
    for (let pages = 0; pages < 50; pages++) {
      const model = await this.view(sessionId, { ...(before !== undefined ? { before } : {}), limit: MAX_WINDOW });
      const at = newest ? model.items.findLastIndex(match) : model.items.findIndex(match);
      if (at >= 0) return { items: model.items, at, before: model.before };
      if (model.before === null) return undefined;
      before = model.before;
    }
    return undefined;
  }

  /** Whether any item before the given entry is an input (Edit of a chat's first message starts a fresh chat instead). */
  async inputBefore(sessionId: string, entryId: number): Promise<{ before: EntryRecord | undefined; input: boolean }> {
    const { ts } = await this.#open(sessionId);
    if (entryId <= 1) return { before: undefined, input: false };
    let cursor: number | undefined = entryId - 1;
    let before: EntryRecord | undefined;
    for (let scanned = 0; cursor !== undefined && scanned < 5_000; scanned += 200) {
      const page = await ts.conv.entries({ order: "descending", maxEntryId: cursor as never }, 200, undefined, context);
      if (page.items.length === 0) break;
      before ??= page.items[0];
      for (const entry of page.items)
        if (isInputData(entry.data) || entry.kind === "pi.user" || entry.kind === "rei.report")
          return { before, input: true };
      const oldest = page.items.at(-1)!;
      cursor = Number(oldest.id) > 1 ? Number(oldest.id) - 1 : undefined;
    }
    return { before, input: false };
  }

  // ---- watchers (the session stream) ----------------------------------------------------------------------------

  /** Watches a session's view: a snapshot first, then patches; `session.removed` when it is deleted. */
  async subscribe(sessionId: string, listener: (event: SessionEvent) => void): Promise<() => void> {
    const hub = this.#hub(sessionId);
    hub.listeners.add(listener);
    const done = () => {
      hub.listeners.delete(listener);
      if (hub.listeners.size === 0) this.#dropHub(hub);
    };
    try {
      await hub.running;
      if (!hub.last) await this.#recompute(hub);
      if (hub.last) listener({ type: "snapshot", epoch: hub.epoch, rev: hub.rev, view: hub.last });
    } catch (error) {
      done();
      throw error;
    }
    return done;
  }

  /** How many clients watch a session's view (diagnostics, tests). */
  watchers(sessionId: string): number {
    return this.#hubs.get(sessionId)?.listeners.size ?? 0;
  }

  #hub(sessionId: string): Hub {
    const hub = this.#hubs.get(sessionId);
    if (hub) return hub;
    const created: Hub = {
      sessionId,
      conversationId: null,
      epoch: globalThis.crypto.randomUUID(),
      rev: 0,
      listeners: new Set(),
      last: undefined,
      observation: undefined,
      live: undefined,
      timer: undefined,
      lastAt: Number.NEGATIVE_INFINITY,
      piRead: undefined,
      stale: true,
      piKey: undefined,
      running: Promise.resolve(),
      unsubscribe: () => undefined,
    };
    created.unsubscribe = this.#d.store.events.subscribe(sessionStream(sessionId), (event) => {
      if (event.type === "session.removed") {
        for (const fn of [...created.listeners]) fn({ type: "session.removed", sessionId });
        this.#dropHub(created);
        return;
      }
      created.stale = true;
      this.#schedule(created);
    });
    this.#hubs.set(sessionId, created);
    return created;
  }

  #dropHub(hub: Hub): void {
    if (this.#hubs.get(hub.sessionId) !== hub) return;
    this.#hubs.delete(hub.sessionId);
    hub.unsubscribe();
    hub.observation?.detach();
    hub.observation = undefined;
    if (hub.timer !== undefined) clearTimeout(hub.timer);
  }

  /** Watches the conversation itself (Pi commits and live partials), while its tree is open. */
  async #attach(hub: Hub): Promise<void> {
    if (hub.observation) return;
    const row = this.#d.store.getSessionRow(hub.sessionId);
    const tree = row ? this.#d.trees.get(row.tree_id) : undefined;
    const ts = tree?.session(hub.sessionId);
    if (!tree || !ts) return;
    let observation: Observation<unknown> | undefined;
    observation = await tree.harness.observeConversation(
      ts.conv.id,
      {
        advance: (call) => {
          // A watch of a conversation the session no longer shows (a rewind or a version switch swapped it out).
          if (tree.session(hub.sessionId) !== ts) return;
          if (call.kind !== "value") return;
          const { "pi.live": live, ...rest } = call.value.docs;
          hub.live = live as LiveState | undefined;
          const key = `${call.value.entries.at(-1)?.id ?? ""}|${JSON.stringify(rest)}`;
          const textOnly = key === hub.piKey;
          hub.piKey = key;
          if (!textOnly) hub.stale = true;
          this.#schedule(hub, textOnly);
        },
        end: () => {
          if (observation === undefined || hub.observation !== observation) return;
          hub.observation = undefined;
          hub.live = undefined;
        },
      },
      context,
      { min: 1, max: 2 },
    );
    // Swapped while the watch was being set up: the next recompute watches the session's conversation instead.
    if (tree.session(hub.sessionId) !== ts || this.#hubs.get(hub.sessionId) !== hub) {
      observation.detach();
      return;
    }
    hub.observation = observation;
  }

  /**
   * The session's conversation was swapped (a rewind or a version switch): every watcher gets a full replacement view of
   * the new one, as a fresh snapshot of a new epoch, and then patches against it. Resolves once the snapshot is sent.
   */
  async rebind(sessionId: string): Promise<void> {
    const hub = this.#hubs.get(sessionId);
    if (!hub) return;
    const run = async () => {
      if (this.#hubs.get(sessionId) !== hub) return;
      hub.observation?.detach();
      hub.observation = undefined;
      hub.live = undefined;
      hub.piRead = undefined;
      hub.piKey = undefined;
      hub.stale = true;
      hub.epoch = globalThis.crypto.randomUUID();
      hub.rev = 0;
      hub.last = undefined;
      await this.#recompute(hub);
      if (hub.last)
        for (const fn of [...hub.listeners]) fn({ type: "snapshot", epoch: hub.epoch, rev: 0, view: hub.last });
    };
    const next = hub.running.then(run);
    hub.running = next.catch(() => undefined);
    await hub.running;
  }

  #schedule(hub: Hub, liveText = false): void {
    if (this.#hubs.get(hub.sessionId) !== hub) return;
    const wait = liveText ? Math.max(0, hub.lastAt + COALESCE_MS - performance.now()) : 0;
    if (hub.timer !== undefined) {
      if (wait > 0) return;
      clearTimeout(hub.timer);
    }
    hub.timer = setTimeout(() => {
      hub.timer = undefined;
      hub.lastAt = performance.now();
      hub.running = hub.running.then(() => this.#recompute(hub)).catch(() => undefined);
    }, wait);
  }

  async #recompute(hub: Hub): Promise<void> {
    if (this.#hubs.get(hub.sessionId) !== hub) return;
    const store = this.#d.store;
    const row = store.getSessionRow(hub.sessionId);
    if (!row) return;
    // A store event from admission or settlement can arrive during a swap. The next view of that
    // conversation must start with rebind's snapshot, even if a recompute was already in progress.
    if (hub.last && hub.conversationId !== row.pi_conversation_id) return;
    let next: ReiConversationViewV2;
    try {
      await this.#attach(hub);
      const reuse = hub.stale ? undefined : hub.piRead;
      hub.stale = false;
      next = await this.snapshot(hub.sessionId, hub.live, reuse, (read) => {
        hub.piRead = read;
      });
    } catch (error) {
      if (store.getSessionRow(hub.sessionId)?.pi_conversation_id !== row.pi_conversation_id) return;
      this.#d.log.warn("view.recompute_failed", { error: error instanceof Error ? error.name : "error" });
      if (hub.last) {
        // The view could not be read: clients start over with a fresh snapshot when they reconnect.
        hub.rev++;
        for (const fn of [...hub.listeners]) fn({ type: "resync_required", epoch: hub.epoch, rev: hub.rev });
        hub.last = undefined;
      }
      return;
    }
    const current = store.getSessionRow(hub.sessionId);
    if (!current || (hub.last && current.pi_conversation_id !== row.pi_conversation_id)) return;
    const previous = hub.last;
    hub.conversationId = current.pi_conversation_id;
    hub.last = next;
    if (!previous) return;
    const patch = diffViews(previous, next);
    if (!patch) return;
    hub.rev++;
    const frame: SessionPatch = { type: "patch", epoch: hub.epoch, rev: hub.rev, ...patch };
    for (const fn of [...hub.listeners]) fn(frame);
  }
}

/** Connect a user item to the group cut just before its entry. The first input is a null cut. */
function addVersions(
  items: ChatItem[],
  entries: readonly EntryRecord[],
  before: EntryRecord | undefined,
  branches: readonly BranchRow[],
  active: string,
): void {
  const groups = versionsByCut(branches);
  const chain = chainOf(branches, active);
  const replaced = new Map(branches.map((r) => [r.replaced_message_id, r.cut_entry_id]));
  const cuts = new Map<string, string | null>();
  let previous = before ? String(before.id) : null;
  let hasInput = before !== undefined;
  for (const entry of entries) {
    const id = String(entry.id);
    if (isInputData(entry.data) || entry.kind === "pi.user" || entry.kind === "rei.report") {
      cuts.set(id, hasInput ? previous : null);
      hasInput = true;
    }
    previous = id;
  }
  for (const item of items) {
    if (item.role !== "user" || item.entryId === undefined) continue;
    const cut = replaced.has(item.id) ? replaced.get(item.id) : cuts.get(item.entryId);
    const versions = cut === undefined ? undefined : groups.get(cut);
    if (versions) item.versions = { index: activeVersion(versions, chain), count: versions.length };
  }
}

/**
 * The cards a session shows: in a chat with message versions, only those of runs on the active version (the others
 * belong to a version that is not shown). Cards without a run (a side chat's copy of its approval) always show.
 */
export function activeOverlays(
  rows: readonly OverlayRow[],
  runs: ReadonlyMap<string, RunRow>,
  versioned: boolean,
): readonly OverlayRow[] {
  return versioned ? rows.filter((r) => r.run_id === null || runs.has(r.run_id)) : rows;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What changed between two views of the same session, as a patch body; undefined when nothing did. */
export function diffViews(
  a: ReiConversationViewV2,
  b: ReiConversationViewV2,
): Omit<SessionPatch, "type" | "epoch" | "rev"> | undefined {
  const out: Omit<SessionPatch, "type" | "epoch" | "rev"> = {};
  const before = new Map(a.items.map((i) => [i.id, i]));
  const after = new Set(b.items.map((i) => i.id));
  const upsert = b.items.filter((i) => !same(before.get(i.id), i));
  const remove = a.items.filter((i) => !after.has(i.id)).map((i) => i.id);
  if (upsert.length) out.upsert = upsert;
  if (remove.length) out.remove = remove;
  const orderA = a.items.map((i) => i.id).filter((id) => after.has(id));
  const orderB = b.items.map((i) => i.id).filter((id) => before.has(id));
  const appendedOnly = same(orderA, orderB) && b.items.slice(0, orderA.length).every((i, n) => i.id === orderA[n]);
  if (!appendedOnly) out.order = b.items.map((i) => i.id);
  if (!same(a.runs, b.runs)) out.runs = b.runs;
  if (!same(a.live, b.live)) out.live = b.live;
  if (!same(a.overlays, b.overlays)) out.overlays = b.overlays;
  if (!same(a.session, b.session)) out.session = b.session;
  if (a.before !== b.before) out.before = b.before;
  return Object.keys(out).length > 0 ? out : undefined;
}
