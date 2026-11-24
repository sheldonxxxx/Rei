import type { CDPSession, ElementHandle, Frame, JSHandle, Page } from "playwright-core";
import { BrowserActionError, type BrowserSnapshot } from "../browser/driver.ts";
import { nativeRefPrefix, REF } from "../browser/snapshot-view.ts";

interface FrameDocument {
  frame: Frame;
  generation: number;
  handle?: JSHandle<Document>;
  nativePrefix?: string;
}

type Scope = Pick<BrowserSnapshot, "generation" | "prefixes">;

/** Playwright's aria-ref numbers belong to a document and can be recycled immediately after a navigation. */
export class BrowserRefs {
  readonly #page: Page;
  readonly #cdp: CDPSession;
  readonly #documents = new Map<Frame, FrameDocument>();
  #generation = 0;
  #loader: string | undefined;
  #mainNavigation = 0;
  #seenMainNavigation = 0;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(page: Page, cdp: CDPSession) {
    this.#page = page;
    this.#cdp = cdp;
    cdp.on("Page.frameNavigated", ({ frame }) => {
      if (!frame.parentId) this.#mainNavigation++;
    });
    page.on("framedetached", (frame) => this.#forget(frame));
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(run);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  #forget(frame: Frame): void {
    const old = this.#documents.get(frame);
    this.#documents.delete(frame);
    void old?.handle?.dispose().catch(() => undefined);
  }

  async #main(): Promise<FrameDocument> {
    const { frameTree } = await this.#cdp.send("Page.getFrameTree");
    const { loaderId } = frameTree.frame;
    const frame = this.#page.mainFrame();
    const current = this.#documents.get(frame);
    if (current && loaderId === this.#loader && this.#seenMainNavigation === this.#mainNavigation) return current;
    for (const known of this.#documents.keys()) this.#forget(known);
    this.#loader = loaderId;
    this.#seenMainNavigation = this.#mainNavigation;
    const doc = { frame, generation: ++this.#generation };
    this.#documents.set(frame, doc);
    return doc;
  }

  async #child(frame: Frame): Promise<FrameDocument | undefined> {
    const current = this.#documents.get(frame);
    // Compare in the frame's current execution context. An old handle cannot be used in a new context.
    if (current?.handle && (await frame.evaluate((old) => old === document, current.handle).catch(() => false)))
      return current;
    this.#forget(frame);
    if (frame.isDetached()) return undefined;
    const handle = await frame.evaluateHandle(() => document).catch(() => undefined);
    if (!handle) return undefined;
    if (frame.isDetached()) {
      await handle.dispose().catch(() => undefined);
      return undefined;
    }
    const doc = { frame, handle, generation: ++this.#generation };
    this.#documents.set(frame, doc);
    return doc;
  }

  async #readAll(): Promise<[FrameDocument, ...FrameDocument[]]> {
    const main = await this.#main();
    const children = await Promise.all(
      this.#page
        .frames()
        .filter((frame) => frame !== main.frame)
        .map((frame) => this.#child(frame)),
    );
    return [main, ...children.filter((doc) => doc !== undefined)];
  }

  /** The fN routing is Playwright's. Ask it for one node per prefix and check the actual owning frame. */
  async #binding(rawRefs: Iterable<string>, before: Map<Frame, FrameDocument>): Promise<Map<string, FrameDocument>> {
    const bindings = new Map<string, FrameDocument>();
    for (const ref of rawRefs) {
      const prefix = nativeRefPrefix(ref);
      if (prefix === undefined || bindings.has(prefix)) continue;
      const handle = await this.#element(ref);
      if (!handle) continue;
      try {
        const frame = await handle.ownerFrame().catch(() => null);
        const doc = frame && before.get(frame);
        if (doc) bindings.set(prefix, doc);
      } finally {
        await handle.dispose().catch(() => undefined);
      }
    }
    return bindings;
  }

  capture<T>(read: (bind: (refs: Iterable<string>) => Promise<Scope>) => Promise<T>): Promise<T> {
    return this.#serial(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const docs = await this.#readAll();
        const [main] = docs;
        const before = new Map(docs.map((doc) => [doc.frame, doc]));
        let bindings: Map<string, FrameDocument> | undefined;
        const result = await read(async (refs) => {
          bindings = await this.#binding(refs, before);
          const prefixes = new Map(
            [...bindings].map(([prefix, doc]) => [prefix, `p${doc.generation}${doc === main ? "" : prefix}`]),
          );
          return { generation: main.generation, prefixes };
        });
        const after = await this.#readAll();
        if (before.size !== after.length || after.some((doc) => before.get(doc.frame) !== doc)) continue;
        for (const [prefix, doc] of bindings ?? []) doc.nativePrefix = prefix;
        return result;
      }
      throw new Error("The page changed while reading it. Take a new snapshot.");
    });
  }

  async #element(rawRef: string): Promise<ElementHandle<Node> | undefined> {
    const [handle] = await this.#page
      .locator(`aria-ref=${rawRef}`)
      .elementHandles()
      .catch((error: unknown) => {
        if (error instanceof Error && /Invalid frame in aria-ref selector/.test(error.message)) return [];
        throw error;
      });
    return handle;
  }

  /** Pin the element so a Playwright retry cannot resolve the same raw ref in another document. */
  target(ref: string): Promise<ElementHandle<Node>> {
    const parts = REF.exec(ref);
    if (!parts || ref.length > 40) return Promise.reject(new Error("That is not a ref from browser_snapshot."));
    return this.#serial(async () => {
      const [, generation, framePrefix, element] = parts;
      const fail = (reason: "stale" | "earlier-page") => new BrowserActionError({ reason }, this.#page.url());
      const main = await this.#main();
      const doc = [...this.#documents.values()].find((candidate) => `${candidate.generation}` === generation);
      if (!doc || (doc !== main && (await this.#child(doc.frame)) !== doc)) throw fail("earlier-page");
      const prefix = doc.nativePrefix;
      if (prefix === undefined || (doc === main ? undefined : prefix) !== framePrefix) throw fail("stale");
      const handle = await this.#element(`${prefix}${element}`);
      try {
        if ((await this.#main()) !== main || (doc !== main && (await this.#child(doc.frame)) !== doc))
          throw fail("earlier-page");
        if (!handle || (await handle.ownerFrame()) !== doc.frame) throw fail("stale");
        return handle;
      } catch (error) {
        await handle?.dispose().catch(() => undefined);
        throw error;
      }
    });
  }
}
