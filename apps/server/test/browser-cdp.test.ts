import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DriverEvent } from "../src/browser/driver.ts";
import { fieldRefusal } from "../src/browser/effects.ts";
import { mapSnapshotRefs, snapshotRef } from "../src/browser/snapshot-view.ts";
import { CdpBrowserDriver, labelsOf } from "../src/node/browser-cdp.ts";
import { nullLogger } from "../src/util/log.ts";
import { ACTION_FAILURES, serveBrowserFixtures } from "./fixtures/browser.ts";

// The CDP adapter against a real Chromium: set REI_BROWSER_CDP to the browser container's DevTools endpoint
// (for example `docker run -p 127.0.0.1:19223:9223 rei/browser:dev`, then http://127.0.0.1:19223). Skipped otherwise.
// For a standalone fixture browser, launch Chromium with --disable-back-forward-cache, matching wake.sh.
const ENDPOINT = process.env.REI_BROWSER_CDP;

const PAGE = `<!doctype html><title>start</title><body style="margin:0">
<h1>Hello</h1>
<form onsubmit="document.title='submitted';return false">
  <input id=name aria-label="Name" oninput="document.title='typed:'+this.value" style="position:fixed;left:10px;top:200px;width:300px;height:30px">
  <select id=s aria-label="Colour" onchange="document.title='picked:'+this.value" style="position:fixed;left:10px;top:260px;width:200px;height:30px"><option value=r>Red</option><option value=g>Green</option></select>
  <button type=submit>Send</button>
</form>
<button onclick="document.title='clicked:'+event.isTrusted">Go</button>
<input type=password aria-label="Secret">
<a href="http://other.test/x">Out</a>
<button onclick="alert('hi');document.title='after alert'">Alert</button>
<button onclick="window.open('http://popup.test/')">Pop</button>
<button style="position:fixed;left:700px;top:100px;width:100px;height:40px" onclick="document.title='asked:'+confirm('sure?')">Ask</button>
<div id=pad style="position:fixed;left:400px;top:100px;width:200px;height:100px;background:#c00" onmousedown="document.title='down:'+event.buttons" onmousemove="document.title='move:'+event.buttons" onclick="document.title='padclick:'+event.isTrusted;this.style.background=this.style.background==='rgb(0, 204, 0)'?'#c00':'#0c0'"></div>
</body>`;
const URL_A = `data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`;
const URL_B = `data:text/html;charset=utf-8,${encodeURIComponent("<title>second</title>second")}`;

const URL_C = `data:text/html;charset=utf-8,${encodeURIComponent(
  // Counts the children of <html> in the title whenever they change, so a left-over overlay shows.
  "<title>c</title><button>Hit</button><script>new MutationObserver(()=>{document.title='kids:'+document.documentElement.childElementCount}).observe(document.documentElement,{childList:true})</script>",
)}`;

const ref = (snapshot: string, role: string, name: string): string => {
  const line = snapshot.split("\n").find((line) => line.trimStart().startsWith(`- ${role} "${name}"`));
  const m = /\[ref=(p\d+(?:f\d+)?e\d+)\]/.exec(line ?? "");
  if (!m) throw new Error(`no ${role} ${name} in\n${snapshot}`);
  return m[1]!;
};
const until = async (fn: () => boolean | Promise<boolean>, ms = 5_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting");
};

describe("labelsOf", () => {
  const view = { width: 1000, height: 700 };
  const box = (x: number, y: number, width = 50, height = 20) => ({ x, y, width, height });

  it("keeps what can be acted on and is in view, in page order, and ignores the rest", () => {
    const tree = [
      { role: "heading", name: "Hi", ref: "e1", box: box(0, 0) },
      {
        role: "form",
        children: [
          { role: "button", name: "Send", ref: "e2", box: box(10, 10) },
          { role: "generic", ref: "e3", cursor: "pointer", box: box(10, 40) },
          { role: "button", name: "Off", ref: "e4", box: box(10, 900) },
          { role: "button", name: "Flat", ref: "e5", box: box(10, 10, 0, 20) },
          { role: "button", name: "No ref", box: box(10, 10) },
          { role: "button", name: "No box", ref: "e6" },
          { role: "textbox", name: "Name", ref: "e7", box: box(-20, 100) },
        ],
      },
    ];
    expect(labelsOf(tree, view).map((l) => l.label)).toEqual([
      { ref: "e2", role: "button", name: "Send" },
      { ref: "e3", role: "generic", name: "" },
      { ref: "e7", role: "textbox", name: "Name" },
    ]);
  });

  it("stops at the cap", () => {
    const tree = Array.from({ length: 300 }, (_, i) => ({ role: "button", ref: `e${i}`, box: box(0, 0) }));
    expect(labelsOf(tree, view)).toHaveLength(150);
    expect(labelsOf(tree, view, 5)).toHaveLength(5);
  });
});

