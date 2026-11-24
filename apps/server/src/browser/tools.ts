// The "browser" extension drives the session's own window of the agent computer's Chromium. Each tool is
// declared in the tool catalog like every other tool (D28). Clicks and key presses are not judged (the user lets the
// agent into a site and trusts it there); a session that holds private data decides opening a page and typing as sends,
// as web_fetch does. The tools that can be a send are fail closed: they run only when the hook let that exact call through.

import type { Context } from "@earendil-works/chord/context";
import type { Extension } from "@earendil-works/pi-durable";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { arr, bool, int, lit, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import type { ActionClass, TaintLabel } from "@rei/protocol";
import type { WorkspaceManager } from "../exec/workspaces.ts";
import type { LibraryService } from "../library/service.ts";
import { MODEL_AND_SCRIPTS, MODEL_ONLY } from "../pi/callers.ts";
import { POLICY_MEMO, policyTool, type ToolCatalog, type ToolPolicy } from "../pi/policy-ext.ts";
import { TakeoverEnded } from "../pi/signals.ts";
import { canonicalJson } from "../policy/decision.ts";
import type { AppStore, SessionRow } from "../store/store.ts";
import { sha256Hex } from "../util/encoding.ts";
import type { Logger } from "../util/log.ts";
import { SLICE_CHARS } from "../web/cache.ts";
import { fence, originOf } from "../web/fence.ts";
import { hostOf, parseFetchUrl } from "../web/fetch.ts";
import { WebError } from "../web/types.ts";
import {
  BrowserActionError,
  type BrowserScroll,
  type BrowserUploadFile,
  type BrowserUploadTarget,
  type BrowserWait,
  SLOW_TYPE_LIMIT,
} from "./driver.ts";
import { fieldRefusal } from "./effects.ts";
import { BrowserError, type BrowserService } from "./service.ts";
import {
  changesView,
  interactiveView,
  mapSnapshotRefs,
  REF,
  type SnapshotView,
  snapshotRef,
  textView,
} from "./snapshot-view.ts";
import type { TakeoverService } from "./takeover-service.ts";
import { readUploadSource, type UploadSource } from "./upload-source.ts";

export const BROWSER_CONNECTOR = "browser";

type Part = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolOut = { output: Part[]; isError?: true };
const ok = (text: string): ToolOut => ({ output: [{ type: "text", text }] });
const fail = (text: string): ToolOut => ({ isError: true, output: [{ type: "text", text }] });
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const BROWSER_NOTE = [
  "You have a web browser: a Chromium window for this chat on the agent computer. It keeps its own profile, so sign-ins persist between chats, but it is not the user's own browser. Its tools are the browser group: load it with search_capabilities. Before using them, call use_skill with name=\"rei-browser\" and follow its instructions. Use web_fetch to read pages that don't need JavaScript, a sign-in or interaction.",
  "Never type passwords, one-time codes or card numbers, and never try to get past a sign-in page or CAPTCHA yourself. Call browser_takeover, tell the user why, and end your turn so they can take over in the window.",
  "Don't buy, pay, delete or send anything the user didn't ask for.",
  "After an action that loads or updates a page, use browser_wait for the expected text, address or element. Refs like p3e12 belong to the document they came from.",
  "Use browser_check to set a checkbox, browser_scroll for content that loads as you scroll, and browser_hover for menus. Use slowly with browser_type when a field ignores ordinary typing.",
].join("\n");

const WAIT_PARAMS = {
  text: opt(str({ description: "Wait for this text to be visible. Choose exactly one of text, url or ref." })),
  url: opt(str({ description: "Wait for a URL containing this text, or use a glob with *." })),
  ref: opt(str({ description: "Wait for this ref from the latest snapshot to be visible and enabled." })),
  gone: opt(bool({ description: "Wait for text or a ref to disappear." })),
  timeout_s: opt(
    num({ minimum: 0.001, maximum: 20, description: "Maximum seconds to wait (default 10, maximum 20)." }),
  ),
};
const waitParameters = obj({
  ...WAIT_PARAMS,
  view: opt(
    union([lit("full"), lit("text"), lit("interactive"), lit("changes")], {
      description: "Snapshot view to return at the end (default changes).",
    }),
  ),
});
type WaitArgs = Omit<Static<typeof waitParameters>, "view">;
const WAIT_TARGETS = ["text", "url", "ref"] as const;

const ELEMENT_PARAMS = {
  ref: str({ description: "The ref of the element, like p3e12." }),
  element: str({ description: "A few words naming the element, e.g. 'Remember me'." }),
};
const CHECK_PARAMS = {
  ...ELEMENT_PARAMS,
  checked: bool({ description: "The desired checked state." }),
};
const SCROLL_PARAMS = {
  ref: opt(str({ description: "The ref to scroll into view. Use this or direction." })),
  direction: opt(union([lit("up"), lit("down")], { description: "Direction to scroll in the viewport." })),
  pages: opt(int({ minimum: 1, maximum: 10, description: "Viewport heights to scroll (default 1)." })),
};
const scrollParameters = obj(SCROLL_PARAMS);
type ScrollArgs = Static<typeof scrollParameters>;
type NamedRef = { ref: string; element: string };
type CheckArgs = NamedRef & { checked: boolean };
const slowlyParameter = opt(
  bool({
    description: `Type one character at a time for fields that ignore ordinary typing (at most ${SLOW_TYPE_LIMIT} characters).`,
  }),
);

const namedElement = (name: string): string => JSON.stringify(clip(String(name).replace(/\s+/g, " ").trim(), 120));
const scrollWords = (a: ScrollArgs): string =>
  a.ref ? `to ${clip(a.ref, 40)}` : `${a.direction ?? "down"} ${a.pages ?? 1} page${(a.pages ?? 1) === 1 ? "" : "s"}`;

function waitWords(a: WaitArgs, verb = "wait"): string {
  const target = WAIT_TARGETS.find((key) => a[key] !== undefined);
  if (!target) return `${verb} on the page`;
  return `${verb} for ${target} ${JSON.stringify(clip(String(a[target]), 120))}${a.gone ? " to disappear" : ""}`;
}

export interface BrowserToolsDeps {
  treeId: string;
  store: AppStore;
  catalog: ToolCatalog;
  log: Logger;
  browser: BrowserService;
  takeovers: TakeoverService;
  library?: LibraryService;
  workspaces?: WorkspaceManager;
}

type UploadFacts =
  | { error: string }
  | {
      binding: string;
      name: string;
      size: number;
      origin: string;
      pageOrigin: string;
      target: BrowserUploadTarget;
      file?: BrowserUploadFile;
    };

const uploadParameters = obj({
  ref: str({ description: "The file input or upload button ref from the latest snapshot.", maxLength: 40 }),
  source: union([
    obj({ type: lit("library"), fileId: str({ maxLength: 128 }), versionId: str({ maxLength: 128 }) }),
    obj({
      type: lit("sandbox"),
      path: str({ maxLength: 1024, description: "A path relative to the agent workspace." }),
    }),
  ]),
});

/** A snapshot slice: what the page said since last time, its header and the text from `offset` (all fenced: it is the page's), then the footer that says where to go on. */
export function renderSnapshot(
  page: { title: string; url: string },
  text: string,
  offset: number,
  view: SnapshotView = "full",
  notes: string[] = [],
): { text: string } | { error: string } {
  const total = text.length;
  if (offset > 0 && offset >= total)
    return { error: `offset ${offset} is past the end of the snapshot (${total} characters).` };
  let end = Math.min(total, offset + SLICE_CHARS);
  if (end < total) {
    const nl = text.lastIndexOf("\n", end - 1);
    if (nl >= offset + SLICE_CHARS - 2_000) end = nl + 1;
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  const body = text.slice(offset, end);
  const more = view === "full" ? `offset=${end}` : `view="${view}" and offset=${end}`;
  const footer =
    end < total
      ? `\n\n[Showing characters ${offset}–${end} of ${total}. Call browser_snapshot with ${more} for more.]`
      : "";
  const inside = [...notes.map((n) => `[${n}]`), `# ${page.title}\n${page.url}\n\n${body.trimEnd()}`].join("\n\n");
  return { text: `${fence(inside, originOf(page.url))}${footer}` };
}

const KEY = /^[A-Za-z0-9+_ -]{1,40}$/;

/** What the policy hook learns before a call: the host of the page the window shows now (the destination of a send). */
interface BrowserFacts {
  pageHost: string | null;
}

interface BrowserInputFacts extends BrowserFacts {
  typingOrigin: string | null;
  binding?: string;
}

function typingOrigin(url: string | null | undefined): string | null {
  if (!url || !originOf(url)) return null;
  return new URL(url).origin;
}

/** The message for a failure the model should hear; Playwright's multi-line call logs are cut to their first line. */
function messageOf(error: unknown): string {
  if (error instanceof BrowserError || error instanceof WebError) return error.message;
  const text = error instanceof Error ? error.message : "";
  const first = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return first.trim() === "" ? "The browser could not do that." : clip(first.trim(), 300);
}

function actionMessage(error: BrowserActionError, action: string, element?: string): string {
  const lead = `Could not ${action}${element ? ` "${clip(element.replace(/\s+/g, " ").trim(), 120)}"` : ""}:`;
  const failure = error.failure;
  const origin = originOf(error.pageUrl);
  switch (failure.reason) {
    case "covered":
      return `${lead} it is covered by\n${fence(failure.coveringElement, origin)}\nClose or accept that first (look for its button with browser_snapshot view="interactive"), or press Escape.`;
    case "hidden":
      return `${lead} it is hidden.`;
    case "disabled":
      return `${lead} it is disabled. Something on the page may need to be filled in first.`;
    case "read-only":
      return `${lead} it is read-only.`;
    case "moving":
      return `${lead} it is still moving (an animation). Wait and try again.`;
    case "off-screen":
      return `${lead} it can't be scrolled into view (it may be inside a scrolling panel). Try browser_scroll with its ref.`;
    case "stale":
      return `${lead} that ref is not on the page any more. Call browser_snapshot for fresh refs.`;
    case "earlier-page":
      return "That ref is from an earlier page; the window has loaded a new one since. Take a new snapshot.";
    case "not-checkable":
      return `${lead} it is not a checkbox, radio or switch; use browser_click.`;
    case "radio-uncheck":
      return "A radio button can't be unchecked; check another option in its group instead.";
    case "not-fillable":
      return `${lead} use browser_type with slowly=true to click the element and type with the keyboard.`;
    case "field-refused":
      return failure.message;
    case "options-not-found":
      if (failure.labels.length === 0) return "None of the options matched.";
      return `None of the options matched. The options are:\n${fence(failure.labels.map((label) => JSON.stringify(label)).join(", "), origin)}`;
  }
}

export function createBrowserExtension(deps: BrowserToolsDeps): Extension {
  const { treeId, store, catalog, log, browser, takeovers } = deps;
  const sessionOf = (conversationId: unknown): SessionRow | undefined =>
    store.sessionByConversation(treeId, String(conversationId));

  const inspect = async (_args: unknown, session: SessionRow): Promise<BrowserFacts> => ({
    pageHost: originOf(browser.page(session.id)?.url),
  });

  const inputPolicy = (
    refs: (args: unknown) => string[],
    browserInput: NonNullable<ToolPolicy["browserInput"]> = () => true,
  ): Partial<ToolPolicy> => ({
    browserInput,
    inspect: async (args: unknown, session: SessionRow): Promise<BrowserInputFacts> => {
      const facts = await inspect(args, session);
      const targets = refs(args);
      if (!targets.length || !(JSON.parse(session.taint) as string[]).includes("private"))
        return { ...facts, typingOrigin: null, binding: "browser:no-private-typing" };
      const origins = new Set<string>();
      for (const ref of targets) {
        const { result } = await browser.runWithRef(session.id, undefined, ref, async (target) => {
          const element = await browser.driver.describe(session.id, target);
          if (!element) return null;
          return typingOrigin(element.frameUrl === undefined ? browser.page(session.id)?.url : element.frameUrl);
        });
        if (!result) return { ...facts, typingOrigin: null };
        origins.add(result);
      }
      const [origin] = origins;
      return origin && origins.size === 1
        ? { ...facts, typingOrigin: origin, binding: origin }
        : { ...facts, typingOrigin: null };
    },
    binding: (facts?: BrowserInputFacts) => facts?.binding,
    inspectionError: () =>
      "Could not verify the site for typing. Take a new snapshot and type into one site at a time.",
    destination: (_a, facts?: BrowserInputFacts) => facts?.typingOrigin ?? facts?.pageHost ?? null,
  });

  const policy = (
    actionClass: ActionClass,
    operation: string,
    extra: Partial<ToolPolicy> & Pick<ToolPolicy, "summary">,
  ): ToolPolicy => ({
    actionClass,
    connector: BROWSER_CONNECTOR,
    operation,
    inspect,
    // While the user controls the window every browser call parks on the takeover and runs when it ends. The policy hook
    // asks this right after it records the step, before any approval: the call shows as waiting, and has asked for no
    // approval yet. A takeover that starts after the call passed is waited out in the driver. The catalog is shared by
    // every tree and holds the last tree's closure, so the call's tree comes from its session, never from `treeId`.
    parkOn: (session: SessionRow, taskId: string) => {
      const id = takeovers.park(session.id, session.tree_id, taskId);
      return id === undefined ? undefined : [TakeoverEnded.key(id)];
    },
    destination: (_a: unknown, facts?: BrowserFacts) => facts?.pageHost ?? null,
    ...extra,
  });

  /** What the page said to the agent between calls (dialog texts and the like), fenced, ahead of `text`. */
  const withNotes = (sessionId: string, notes: string[], text: string): string =>
    notes.length === 0
      ? text
      : `${fence(notes.map((n) => `[${n}]`).join("\n"), originOf(browser.page(sessionId)?.url))}\n${text}`;

  /** The snapshot of the window's current page, kept for paging, with what the page did since the last call. */
  const look = async (
    sessionId: string,
    offset: number,
    signal: AbortSignal | undefined,
    lead?: string,
    view: SnapshotView = "full",
  ): Promise<ToolOut> => {
    const page = (await browser.syncPage(sessionId)) ?? browser.page(sessionId) ?? { url: "", title: "" };
    const cached = offset > 0 ? browser.cachedSnapshot(sessionId) : undefined;
    if (offset > 0 && cached && cached.view !== view)
      return fail("Take a fresh snapshot (offset 0) before paging through this view.");
    let text = cached?.text;
    if (text === undefined) {
      const snapshot = await browser.run(sessionId, signal, () => browser.driver.snapshot(sessionId));
      const { raw } = snapshot;
      const scoped = (ref: string) => snapshotRef(snapshot, ref);
      const base = browser.baseline(sessionId);
      if (view === "text") {
        text =
          textView(mapSnapshotRefs(raw, scoped)) ||
          "(This page has no readable text. Call browser_snapshot for the full structure.)";
      } else if (view === "interactive") {
        text =
          interactiveView(mapSnapshotRefs(raw, scoped)) ||
          "(Nothing on this page to click or fill in. Call browser_snapshot without view to read it.)";
      } else if (view === "changes" && base?.generation === snapshot.generation) {
        const diff = changesView(base.raw, raw, (ref) => snapshotRef(base, ref), scoped);
        text =
          diff.text === ""
            ? "(No changes since your last snapshot.)"
            : `Changes since your last snapshot: ${diff.added} added, ${diff.changed} changed, ${diff.removed} removed.\n${mapSnapshotRefs(diff.text, scoped)}`;
      } else {
        text = mapSnapshotRefs(raw, scoped);
        if (view === "changes")
          lead = [lead, "[No earlier snapshot of this page to compare with, so this is the whole page.]"]
            .filter(Boolean)
            .join("\n\n");
      }
      // Whatever the view, the agent has now seen the page as it is: the next "changes" starts here.
      browser.setBaseline(sessionId, snapshot);
      browser.setSnapshot(sessionId, view, text);
    }
    const notes = browser.takeNotes(sessionId);
    const slice = renderSnapshot(page, text, offset, view, notes);
    if ("error" in slice) return fail(withNotes(sessionId, notes, slice.error));
    return ok([lead, slice.text].filter((p): p is string => !!p && p.trim() !== "").join("\n\n"));
  };

  /** Runs one tool body: guards, the error text, and the notes the page left for the agent. */
  const guarded = async (
    sessionId: string | undefined,
    body: (sessionId: string) => Promise<ToolOut>,
  ): Promise<ToolOut> => {
    if (!sessionId) return fail("This session is no longer available.");
    try {
      return await body(sessionId);
    } catch (error) {
      const notes = browser.takeNotes(sessionId);
      log.info("browser.tool_failed", { sessionId, error: error instanceof Error ? error.name : "error" });
      return fail(withNotes(sessionId, notes, messageOf(error)));
    }
  };

  const open = policyTool(
    catalog,
    policy("read_external", "open", {
      destination: (a: { url: string }) => originOf(String(a.url ?? "").trim()),
      // As web_fetch: a session that holds private data decides opening a page as a send (the URL carries data out).
      classFor: (_a: unknown, taint: readonly TaintLabel[]) => (taint.includes("private") ? "send" : "read_external"),
      summary: (a: { url: string }) => `Open ${clip(String(a.url ?? ""), 250)} in the browser`,
    }),
    {
      name: "browser_open",
      callers: MODEL_AND_SCRIPTS,
      description:
        "Open a web page (http or https) in your browser window and return it as readable text: headings, prose, links as Markdown, and [ref=p3e12] marks on what you can click or fill in. Call browser_snapshot for the full element tree when you need it. Use it for pages that need JavaScript, a sign-in or interaction; web_fetch is cheaper for plain reading.",
      parameters: obj({
        url: str({ description: "The full address, starting with http:// or https://." }),
      }),
      execute: async (args, api, abort) => {
        const session = sessionOf(api.conversationId);
        return guarded(session?.id, async (sessionId) => {
          const url = parseFetchUrl(args.url);
          await browser.acquire(sessionId, abort.abortSignal);
          browser.allowHost(sessionId, hostOf(url));
          await browser.run(sessionId, abort.abortSignal, () => browser.driver.goto(sessionId, url.href));
          return look(sessionId, 0, abort.abortSignal, undefined, "text");
        });
      },
    },
  );

  const snapshot = policyTool(
    catalog,
    policy("read_internal", "snapshot", { summary: () => "Read the browser page" }),
    {
      name: "browser_snapshot",
      callers: MODEL_AND_SCRIPTS,
      description:
        'The current page of your browser window as text, with [ref=p3e12] marks. A snapshot is cut at 20,000 characters; pass the offset from its footer to read on. view="text" is the page as readable text (cheapest for reading); view="interactive" lists only what you can click or fill in (cheap orientation on a big page); view="changes" shows only what changed since your last snapshot of this page (use it after waiting for something to load or update).',
      parameters: obj({
        view: opt(
          union([lit("full"), lit("text"), lit("interactive"), lit("changes")], {
            description:
              "full (default): the whole page. text: the page as readable text. interactive: only what you can click or fill in. changes: only what changed since your last snapshot.",
          }),
        ),
        offset: opt(
          int({
            minimum: 0,
            description: "Character offset to continue from (from the footer of the previous slice).",
          }),
        ),
      }),
      replay: "safe",
      outputLimits: { maxBytes: 120_000, maxLines: 30_000 },
      execute: async (args, api, abort) => {
        const session = sessionOf(api.conversationId);
        return guarded(session?.id, async (sessionId) => {
          if (!browser.hasWindow(sessionId)) throw new BrowserError(browser.noWindowMessage(sessionId));
          // A fresh look, unless the agent is paging through the one it has.
          return look(sessionId, args.offset ?? 0, abort.abortSignal, undefined, args.view ?? "full");
        });
      },
    },
  );

  // One function per action, shared by the single tools and browser_batch, so that what a step checks and does is the same in both.
  // `looks`: the single tool answers with the new snapshot (a click, Enter) rather than with the short text.
  type StepOut = { text: string; looks: boolean; lead?: string; showText?: true; failed?: true };
  const checkRef = (ref: string): void => {
    if (ref.length > 40 || !REF.test(ref))
      throw new BrowserError("That is not a ref. Use one from the latest snapshot, like p3e12.");
  };
  const runRefAction = async (
    sessionId: string,
    signal: AbortSignal | undefined,
    ref: string,
    action: string,
    fn: (target: string) => Promise<StepOut>,
    element?: string,
  ): Promise<StepOut> => {
    checkRef(ref);
    try {
      const { result, replacement } = await browser.runWithRef(sessionId, signal, ref, fn);
      if (!replacement) return result;
      const { role, name, ref: used, pageUrl } = replacement;
      const lead = fence(
        `The element was replaced; used the matching ${role} ${JSON.stringify(name)} (now ${used}).`,
        originOf(pageUrl),
      );
      return { ...result, lead };
    } catch (error) {
      if (error instanceof BrowserActionError) throw new BrowserError(actionMessage(error, action, element));
      throw error;
    }
  };
  const stepClick = async (
    sessionId: string,
    signal: AbortSignal | undefined,
    a: { ref: string; element?: string },
  ): Promise<StepOut> =>
    runRefAction(
      sessionId,
      signal,
      a.ref,
      "click",
      async (ref) => {
        await browser.driver.click(sessionId, ref);
        return {
          text: `Clicked "${clip(
            String(a.element || "an element")
              .replace(/\s+/g, " ")
              .trim(),
            120,
          )}".`,
          looks: true,
        };
      },
      a.element,
    );
  const stepType = async (
    sessionId: string,
    signal: AbortSignal | undefined,
    a: { ref: string; text: string; submit?: boolean; slowly?: boolean },
    approvedOrigin?: string | null,
  ): Promise<StepOut> =>
    runRefAction(sessionId, signal, a.ref, "type there", async (ref) => {
      if (a.slowly && [...a.text].length > SLOW_TYPE_LIMIT)
        throw new BrowserError(`Slow typing is limited to ${SLOW_TYPE_LIMIT} characters.`);
      const el = await browser.driver.describe(sessionId, ref);
      if (!el) throw new BrowserActionError({ reason: "stale" }, browser.page(sessionId)?.url ?? "");
      const frameUrl = el.frameUrl === undefined ? browser.page(sessionId)?.url : el.frameUrl;
      if (approvedOrigin && typingOrigin(frameUrl) !== approvedOrigin)
        throw new BrowserError("The destination for typing changed. Take a new snapshot and try again.");
      const refusal = fieldRefusal(el);
      if (refusal) throw new BrowserError(refusal);
      await browser.driver.type(
        sessionId,
        ref,
        a.text,
        a.submit === true,
        a.slowly ? { refusalForField: fieldRefusal } : undefined,
      );
      return {
        text: a.submit === true ? "Typed into the field and pressed Enter." : "Typed into the field.",
        looks: a.submit === true,
      };
    });
  const stepSelect = async (
    sessionId: string,
    signal: AbortSignal | undefined,
    a: { ref: string; values: string[] },
  ): Promise<StepOut> =>
    runRefAction(sessionId, signal, a.ref, "select that", async (ref) => {
      await browser.driver.select(sessionId, ref, a.values);
      return { text: "Chose the option.", looks: false };
    });
  const stepPress = async (
    sessionId: string,
    signal: AbortSignal | undefined,
    a: { key: string },
  ): Promise<StepOut> => {
    if (!KEY.test(a.key))
      throw new BrowserError("That is not a key name. Use names like Enter, Tab, Escape, ArrowDown or Control+a.");
    await browser.run(sessionId, signal, () => browser.driver.press(sessionId, a.key));
    return { text: `Pressed ${a.key}.`, looks: /^(numpad)?enter$/i.test(a.key) };
  };
  const stepWait = async (sessionId: string, signal: AbortSignal | undefined, a: WaitArgs): Promise<StepOut> => {
    const [target, extra] = WAIT_TARGETS.filter((key) => a[key] !== undefined);
    const value = target === undefined ? undefined : a[target];
    if (!target || extra || !value?.trim()) throw new BrowserError("Wait for exactly one of text, url or ref.");
    if (target === "url" && a.gone) throw new BrowserError("Use gone with text or a ref.");
    if (target === "ref") checkRef(value);
    const condition: BrowserWait = { target, value, gone: a.gone === true };
    const seconds = a.timeout_s ?? 10;
    const { matched, elapsed } = await browser.run(sessionId, signal, async () => {
      const start = performance.now();
      try {
        const matched = await browser.driver.wait(sessionId, condition, seconds * 1_000);
        return { matched, elapsed: (performance.now() - start) / 1_000 };
      } catch (error) {
        if (error instanceof BrowserActionError) throw new BrowserError(actionMessage(error, "wait for that ref"));
        throw error;
      }
    });
    const text = matched
      ? `Waited ${Number(elapsed.toFixed(1))} s for ${JSON.stringify(clip(value, 200))}${a.gone ? " to disappear" : ""}.`
      : `Still not there after ${seconds} s.`;
    return { text, looks: true, showText: true, ...(matched ? {} : { failed: true }) };
  };
  const stepScroll = async (sessionId: string, signal: AbortSignal | undefined, a: ScrollArgs): Promise<StepOut> => {
    let scroll: BrowserScroll;
    if (a.ref !== undefined && a.direction === undefined && a.pages === undefined) {
      checkRef(a.ref);
      scroll = { ref: a.ref };
    } else if (a.direction !== undefined && a.ref === undefined) {
      scroll = { direction: a.direction, pages: a.pages ?? 1 };
    } else {
      throw new BrowserError("Give a scroll ref or a direction with optional pages.");
    }
    try {
      await browser.run(sessionId, signal, () => browser.driver.scroll(sessionId, scroll));
    } catch (error) {
      if (error instanceof BrowserActionError) throw new BrowserError(actionMessage(error, "scroll to that ref"));
      throw error;
    }
    return { text: `Scrolled ${scrollWords(a)}.`, looks: true };
  };
  const stepHover = (sessionId: string, signal: AbortSignal | undefined, a: NamedRef): Promise<StepOut> =>
    runRefAction(
      sessionId,
      signal,
      a.ref,
      "hover over",
      async (ref) => {
        await browser.driver.hover(sessionId, ref);
        return { text: `Hovered over ${namedElement(a.element)}.`, looks: true };
      },
      a.element,
    );
  const stepCheck = (sessionId: string, signal: AbortSignal | undefined, a: CheckArgs): Promise<StepOut> =>
    runRefAction(
      sessionId,
      signal,
      a.ref,
      a.checked ? "check" : "uncheck",
      async (ref) => {
        const already = await browser.driver.check(sessionId, ref, a.checked);
        const state = a.checked ? "checked" : "unchecked";
        const text = already
          ? `Already ${state}.`
          : `${a.checked ? "Checked" : "Unchecked"} ${namedElement(a.element)}.`;
        return { text, looks: false };
      },
      a.element,
    );
  /** The tool's answer for one step: the new snapshot when it looks, else its short text. */
  const answer = async (
    sessionId: string,
    abort: AbortSignal | undefined,
    out: StepOut,
    view: SnapshotView = "full",
  ): Promise<ToolOut> => {
    if (!out.looks) return ok([out.text, out.lead].filter(Boolean).join("\n"));
    const lead = [out.showText ? out.text : undefined, out.lead].filter(Boolean).join("\n");
    if (!out.failed) return look(sessionId, 0, abort, lead, view);
    try {
      return { ...(await look(sessionId, 0, abort, lead, view)), isError: true };
    } catch (error) {
      return fail(`${lead}\n\n${messageOf(error)}`);
    }
  };

  const click = policyTool(
    catalog,
    policy("read_external", "click", {
      summary: (a: { element?: string }, facts?: BrowserFacts) =>
        `Click "${clip(String(a.element || "an element"), 120)}"${facts?.pageHost ? ` on ${facts.pageHost}` : ""}`,
    }),
    {
      name: "browser_click",
      callers: MODEL_AND_SCRIPTS,
      description:
        "Click an element of the page by its ref from the latest snapshot. Returns the new snapshot. Say in `element` what you are clicking (a few words); it goes in the trace.",
      parameters: obj({
        ref: str({ description: "The ref of the element, like p3e12." }),
        element: str({ description: "A few words naming the element, e.g. 'Sign in button'." }),
      }),
      execute: async (args, api, abort) => {
        const session = sessionOf(api.conversationId);
        return guarded(session?.id, async (sessionId) =>
          answer(sessionId, abort.abortSignal, await stepClick(sessionId, abort.abortSignal, args)),
        );
      },
    },
  );

  const upload = policyTool(
    catalog,
    policy("send", "upload", {
      approvalOnce: { reason: "the website can receive the file as soon as it is selected" },
      inspect: async (
        { ref, source }: { ref: string; source: UploadSource },
        session: SessionRow,
        context: Context,
        phase?: "execute",
      ): Promise<UploadFacts> => {
        try {
          checkRef(ref);
          const target = await browser.driver.uploadTarget(session.id, ref);
          const origin = typingOrigin(target.frameUrl);
          const pageOrigin = typingOrigin(target.pageUrl);
          if (!origin || !pageOrigin) throw new BrowserError("File uploads require an HTTP or HTTPS website.");
          const file = await readUploadSource(source, session, deps, context);
          const { name, mediaType } = file;
          const binding = await sha256Hex(
            canonicalJson({ target, agentId: session.agent_id, name, mediaType, content: await sha256Hex(file.bytes) }),
          );
          return { binding, name, size: file.bytes.length, origin, pageOrigin, target, ...(phase ? { file } : {}) };
        } catch (error) {
          context.abortSignal?.throwIfAborted();
          return { error: messageOf(error) };
        }
      },
      binding: (facts?: UploadFacts) => (facts && "binding" in facts ? facts.binding : undefined),
      inspectionError: (facts?: UploadFacts) => (facts && "error" in facts ? facts.error : undefined),
      destination: (_args, facts?: UploadFacts) => (facts && "origin" in facts ? facts.origin : null),
      summary: ({ source }: { source: UploadSource }, facts?: UploadFacts) => {
        if (!facts || "error" in facts) return "Upload a file";
        const name = clip(facts.name.replace(/[\p{Cc}\p{Cf}]/gu, " "), 150);
        const location = source.type === "library" ? "Library" : "sandbox";
        const page = facts.origin === facts.pageOrigin ? "" : ` (embedded on ${facts.pageOrigin})`;
        return `Upload ${JSON.stringify(name)} (${facts.size} bytes, ${location}) to ${facts.origin}${page}`;
      },
    }),
    {
      name: "browser_upload",
      callers: MODEL_AND_SCRIPTS,
      description:
        "Select one file, up to 25 MiB, in a file input or chooser button by ref. Use an exact Library file/version pair or a relative sandbox workspace path. The site may upload immediately on selection. Outside YOLO, each upload asks for approval.",
      parameters: uploadParameters,
      replay: "unsafe",
      execute: async (args, api, context) => {
        const session = sessionOf(api.conversationId);
        return guarded(session?.id, async (sessionId) => {
          await browser.waitForControl(sessionId, context.abortSignal);
          const checked = await catalog.revalidate(
            treeId,
            "browser_upload",
            args,
            await api.memo(POLICY_MEMO, context),
            String(api.taskId),
            String(api.conversationId),
            context,
          );
          const facts = checked.facts as UploadFacts;
          if ("error" in facts || !facts.file) throw new BrowserError("The approved file is unavailable.");
          const file = facts.file;
          await browser.run(sessionId, context.abortSignal, () =>
            browser.driver.upload(sessionId, args.ref, facts.target, file, () => {
              context.abortSignal?.throwIfAborted();
              checked.assert();
            }),
          );
          return ok("File selected. Check the page to confirm whether the site received it or needs another action.");
        });
      },
    },
  );

  const type = policyTool(
    catalog,
    policy("write_internal", "type", {
      ...inputPolicy((a) => [(a as { ref: string }).ref]),
      failClosed: true,
      // As web_fetch: page scripts can read what is typed, so a session that holds private data decides typing as a send.
      classFor: (_a: unknown, taint: readonly TaintLabel[]) => (taint.includes("private") ? "send" : "write_internal"),
      summary: (a: { text?: string; submit?: boolean }, facts?: BrowserFacts) =>
        `Type ${String(a.text ?? "").length} characters${facts?.pageHost ? ` on ${facts.pageHost}` : ""}${a.submit ? " and press Enter" : ""}`,
    }),
    {
      name: "browser_type",
      callers: MODEL_AND_SCRIPTS,
      description:
        "Type text into a field by its ref from the latest snapshot. Use slowly when the field ignores ordinary typing or needs autocomplete. With submit, press Enter afterwards and return the new snapshot. Never for passwords, one-time codes or card numbers: use browser_takeover.",
      parameters: obj({
        ref: str({ description: "The ref of the field, like p3e7." }),
        text: str({ maxLength: 10_000, description: "The text to type." }),
        submit: opt(bool({ description: "Press Enter after typing (default false)." })),
        slowly: slowlyParameter,
      }),
      execute: async (args, api, abort) => {
        const session = sessionOf(api.conversationId);
        return guarded(session?.id, async (sessionId) => {
          const checked = await catalog.revalidate(
            treeId,
            "browser_type",
            args,
            await api.memo(POLICY_MEMO, abort),
            String(api.taskId),
            String(api.conversationId),
          );
          return answer(
            sessionId,
            abort.abortSignal,
            await stepType(sessionId, abort.abortSignal, args, (checked.facts as BrowserInputFacts).typingOrigin),
          );
        });
      },
    },
  );

  const select = policyTool(
    catalog,
    policy("write_internal", "select", {
      summary: (_a: unknown, facts?: BrowserFacts) =>
        `Choose an option${facts?.pageHost ? ` on ${facts.pageHost}` : ""}`,
    }),
    {
      name: "browser_select",
      callers: MODEL_AND_SCRIPTS,
      description: "Choose option(s) in a <select> by its ref, giving the option labels or values.",
      parameters: obj({
        ref: str({ description: "The ref of the select, like p3e9." }),
        values: arr(str({ maxLength: 300 }), {
          minItems: 1,
          maxItems: 20,
          description: "The option labels or values to choose.",
        }),
      }),
      execute: async (args, api, abort) => {
        const session = sessionOf(api.conversationId);
        return guarded(session?.id, async (sessionId) =>
          answer(sessionId, abort.abortSignal, await stepSelect(sessionId, abort.abortSignal, args)),
        );
      },
    },
  );

  const press = policyTool(
    catalog,
    policy("write_internal", "press", {
      summary: (a: { key?: string }, facts?: BrowserFacts) =>
        `Press ${clip(String(a.key ?? ""), 40)}${facts?.pageHost ? ` on ${facts.pageHost}` : ""}`,
    }),
    {
      name: "browser_press",
      callers: MODEL_AND_SCRIPTS,
      description:
        "Press a key or a combination in the page, e.g. Enter, Tab, Escape, ArrowDown, Control+a. Enter returns the new snapshot.",
      parameters: obj({
        key: str({
          maxLength: 40,
          description: "A key name such as Enter, or a combination such as Control+a.",
        }),
      }),
      execute: async (args, api, abort) => {
        const session = sessionOf(api.conversationId);
        return guarded(session?.id, async (sessionId) =>
          answer(sessionId, abort.abortSignal, await stepPress(sessionId, abort.abortSignal, args)),
        );
      },
    },
  );

  const wait = policyTool(
    catalog,
    policy("read_internal", "wait", {
      failClosed: true,
      summary: (a: WaitArgs, facts?: BrowserFacts) =>
        `${waitWords(a, "Wait")}${facts?.pageHost ? ` on ${facts.pageHost}` : ""}`,
    }),
    {
      name: "browser_wait",
      callers: MODEL_AND_SCRIPTS,
      description:
        "Wait for text to appear, a URL to match, or a ref to become visible and enabled. Use gone for a spinner or element to disappear. Returns what changed on the page by default, including after a timeout. Use it after a click or submit instead of taking repeated snapshots.",
      parameters: waitParameters,
      replay: "safe",
      execute: async (args, api, abort) => {
        const session = sessionOf(api.conversationId);
        return guarded(session?.id, async (sessionId) =>
          answer(
            sessionId,
            abort.abortSignal,
            await stepWait(sessionId, abort.abortSignal, args),
            args.view ?? "changes",
          ),
        );
      },
    },
  );

  const scroll = policyTool(
    catalog,
    policy("read_internal", "scroll", { failClosed: true, summary: (a: ScrollArgs) => `Scroll ${scrollWords(a)}` }),
    {
      name: "browser_scroll",
      callers: MODEL_AND_SCRIPTS,
      description:
        "Scroll an element into view or scroll the page up or down by viewport heights. Returns what changed. Use it to reveal more content or bring an off-screen control into view.",
      parameters: scrollParameters,
      execute: async (args, api, abort) =>
        guarded(sessionOf(api.conversationId)?.id, async (sessionId) =>
          answer(sessionId, abort.abortSignal, await stepScroll(sessionId, abort.abortSignal, args), "changes"),
        ),
    },
  );
  const hover = policyTool(
    catalog,
    policy("read_internal", "hover", {
      failClosed: true,
      summary: (a: NamedRef) => `Hover over ${namedElement(a.element)}`,
    }),
    {
      name: "browser_hover",
      callers: MODEL_AND_SCRIPTS,
      description:
        "Move the pointer over an element using its latest snapshot ref and return what changed. Use it to open a hover menu or reveal a tooltip.",
      parameters: obj(ELEMENT_PARAMS),
      execute: async (args, api, abort) =>
        guarded(sessionOf(api.conversationId)?.id, async (sessionId) =>
          answer(sessionId, abort.abortSignal, await stepHover(sessionId, abort.abortSignal, args), "changes"),
        ),
    },
  );
  const check = policyTool(
    catalog,
    policy("write_internal", "check", {
      failClosed: true,
      summary: (a: CheckArgs) => `${a.checked ? "Check" : "Uncheck"} ${namedElement(a.element)}`,
    }),
    {
      name: "browser_check",
      callers: MODEL_AND_SCRIPTS,
      description:
        "Set a checkbox or switch to checked or unchecked, or select a radio with checked=true. Returns whether the control changed. Use it instead of clicking a checkbox or switch that might already be in the desired state.",
      parameters: obj(CHECK_PARAMS),
      execute: async (args, api, abort) =>
        guarded(sessionOf(api.conversationId)?.id, async (sessionId) =>
          answer(sessionId, abort.abortSignal, await stepCheck(sessionId, abort.abortSignal, args)),
        ),
    },
  );

  // The steps are the single tools' parameters with an `action` in front (same limits).
  const stepSchema = union([
    obj({
      action: lit("click"),
      ref: str({ description: "The ref of the element, like p3e12." }),
      element: str({ description: "A few words naming the element, e.g. 'Sign in button'." }),
    }),
    obj({
      action: lit("type"),
      ref: str({ description: "The ref of the field, like p3e7." }),
      text: str({ maxLength: 10_000, description: "The text to type." }),
      submit: opt(bool({ description: "Press Enter after typing (default false)." })),
      slowly: slowlyParameter,
    }),
    obj({
      action: lit("select"),
      ref: str({ description: "The ref of the select, like p3e9." }),
      values: arr(str({ maxLength: 300 }), {
        minItems: 1,
        maxItems: 20,
        description: "The option labels or values to choose.",
      }),
    }),
    obj({
      action: lit("press"),
      key: str({ maxLength: 40, description: "A key name such as Enter, or a combination such as Control+a." }),
    }),
    obj({ action: lit("wait"), ...WAIT_PARAMS }),
    obj({ action: lit("scroll"), ...SCROLL_PARAMS }),
    obj({ action: lit("hover"), ...ELEMENT_PARAMS }),
    obj({ action: lit("check"), ...CHECK_PARAMS }),
  ]);
  type BatchStep = Static<typeof stepSchema>;
  const runStep = (sessionId: string, signal: AbortSignal | undefined, step: BatchStep): Promise<StepOut> => {
    switch (step.action) {
      case "click":
        return stepClick(sessionId, signal, step);
      case "type":
        return stepType(sessionId, signal, step);
      case "select":
        return stepSelect(sessionId, signal, step);
      case "press":
        return stepPress(sessionId, signal, step);
      case "wait":
        return stepWait(sessionId, signal, step);
      case "scroll":
        return stepScroll(sessionId, signal, step);
      case "hover":
        return stepHover(sessionId, signal, step);
      case "check":
        return stepCheck(sessionId, signal, step);
    }
  };
  const stepWords = (s: Partial<BatchStep>): string => {
    switch (s.action) {
      case "click":
        return `click "${clip(String(s.element || "an element"), 60)}"`;
      case "type":
        return `type ${String(s.text ?? "").length} characters${s.slowly ? " slowly" : ""}${s.submit ? " and press Enter" : ""}`;
      case "select":
        return "choose an option";
      case "press":
        return `press ${clip(String(s.key ?? ""), 40)}`;
      case "wait":
        return waitWords(s);
      case "scroll":
        return `scroll ${scrollWords(s)}`;
      case "hover":
        return `hover over ${namedElement(s.element || "an element")}`;
      case "check":
        return `${s.checked ? "check" : "uncheck"} ${namedElement(s.element || "an element")}`;
      default:
        return "an unknown step";
    }
  };
  const stepsOf = (a: { steps?: unknown }): Partial<BatchStep>[] =>
    Array.isArray(a.steps) ? (a.steps as Partial<BatchStep>[]) : [];

  const batch = policyTool(
    catalog,
    // Declared read_external like browser_click, so a batch adds the same taint a click does and is fail closed.
    policy("read_external", "batch", {
      ...inputPolicy(
        (a) =>
          stepsOf(a as { steps?: unknown }).flatMap((st) =>
            st.action === "type" && typeof st.ref === "string" ? [st.ref] : [],
          ),
        // A typing grant covers text entry. Clicks and other actions keep the batch's own review.
        (a) =>
          stepsOf(a).every(
            (st) => st.action === "type" || st.action === "wait" || st.action === "scroll" || st.action === "hover",
          ),
      ),
      // The strictest step decides. Typing is a send in a session that holds private data, as browser_type. Otherwise a batch
      // with a click is decided as browser_click (read_external: strict asks). Wait, scroll and hover are reads.
      classFor: (a: { steps?: unknown }, taint: readonly TaintLabel[]) => {
        const steps = stepsOf(a);
        if (taint.includes("private") && steps.some((st) => st.action === "type")) return "send";
        if (steps.some((st) => st.action === "click")) return "read_external";
        return steps.some(
          (st) => st.action === "type" || st.action === "select" || st.action === "press" || st.action === "check",
        )
          ? "write_internal"
          : "read_internal";
      },
      // Never the typed text itself, as browser_type.
      summary: (a: { steps?: unknown }, facts?: BrowserFacts) => {
        const steps = stepsOf(a);
        return clip(
          `Run ${steps.length} step${steps.length === 1 ? "" : "s"}${facts?.pageHost ? ` on ${facts.pageHost}` : ""}: ${steps.map(stepWords).join(", ")}`,
          300,
        );
      },
    }),
    {
      name: "browser_batch",
      callers: MODEL_AND_SCRIPTS,
      description:
        "Run up to ten click, type, select, press, wait, scroll, hover or check steps in order. Stops at the first failed step and returns a line per step and then the page's snapshot. After navigation, wait for text or a URL and take a new snapshot before using refs.",
      parameters: obj({
        steps: arr(stepSchema, {
          minItems: 1,
          maxItems: 10,
          description:
            "The steps, each with an action: click or hover {ref, element}, type {ref, text, submit?, slowly?}, select {ref, values}, press {key}, wait {text|url|ref, gone?, timeout_s?}, scroll {ref|direction, pages?}, or check {ref, element, checked}.",
        }),
        view: opt(
          union([lit("full"), lit("interactive"), lit("changes")], {
            description: "The view of the snapshot returned at the end, as in browser_snapshot (default full).",
          }),
        ),
      }),
      execute: async (args, api, abort) => {
        const session = sessionOf(api.conversationId);
        return guarded(session?.id, async (sessionId) => {
          const checked = await catalog.revalidate(
            treeId,
            "browser_batch",
            args,
            await api.memo(POLICY_MEMO, abort),
            String(api.taskId),
            String(api.conversationId),
          );
          const approvedOrigin = (checked.facts as BrowserInputFacts).typingOrigin;
          const lines: string[] = [];
          let failedAt = -1;
          for (const [i, step] of args.steps.entries()) {
            try {
              const out =
                step.action === "type"
                  ? await stepType(sessionId, abort.abortSignal, step, approvedOrigin)
                  : await runStep(sessionId, abort.abortSignal, step);
              lines.push(`${i + 1}. ${out.failed ? "Failed: " : ""}${out.text}`);
              if (out.lead) lines.push(out.lead);
              if (out.failed) {
                failedAt = i;
                break;
              }
            } catch (error) {
              lines.push(`${i + 1}. Failed: ${messageOf(error)}`);
              failedAt = i;
              break;
            }
          }
          const left = failedAt < 0 ? 0 : args.steps.length - failedAt - 1;
          if (left > 0)
            lines.push(
              left === 1
                ? `Step ${args.steps.length} was not run.`
                : `Steps ${failedAt + 2}–${args.steps.length} were not run.`,
            );
          const report = lines.join("\n");
          const failed = failedAt >= 0;
          // The page after the steps, even after a failure: the agent needs to see where it is.
          if (!browser.hasWindow(sessionId)) return failed ? fail(report) : ok(report);
          let seen: ToolOut;
          try {
            seen = await look(sessionId, 0, abort.abortSignal, report, args.view ?? "full");
          } catch (error) {
            seen = ok(`${report}\n\n${messageOf(error)}`);
          }
          return failed ? { ...seen, isError: true } : seen;
        });
      },
    },
  );

  const back = policyTool(catalog, policy("read_internal", "back", { summary: () => "Go back in the browser" }), {
    name: "browser_back",
    callers: MODEL_AND_SCRIPTS,
    description: "Go back to the previous page of your browser window. Returns its snapshot.",
    parameters: obj({}),
    execute: async (_args, api, abort) => {
      const session = sessionOf(api.conversationId);
      return guarded(session?.id, async (sessionId) => {
        const went = await browser.run(sessionId, abort.abortSignal, () => browser.driver.back(sessionId));
        if (!went) return ok("There is no earlier page.");
        return look(sessionId, 0, abort.abortSignal);
      });
    },
  });

  const screenshot = policyTool(
    catalog,
    policy("read_internal", "screenshot", { summary: () => "Take a screenshot of the browser page" }),
    {
      name: "browser_screenshot",
      callers: MODEL_AND_SCRIPTS,
      description:
        "A picture of the page as the user would see it (JPEG). Use it for what the text snapshot cannot show: charts, images, layout. With annotate, every element you can act on in view is outlined and tagged with its ref (like p3e12), and the tags are listed in the text: use it when the snapshot is ambiguous, e.g. many buttons with the same name, or icon-only controls.",
      parameters: obj({
        annotate: opt(
          bool({ description: "Outline and tag the elements you can act on with their refs (default false)." }),
        ),
      }),
      replay: "safe",
      execute: async (args, api, abort) => {
        const session = sessionOf(api.conversationId);
        return guarded(session?.id, async (sessionId) => {
          const annotate = args.annotate === true;
          const shot = await browser.run(sessionId, abort.abortSignal, () =>
            browser.driver.screenshot(sessionId, annotate ? { annotate } : undefined),
          );
          const page = browser.page(sessionId);
          // The title and the tag names are the page's: fenced.
          const legend = (shot.labels ?? []).map(
            (l) => `${l.ref} ${l.role}${l.name ? ` "${clip(l.name.replace(/\s+/g, " ").trim(), 80)}"` : ""}`,
          );
          const inside = [
            `# ${page?.title || "(no title)"}`,
            page?.url ?? "",
            ...(legend.length > 0 ? ["", "The tags in the picture:", ...legend] : []),
          ].join("\n");
          let text = `Screenshot of the page.\n${fence(inside, originOf(page?.url))}`;
          if (annotate && legend.length === 0) text += "\nNothing you can act on is in view, so nothing is tagged.";
          return {
            output: [
              { type: "image", data: shot.data, mimeType: shot.mimeType },
              { type: "text", text },
            ],
          } as ToolOut;
        });
      },
    },
  );

  // Declared write_internal, not "credentials": the credentials class is denied outright, and this tool only puts a
  // request in front of the user. What it asks for (a sign-in) is exactly what the agent must not do itself.
  const takeover = policyTool(
    catalog,
    policy("write_internal", "takeover", {
      summary: (a: { reason?: string }) => `Ask you to take over the browser: ${clip(String(a.reason ?? ""), 200)}`,
    }),
    {
      name: "browser_takeover",
      callers: MODEL_ONLY,
      description:
        "Ask the user to take over your browser window for something only they can do: a sign-in, a one-time code, a CAPTCHA, a card number. Give a one-line reason. Then tell the user in one sentence and end your turn; when they finish you get a new turn and should look at the page again.",
      parameters: obj({
        reason: str({
          maxLength: 300,
          description: "One line: what the user needs to do, e.g. 'Sign in to your bank'.",
        }),
      }),
      execute: async (args, api) => {
        const session = sessionOf(api.conversationId);
        return guarded(session?.id, async (sessionId) => {
          const reason = args.reason.replace(/\s+/g, " ").trim();
          if (reason === "") throw new BrowserError("Give a reason.");
          if (!browser.hasWindow(sessionId)) throw new BrowserError(browser.noWindowMessage(sessionId));
          takeovers.request(sessionId, reason);
          return ok(
            "Asked the user to take over the browser. Tell them in one short sentence what they need to do, then end your turn.",
          );
        });
      },
    },
  );

  return defineExtension({
    name: "browser",
    namespace: { name: "browser", description: "Your browser window: open pages, read them and interact with them." },
    tools: [
      open,
      snapshot,
      click,
      upload,
      type,
      select,
      press,
      wait,
      scroll,
      hover,
      check,
      batch,
      back,
      screenshot,
      takeover,
    ],
    sections: [section("browser", () => BROWSER_NOTE)],
  });
}