describe.skipIf(!ENDPOINT)("CdpBrowserDriver against a real Chromium", () => {
  let driver: CdpBrowserDriver;
  let fixtures: Awaited<ReturnType<typeof serveBrowserFixtures>>;
  const events: DriverEvent[] = [];
  const title = async (key: string) => (await driver.pageInfo(key)).title;

  const snapshot = async (key: string) => {
    const raw = await driver.snapshot(key);
    return mapSnapshotRefs(raw.raw, (ref) => snapshotRef(raw, ref));
  };

  beforeAll(async () => {
    fixtures = await serveBrowserFixtures();
    driver = new CdpBrowserDriver({ endpoint: ENDPOINT!, log: nullLogger });
    driver.onEvent((e) => events.push(e));
  });
  afterAll(async () => {
    for (const k of ["a", "b"]) await driver.closeWindow(k).catch(() => undefined);
    await driver.close();
    await fixtures.close();
  });

  it("opens windows, reads a snapshot with refs and acts by ref", async () => {
    await driver.openWindow("a");
    await driver.openWindow("b");
    expect(driver.hasWindow("a") && driver.hasWindow("b")).toBe(true);
    await driver.goto("a", URL_A);
    const snap = await snapshot("a");
    expect(snap).toContain("Hello");
    const go = ref(snap, "button", "Go");
    await driver.click("a", go);
    // A trusted click: the page sees a real user event, not a synthetic one.
    expect(await title("a")).toBe("clicked:true");
    const send = await driver.describe("a", ref(snap, "button", "Send"));
    expect(send).toMatchObject({ role: "button", name: "Send" });
    expect(await driver.describe("a", ref(snap, "link", "Out"))).toMatchObject({ role: "link", name: "Out" });
    expect(await driver.describe("a", ref(snap, "textbox", "Secret"))).toMatchObject({
      type: "password",
      editable: true,
    });
    await driver.type("a", ref(snap, "textbox", "Name"), "Ada", false);
    expect(await title("a")).toBe("typed:Ada");
    await driver.select("a", ref(snap, "combobox", "Colour"), ["g"]);
    expect(await title("a")).toBe("picked:g");
    await driver.type("a", ref(snap, "textbox", "Name"), "Bob", true);
    await until(async () => (await title("a")) === "submitted");
    await expect(driver.click("a", go.replace(/e\d+$/, "e99999"))).rejects.toMatchObject({
      failure: { reason: "stale" },
    });
    await expect(driver.click("a", "x; y")).rejects.toThrow(/ref/);
  });

  it("sends the exact in-memory bytes through a direct input and a dynamic chooser to an auto-uploading page", async () => {
    const key = "upload-test";
    await driver.openWindow(key);
    try {
      const url = `${fixtures.origin}/upload`;
      await driver.goto(key, url);
      const snap = await snapshot(key);
      const direct = ref(snap, "button", "Direct file");
      const button = ref(snap, "button", "Choose file");
      const directTarget = await driver.uploadTarget(key, direct);
      const chooserTarget = await driver.uploadTarget(key, button);
      expect(directTarget).toMatchObject({ kind: "input", frameUrl: url });
      expect(chooserTarget).toMatchObject({ kind: "chooser", frameUrl: url });
      const file = (name: string, contents: string) => ({
        name,
        mediaType: "text/plain",
        bytes: new TextEncoder().encode(contents),
      });
      const notes = () => events.filter((event) => event.type === "note").length;
      const before = notes();
      await driver.click(key, button);
      expect(notes()).toBe(before + 1);
      await driver.upload(key, direct, directTarget, file("direct.txt", "direct payload"), () => {});
      await until(async () => (await title(key)) === "direct.txt|text/plain|direct payload");
      await driver.upload(key, button, chooserTarget, file("chooser.txt", "chooser payload"), () => {});
      await until(async () => (await title(key)) === "chooser.txt|text/plain|chooser payload");
      expect(notes()).toBe(before + 1);

      await driver.goto(key, url);
      await expect(
        driver.upload(key, direct, directTarget, file("stale.txt", "stale"), () => {}),
      ).rejects.toMatchObject({
        failure: { reason: "earlier-page" },
      });
    } finally {
      await driver.closeWindow(key);
    }
  });

  it("returns a native file handle to a site that requires showOpenFilePicker", async () => {
    const key = "upload-native";
    await driver.openWindow(key);
    try {
      await driver.goto(key, `${fixtures.origin}/upload`);
      const button = ref(await snapshot(key), "button", "Open drawing");
      const target = await driver.uploadTarget(key, button);
      const file = { name: "drawing.json", mediaType: "application/json", bytes: new TextEncoder().encode("{}") };
      let checks = 0;
      await expect(
        driver.upload(key, button, target, file, () => {
          if (++checks === 3) throw new Error("Approval was revoked.");
        }),
      ).rejects.toThrow("Approval was revoked.");
      await until(async () => (await title(key)) === "AbortError");
      await driver.upload(key, button, target, file, () => {});
      await until(async () => (await title(key)) === "drawing.json|application/json|{}|native handle");
    } finally {
      await driver.closeWindow(key);
    }
  });

  it("goes back, and says when there is nothing to go back to", async () => {
    await driver.goto("a", URL_B);
    expect(await driver.back("a")).toBe(true);
    expect(await title("a")).toBe("start");
    await driver.openWindow("c");
    expect(await driver.back("c")).toBe(false);
    await driver.closeWindow("c");
  });

  it("takes a JPEG screenshot", async () => {
    const shot = await driver.screenshot("a");
    expect(shot.mimeType).toBe("image/jpeg");
    expect(Buffer.from(shot.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
  });

  it("annotates a screenshot with the refs of what can be acted on, takes the overlay down again, and the refs work", async () => {
    await driver.goto("a", URL_A);
    const shot = await driver.screenshot("a", { annotate: true });
    expect(Buffer.from(shot.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
    const labels = shot.labels ?? [];
    const find = (role: string, name: string) => labels.find((l) => l.role === role && l.name === name);
    expect(find("button", "Send")).toBeDefined();
    expect(find("button", "Go")).toBeDefined();
    expect(find("textbox", "Name")).toBeDefined();
    // A plain screenshot has no labels.
    expect((await driver.screenshot("a")).labels).toBeUndefined();
    // The refs are the snapshot's: a label's ref clicks the same button.
    await driver.click("a", find("button", "Go")!.ref);
    expect(await title("a")).toBe("clicked:true");
    // The overlay is gone: the page saw its host added and removed again, and <html> has its two children (head, body).
    await driver.goto("a", URL_C);
    const tagged = await driver.screenshot("a", { annotate: true });
    expect(tagged.labels).toContainEqual(expect.objectContaining({ role: "button", name: "Hit" }));
    await until(async () => (await title("a")) === "kids:2");
    await driver.goto("a", URL_A);
  });

  it("answers dialogs by itself, or waits for the user", async () => {
    const snap = await snapshot("a");
    events.length = 0;
    await driver.click("a", ref(snap, "button", "Alert"));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "dialog", kind: "alert", handled: true, accepted: true }),
    );
    expect(await title("a")).toBe("after alert");
    // In a takeover the dialog waits for the user, and the click that opened it returns at once (the page does not
    // acknowledge it until the dialog is answered).
    await driver.goto("a", URL_A);
    driver.setDialogMode("a", "ask");
    events.length = 0;
    await driver.input("a", { type: "mouse", action: "down", x: 720, y: 110, button: "left", clickCount: 1 });
    await driver.input("a", { type: "mouse", action: "up", x: 720, y: 110, button: "left", clickCount: 1 });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "dialog", kind: "confirm", message: "sure?", handled: false }),
    );
    await driver.handleDialog("a", true);
    await until(async () => (await title("a")) === "asked:true");
    driver.setDialogMode("a", "auto");
  });

  it("closes pages the page opens", async () => {
    const snap = await snapshot("a");
    events.length = 0;
    await driver.click("a", ref(snap, "button", "Pop"));
    await until(() => events.some((e) => e.type === "popup"));
    expect(driver.hasWindow("a")).toBe(true);
  });

  it("maps pointer and keyboard input the way the PWA sends it", async () => {
    await driver.goto("a", URL_A);
    // A hover arrives as button "left", count 0, and must not look like a held button.
    await driver.input("a", { type: "mouse", action: "move", x: 450, y: 150, button: "left", clickCount: 0 });
    await until(async () => (await title("a")) === "move:0");
    await driver.input("a", { type: "mouse", action: "down", x: 450, y: 150, button: "left", clickCount: 1 });
    expect(await title("a")).toBe("down:1");
    await driver.input("a", { type: "mouse", action: "up", x: 450, y: 150, button: "left", clickCount: 1 });
    expect(await title("a")).toBe("padclick:true");
    // Typing: a key down with text, then Space and IME text.
    for (const [x, y] of [[100, 215]] as const) {
      await driver.input("a", { type: "mouse", action: "down", x, y, button: "left", clickCount: 1 });
      await driver.input("a", { type: "mouse", action: "up", x, y, button: "left", clickCount: 1 });
    }
    await driver.input("a", { type: "key", action: "down", key: "a", code: "KeyA", text: "a", modifiers: 0 });
    await driver.input("a", { type: "key", action: "up", key: "a", code: "KeyA", modifiers: 0 });
    await driver.input("a", { type: "key", action: "down", key: " ", code: "Space", text: " ", modifiers: 0 });
    await driver.input("a", { type: "key", action: "up", key: " ", code: "Space", modifiers: 0 });
    await driver.input("a", { type: "text", text: "你好" });
    expect(await title("a")).toBe("typed:a 你好");
    expect(await driver.focusedField("a")).toMatchObject({ role: "textbox", name: "Name" });
    await driver.input("a", { type: "key", action: "down", key: "Backspace", code: "Backspace", modifiers: 0 });
    await driver.input("a", { type: "key", action: "up", key: "Backspace", code: "Backspace", modifiers: 0 });
    expect(await title("a")).toBe("typed:a 你");
  });

  it("offers a select to the picker after a click and applies the answer", async () => {
    events.length = 0;
    await driver.input("a", { type: "mouse", action: "down", x: 100, y: 275, button: "left", clickCount: 1 });
    await driver.input("a", { type: "mouse", action: "up", x: 100, y: 275, button: "left", clickCount: 1 });
    const offered = events.find((e) => e.type === "select");
    expect(offered).toMatchObject({
      type: "select",
      multiple: false,
      options: [
        expect.objectContaining({ label: "Red", value: "r" }),
        expect.objectContaining({ label: "Green", value: "g" }),
      ],
    });
    await driver.setSelectValues("a", ["g"]);
    expect(await title("a")).toBe("picked:g");
    // The native popup is gone: the next click lands on the page, not on a popup.
    await driver.input("a", { type: "mouse", action: "down", x: 450, y: 150, button: "left", clickCount: 1 });
    await driver.input("a", { type: "mouse", action: "up", x: 450, y: 150, button: "left", clickCount: 1 });
    expect(await title("a")).toBe("padclick:true");
  });

  it("streams frames, also from a window that another window covers", async () => {
    // "b" was opened after "a", so "a" is behind it.
    const frames: Uint8Array[] = [];
    const stop = await driver.startScreencast("a", (f) => frames.push(f));
    await until(() => frames.length > 0);
    expect(Buffer.from(frames[0]!).subarray(0, 2).toString("hex")).toBe("ffd8");
    const before = frames.length;
    await driver.input("a", { type: "mouse", action: "down", x: 450, y: 150, button: "left", clickCount: 1 });
    await driver.input("a", { type: "mouse", action: "up", x: 450, y: 150, button: "left", clickCount: 1 });
    expect(await title("a")).toBe("padclick:true");
    await until(() => frames.length > before);
    await stop();
    const vp = await driver.viewport("a");
    expect(vp.width).toBeGreaterThan(800);
    expect(vp.height).toBeGreaterThan(500);
  });

  it("refuses navigations the guard refuses, and lets them through when it is lifted", async () => {
    events.length = 0;
    driver.setNavigationGuard("a", (url) => url.hostname !== "blocked.test");
    await expect(driver.goto("a", "http://blocked.test/")).rejects.toThrow(/blocked/);
    expect(events).toContainEqual({ type: "blocked", key: "a", host: "blocked.test" });
    driver.setNavigationGuard("a", null);
    await driver.goto("a", URL_B);
  });

  it("reports a window the user closed, and opens a fresh one for the key", async () => {
    events.length = 0;
    await driver.closeWindow("b");
    expect(events.some((e) => e.type === "closed")).toBe(false);
    expect(driver.hasWindow("b")).toBe(false);
    await driver.openWindow("b", URL_B);
    expect((await driver.pageInfo("b")).title).toBe("second");
  });

  it.each([
    ["Submit", { reason: "covered", coveringElement: '<div#notice.cookie-banner.visible "We use cookies">' }],
    ["Hide me", { reason: "hidden" }],
    ["Disabled", { reason: "disabled" }],
  ])("reports why it could not click %s", async (name, failure) => {
    await driver.goto("a", `data:text/html;charset=utf-8,${encodeURIComponent(ACTION_FAILURES)}`);
    const snap = await snapshot("a");
    if (name === "Hide me") await driver.click("a", ref(snap, "button", "Hide button"));
    await expect(driver.click("a", ref(snap, "button", name))).rejects.toMatchObject({ failure });
  });

  it("lists the actual option labels when none match", async () => {
    await driver.goto("a", `data:text/html;charset=utf-8,${encodeURIComponent(ACTION_FAILURES)}`);
    const size = ref(await snapshot("a"), "combobox", "Size");
    await expect(driver.select("a", size, ["Tall"])).rejects.toMatchObject({
      failure: { reason: "options-not-found", labels: ["Small", "Medium", "Large"] },
    });
  });

  it("loads a fresh document on Back and rejects refs from the previous visit", async () => {
    await driver.goto("a", `${fixtures.origin}/refs`);
    const snap = await snapshot("a");
    const first = ref(snap, "button", "Main action [ref=e99]");
    const child = ref(snap, "button", "Old frame action");
    expect(first).toMatch(/^p\d+e\d+$/);
    expect(child).toMatch(/^p\d+f\d+e\d+$/);
    await driver.click("a", ref(snap, "button", "Fresh document marker"));
    expect(await snapshot("a")).not.toContain("Fresh document marker");
    await driver.goto("a", `${fixtures.origin}/refs/next`);
    await snapshot("a");
    await expect(driver.click("a", first)).rejects.toMatchObject({ failure: { reason: "earlier-page" } });
    expect(await driver.back("a")).toBe(true);
    const returned = await snapshot("a");
    expect(returned).toContain('button "Fresh document marker"');
    const freshMain = ref(returned, "button", "Main action [ref=e99]");
    const freshChild = ref(returned, "button", "Old frame action");
    expect(freshMain).not.toBe(first);
    expect(freshChild).not.toBe(child);
    await expect(driver.describe("a", first)).rejects.toMatchObject({ failure: { reason: "earlier-page" } });
    await driver.click("a", freshMain);
    expect(await title("a")).toBe("main clicked");
  });

  it("keeps refs on history.pushState", async () => {
    await driver.goto("a", `${fixtures.origin}/refs`);
    const snap = await snapshot("a");
    await driver.click("a", ref(snap, "button", "Push state"));
    expect((await driver.pageInfo("a")).url).toBe(`${fixtures.origin}/refs?next`);
    expect(ref(await snapshot("a"), "button", "Main action [ref=e99]")).toBe(
      ref(snap, "button", "Main action [ref=e99]"),
    );
  });

  it("rejects the old ref when an iframe loads another document with the same native ref", async () => {
    await driver.goto("a", `${fixtures.origin}/refs`);
    const snap = await snapshot("a");
    const old = ref(snap, "button", "Old frame action");
    await driver.click("a", ref(snap, "button", "Change iframe"));
    await until(async () => (await title("a")) === "Child two");
    const next = ref(await snapshot("a"), "button", "New frame action");
    expect(next.replace(/^p\d+/, "")).toBe(old.replace(/^p\d+/, ""));
    expect(next).not.toBe(old);
    await expect(driver.click("a", old)).rejects.toMatchObject({ failure: { reason: "earlier-page" } });
    expect(await title("a")).toBe("Child two");
    await driver.click("a", next);
    expect(await title("a")).toBe("child clicked");
  });

  it("keeps main-page and sibling-frame refs through an iframe navigation", async () => {
    await driver.goto("a", `${fixtures.origin}/refs`);
    const snap = await snapshot("a");
    const main = ref(snap, "button", "Main action [ref=e99]");
    const sibling = ref(snap, "button", "Stable frame action");
    await driver.click("a", ref(snap, "button", "Change iframe"));
    await until(async () => (await title("a")) === "Child two");
    // No intervening snapshot: the original ref still acts on the main page.
    await driver.click("a", main);
    expect(await title("a")).toBe("main clicked");
    const after = await snapshot("a");
    expect(ref(after, "button", "Main action [ref=e99]")).toBe(main);
    expect(ref(after, "button", "Stable frame action")).toBe(sibling);
  });

  it.each(["click", "Enter", "type and submit"])(
    "settles the main page after %s starts a delayed navigation",
    async (action) => {
      await driver.goto("a", `${fixtures.origin}/settle`);
      const snap = await snapshot("a");
      const search = ref(snap, "textbox", "Search");
      if (action === "click") {
        await driver.click("a", ref(snap, "link", "Delayed link"));
      } else if (action === "Enter") {
        await driver.click("a", search);
        await driver.press("a", "Enter");
      } else {
        await driver.type("a", search, "Rei", true);
      }
      const result = await snapshot("a");
      expect(result).toContain('heading "Settled result"');
      expect(result).toContain("Resource loaded");
    },
  );

  it("returns a no-op click after the short navigation window", async () => {
    await driver.goto("a", `${fixtures.origin}/settle`);
    const noop = ref(await snapshot("a"), "button", "No change");
    const start = performance.now();
    await driver.click("a", noop);
    expect(performance.now() - start).toBeLessThan(950);
    expect(await title("a")).toBe("Before navigation");
  });

  it("waits for text to appear or disappear and for a ref to become enabled", async () => {
    await driver.goto("a", `${fixtures.origin}/waiting`);
    const snap = await snapshot("a");
    const confirm = ref(snap, "button", "Confirm order");
    expect(await driver.wait("a", { target: "ref", value: confirm, gone: false }, 100)).toBe(false);
    await driver.click("a", ref(snap, "button", "Prepare order"));
    await expect(
      Promise.all([
        driver.wait("a", { target: "text", value: "Order placed", gone: false }, 3_000),
        driver.wait("a", { target: "text", value: "Preparing order", gone: true }, 3_000),
        driver.wait("a", { target: "ref", value: confirm, gone: false }, 3_000),
      ]),
    ).resolves.toEqual([true, true, true]);
    expect(await snapshot("a")).toContain("Order placed");
    expect(await driver.wait("a", { target: "text", value: "Not in the fixture", gone: false }, 100)).toBe(false);
  });

  it("waits for an address glob and substring", async () => {
    await driver.goto("a", `${fixtures.origin}/waiting`);
    await driver.click("a", ref(await snapshot("a"), "button", "Go later"));
    expect(await driver.wait("a", { target: "url", value: "**/settled?step=*", gone: false }, 3_000)).toBe(true);
    expect(await driver.wait("a", { target: "url", value: "/settled", gone: false }, 100)).toBe(true);
  });

  it("wheel-scrolls the panel under the viewport centre to load more rows", async () => {
    await driver.goto("a", `${fixtures.origin}/feed`);
    expect(await snapshot("a")).not.toContain("More rows loaded");
    await driver.scroll("a", { direction: "down", pages: 1 });
    expect(await snapshot("a")).toContain("More rows loaded");
    await driver.scroll("a", { direction: "up", pages: 2 });
    await until(async () => (await title("a")) === "Top of feed");
    await driver.scroll("a", { ref: ref(await snapshot("a"), "button", "Last row") });
    expect(await title("a")).toBe("Scrolled feed");
  });

  it("hovers to open both CSS and JavaScript menus", async () => {
    await driver.goto("a", `${fixtures.origin}/controls`);
    const before = await snapshot("a");
    expect(before).not.toContain("menu item");
    await driver.hover("a", ref(before, "button", "CSS trigger"));
    const css = await snapshot("a");
    expect(css).toContain('button "CSS menu item"');
    await driver.hover("a", ref(css, "button", "JS trigger"));
    expect(await snapshot("a")).toContain('button "JS menu item"');
  });

  it("sets checkboxes idempotently, selects radios and sets switches", async () => {
    await driver.goto("a", `${fixtures.origin}/controls`);
    const before = await snapshot("a");
    const box = ref(before, "checkbox", "Remember me");
    expect(await driver.check("a", box, true)).toBe(false);
    expect(await driver.check("a", box, true)).toBe(true);
    expect(await title("a")).toBe("1");
    expect(await driver.check("a", box, false)).toBe(false);
    expect(await driver.check("a", box, false)).toBe(true);
    expect(await title("a")).toBe("2");
    for (const name of ["Red", "Blue"]) {
      await expect(driver.check("a", ref(before, "radio", name), false)).rejects.toMatchObject({
        failure: { reason: "radio-uncheck" },
      });
    }
    const blue = ref(before, "radio", "Blue");
    expect(await driver.check("a", blue, true)).toBe(false);
    expect(await driver.check("a", blue, true)).toBe(true);
    expect(await driver.check("a", ref(before, "switch", "Notifications"), true)).toBe(false);
    expect(await snapshot("a")).toMatch(/switch "Notifications"[^\n]*\[checked\]/);
    await expect(driver.check("a", ref(before, "button", "JS trigger"), true)).rejects.toMatchObject({
      failure: { reason: "not-checkable" },
    });
  });

  it("clears the field and fires input for each successive character of Abé中", async () => {
    await driver.goto("a", `${fixtures.origin}/typing`);
    const autocomplete = ref(await snapshot("a"), "textbox", "Autocomplete");
    await driver.type("a", autocomplete, "Abé中", false, { refusalForField: fieldRefusal });
    expect(JSON.parse(await title("a"))).toEqual({
      inputs: ["", "A", "Ab", "Abé", "Abé中"],
      keys: ["Delete", "A", "b"],
    });
  });

  it("clicks a custom field for slow typing and refuses if that click focuses a password", async () => {
    await driver.goto("a", `${fixtures.origin}/typing`);
    const snap = await snapshot("a");
    const custom = ref(snap, "button", "Custom keyboard widget");
    await expect(driver.type("a", custom, "A", false)).rejects.toMatchObject({
      failure: { reason: "not-fillable" },
    });
    await driver.type("a", custom, "Ab", false, { refusalForField: fieldRefusal });
    expect(await title("a")).toBe("TypingAb");
    await expect(
      driver.type("a", ref(snap, "button", "Focus password"), "Ab", false, { refusalForField: fieldRefusal }),
    ).rejects.toMatchObject({
      failure: { reason: "field-refused" },
    });
    expect(await title("a")).toBe("TypingAb");
  });

  it("releases the connection quietly when no window is open, and connects again for the next window", async () => {
    const lines: string[] = [];
    const log = {
      ...nullLogger,
      warn: (m: string) => void lines.push(`warn ${m}`),
      info: (m: string) => void lines.push(`info ${m}`),
    };
    const d = new CdpBrowserDriver({ endpoint: ENDPOINT!, log });
    const closed: DriverEvent[] = [];
    d.onEvent((e) => e.type === "closed" && closed.push(e));
    await d.openWindow("r");
    await d.release(); // a window is open: nothing happens
    expect(d.hasWindow("r")).toBe(true);
    await d.closeWindow("r");
    await d.release();
    expect(lines).toContain("info browser.released");
    expect(lines).not.toContain("warn browser.disconnected");
    expect(closed).toEqual([]);
    await d.openWindow("r", URL_B);
    expect((await d.pageInfo("r")).title).toBe("second");
    await d.closeWindow("r");
    await d.close();
  });
});
