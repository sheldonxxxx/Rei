import type { LiveClientMessage, Session, Takeover } from "@rei/protocol";
import type { ClipboardEvent, CompositionEvent, CSSProperties, FormEvent, KeyboardEvent, PointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { cn } from "@/lib/utils.ts";
import type { Api } from "../api/client.ts";
import { ApiError, describeError } from "../api/client.ts";
import { hostOf, normalizeAddress } from "../lib/browser.ts";
import type { PointerLike } from "../lib/browserInput.ts";
import { keyUpOf, modifiersOf, PointerMapper, planKeyDown, toPagePoint } from "../lib/browserInput.ts";
import type { LiveStatus } from "../stream/browserLive.ts";
import { useBrowserLive } from "../stream/browserLive.ts";
import { PageDialog, SelectPicker } from "./BrowserDialogs.tsx";
import { Icon } from "./Icon.tsx";
import { FULL_SHEET, PANEL_HEAD, PANEL_TITLE, SIDE_PANEL } from "./panelStyles.ts";
import { Tip } from "./Tip.tsx";

interface Props {
  id: string;
  api: Api;
  session: Session;
  /** Each increase asks the panel to take over now (the "Take over" button on a takeover card). */
  startSignal: number;
  onClose: () => void;
  /**
   * - side: beside the chat (wide screens)
   * - focus: expanded over the whole main area, the chat column hidden; the picture scales to the largest size that fits
   * - sheet: a phone's full-screen sheet
   */
  layout?: BrowserLayout;
  /** Expand (in "side") or go back to the chat (in "focus"). Omit to hide the button. */
  onToggleExpand?: (() => void) | undefined;
}

export type BrowserLayout = "side" | "focus" | "sheet";

const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const WHEEL_LINE_PX = 16;

const STATUS_LABEL: Record<LiveStatus, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  closed: "Window closed",
  denied: "Can't watch",
};

type Key = Extract<LiveClientMessage, { type: "key" }>;

/**
 * Live view of this chat's browser window, and taking it over. Beside the chat on wide screens, expanded over the whole
 * main area (`layout`), or a full-screen sheet on phones. The picture is the window's own screencast; your input goes to that window only, and only while the
 * server says you are in control.
 */
export function BrowserPanel({ id, api, session, startSignal, onClose, layout = "side", onToggleExpand }: Props) {
  const browser = session.browser;
  const closeBtn = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  const frameSeq = useRef(0);
  const [hasFrame, setHasFrame] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyboardOn, setKeyboardOn] = useState(false);

  // The server's takeover (from the session stream) is the truth. Right after you start one, the stream may not have said
  // so yet, so the POST's answer stands in until the next session update.
  const [local, setLocal] = useState<{ takeover: Takeover; base: Session } | null>(null);
  const takeover: Takeover | null = browser?.takeover ?? (local && local.base === session ? local.takeover : null);
  const active = takeover?.status === "active";
  const pending = takeover?.status === "pending";

  const drawFrame = useCallback((jpeg: Blob) => {
    const seq = ++frameSeq.current;
    if (typeof createImageBitmap !== "function") return;
    createImageBitmap(jpeg).then(
      (bitmap) => {
        const c = canvas.current;
        const ctx = c?.getContext("2d");
        if (seq === frameSeq.current && c && ctx) {
          if (c.width !== bitmap.width || c.height !== bitmap.height) {
            c.width = bitmap.width;
            c.height = bitmap.height;
          }
          ctx.drawImage(bitmap, 0, 0);
          setHasFrame(true);
        }
        bitmap.close();
      },
      () => {}, // a frame that doesn't decode is skipped; the next one replaces it
    );
  }, []);

  const live = useBrowserLive(session.id, !!browser, drawFrame);
  const viewport = live.viewport ?? DEFAULT_VIEWPORT;
  const closed = live.status === "closed" || !browser;
  const canControl = active && live.control && !closed;
  const title = live.title ?? browser?.title ?? "";
  const url = live.url ?? browser?.url ?? null;
  const host = hostOf(url);

  useEffect(() => {
    closeBtn.current?.focus();
  }, []);

  // ---- starting and ending a takeover ----

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.startTakeover(session.id);
      setLocal({ takeover: r.takeover, base: session });
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "already_active")) setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  const startRef = useRef(start);
  startRef.current = start;
  const lastSignal = useRef(startSignal);
  useEffect(() => {
    if (startSignal === lastSignal.current) return;
    lastSignal.current = startSignal;
    void startRef.current();
  }, [startSignal]);
  // Opened from a takeover card: start straight away.
  useEffect(() => {
    if (startSignal > 0) void startRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function end(action: "done" | "cancel") {
    if (!takeover) return;
    setBusy(true);
    setError(null);
    try {
      await api.endTakeover(takeover.id, { action });
      setLocal(null);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  // ---- input ----

  const sendRef = useRef(live.send);
  sendRef.current = live.send;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const mapper = useMemo(
    () =>
      new PointerMapper(
        (m) => sendRef.current(m),
        () => ({
          box: surface.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 },
          viewport: viewportRef.current,
        }),
      ),
    [],
  );
  useEffect(() => () => mapper.dispose(), [mapper]);

  const pointer = (e: PointerEvent): PointerLike => ({
    pointerId: e.pointerId,
    pointerType: e.pointerType,
    clientX: e.clientX,
    clientY: e.clientY,
    button: e.button,
  });

  // The wheel needs preventDefault (don't scroll the chat behind the picture), which React's passive listener can't do.
  useEffect(() => {
    const el = surface.current;
    if (!el || !canControl) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = el.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? viewportRef.current.height : 1;
      const { x, y } = toPagePoint(e.clientX, e.clientY, box, viewportRef.current);
      sendRef.current({ type: "wheel", x, y, dx: Math.round(e.deltaX * unit), dy: Math.round(e.deltaY * unit) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [canControl]);

  // Keys held down are released when the capture field loses focus, so none sticks on the page.
  const down = useRef(new Map<string, Key>());
  const releaseKeys = () => {
    for (const k of down.current.values()) sendRef.current(keyUpOf(k));
    down.current.clear();
  };
  const composing = useRef(false);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const plan = planKeyDown({
      key: e.key,
      code: e.code,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      isComposing: e.nativeEvent.isComposing || composing.current,
      keyCode: e.keyCode,
    });
    if (plan.kind !== "key") return;
    e.preventDefault();
    e.stopPropagation(); // Escape belongs to the page, not to the panel
    down.current.set(e.code, plan.down as Key);
    sendRef.current(plan.down);
  };
  const onKeyUp = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const k = down.current.get(e.code);
    if (!k) return;
    e.preventDefault();
    down.current.delete(e.code);
    sendRef.current(keyUpOf(k, modifiersOf(e)));
  };
  const onInput = (e: FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (composing.current || (e.nativeEvent as InputEvent).isComposing) return; // the result goes out at compositionend
    const text = el.value;
    el.value = "";
    if (text) sendRef.current({ type: "text", text });
  };
  const onCompositionEnd = (e: CompositionEvent<HTMLTextAreaElement>) => {
    composing.current = false;
    e.currentTarget.value = "";
    if (e.data) sendRef.current({ type: "text", text: e.data });
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (text) sendRef.current({ type: "text", text });
  };

  // Phone keyboards often report keys as "Unidentified"; Backspace and Return then only show up as beforeinput.
  useEffect(() => {
    const el = keys.current;
    if (!el || !canControl) return;
    const onBefore = (e: InputEvent) => {
      if (e.isComposing) return;
      const key =
        e.inputType === "deleteContentBackward" && el.value === ""
          ? { key: "Backspace", code: "Backspace" }
          : e.inputType === "insertLineBreak" || e.inputType === "insertParagraph"
            ? { key: "Enter", code: "Enter", text: "\r" }
            : null;
      if (!key) return;
      e.preventDefault();
      sendRef.current({ type: "key", action: "down", ...key, modifiers: 0 });
      sendRef.current({ type: "key", action: "up", key: key.key, code: key.code, modifiers: 0 });
    };
    el.addEventListener("beforeinput", onBefore);
    return () => el.removeEventListener("beforeinput", onBefore);
  }, [canControl]);

  // With a mouse and a physical keyboard, typing should just work; on a phone the Keyboard button opens the on-screen one.
  useEffect(() => {
    if (canControl && window.matchMedia?.("(pointer: fine)").matches) keys.current?.focus({ preventScroll: true });
  }, [canControl]);

  const toggleKeyboard = () => {
    const el = keys.current;
    if (!el) return;
    if (document.activeElement === el) el.blur();
    else el.focus();
  };

  // ---- address bar ----
  const [address, setAddress] = useState("");
  const editing = useRef(false);
  const [addressError, setAddressError] = useState(false);
  useEffect(() => {
    if (!editing.current) setAddress(url ?? "");
  }, [url]);
  const go = (e: FormEvent) => {
    e.preventDefault();
    const target = normalizeAddress(address);
    setAddressError(!target);
    if (!target) return;
    editing.current = false;
    setAddress(target);
    sendRef.current({ type: "goto", url: target });
  };

  const statusLabel = !browser && live.status !== "denied" ? STATUS_LABEL.closed : STATUS_LABEL[live.status];
  const surfaceHandlers = canControl
    ? {
        onPointerDown: (e: PointerEvent) => {
          if (e.pointerType !== "touch") {
            keys.current?.focus({ preventScroll: true });
            try {
              (e.currentTarget as Element).setPointerCapture(e.pointerId);
            } catch {
              // a synthetic event has no active pointer; the capture only keeps a drag going outside the picture
            }
          }
          e.preventDefault();
          mapper.down(pointer(e));
        },
        onPointerMove: (e: PointerEvent) => mapper.move(pointer(e)),
        onPointerUp: (e: PointerEvent) => mapper.up(pointer(e)),
        onPointerCancel: (e: PointerEvent) => mapper.cancel(pointer(e)),
        // Keep focus in the key field: a mouse press on a plain div would otherwise move it to the page body.
        onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
        onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
      }
    : {};

  const focus = layout === "focus";
  const side = layout === "side";
  const banner = cn(
    "takeover-banner mx-2.5 mb-2 flex flex-col gap-2 rounded-xl border border-attention-border bg-attention-soft p-3 text-sm text-foreground",
    focus && "m-0 flex-[1_1_30rem] flex-row flex-wrap items-center gap-x-3.5",
  );
  const line = cn(
    "takeover-line m-0 flex items-start gap-2 [overflow-wrap:anywhere] [&>svg]:mt-0.5 [&>svg]:shrink-0 [&>svg]:text-attention-text",
    focus && "flex-[1_1_13rem]",
  );
  const actions = "takeover-actions flex justify-end gap-2 max-md:[&>button]:flex-1";
  const navBtn = "text-muted-foreground";

  return (
    <>
      <aside
        className={cn(
          "browser-panel",
          layout,
          SIDE_PANEL,
          side && "min-w-85 max-w-190 flex-[0_0_45%]",
          focus && "min-w-0 max-w-none flex-[1_1_0] border-l-0",
          FULL_SHEET,
        )}
        id={id}
        aria-labelledby={`${id}-h`}
        data-layout={layout}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className={cn(PANEL_HEAD, focus && "gap-2.5 pt-[calc(8px+var(--safe-t))] pr-3.5 pl-4.5")}>
          <div className="browser-title flex min-w-0 flex-1 flex-col">
            <h3 id={`${id}-h`} className={cn(PANEL_TITLE, "truncate")}>
              {title || host || "Browser"}
            </h3>
            <div className="flex min-w-0 items-center gap-2">
              {host && title && <span className="browser-host truncate text-xs text-muted-foreground">{host}</span>}
              <Badge
                variant={live.status === "denied" || closed ? "destructive" : "secondary"}
                className={cn(
                  "browser-status",
                  (live.status === "reconnecting" || live.status === "connecting") &&
                    !closed &&
                    "bg-attention-soft text-attention-text",
                )}
                data-status={closed && live.status !== "denied" ? "closed" : live.status}
                role="status"
              >
                {live.status === "live" && !closed && (
                  <span className="live-dot size-2 shrink-0 rounded-full bg-live" aria-hidden="true" />
                )}
                {statusLabel}
              </Badge>
            </div>
          </div>
          {active ? (
            <Button type="button" size="sm" disabled={busy} aria-busy={busy} onClick={() => void end("done")}>
              Done
            </Button>
          ) : (
            !pending &&
            !closed && (
              <Button type="button" size="sm" disabled={busy} aria-busy={busy} onClick={() => void start()}>
                Take over
              </Button>
            )
          )}
          {onToggleExpand && side && (
            <Tip label="Expand browser">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={navBtn}
                aria-label="Expand browser"
                onClick={onToggleExpand}
              >
                <Icon name="expand" />
              </Button>
            </Tip>
          )}
          {onToggleExpand && focus && (
            <Tip label="Show the chat beside the browser">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="show-chat shrink-0"
                onClick={onToggleExpand}
              >
                <Icon name="collapse" size={16} />
                Show chat
              </Button>
            </Tip>
          )}
          <Tip label="Close">
            <Button
              ref={closeBtn}
              type="button"
              variant="ghost"
              size="icon-sm"
              className={navBtn}
              aria-label="Close browser"
              onClick={onClose}
            >
              <Icon name="close" />
            </Button>
          </Tip>
        </div>

        <div
          className={cn(
            "browser-controls",
            focus ? "flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 pb-2.5" : "contents",
          )}
        >
          {pending && (
            <div className={cn(banner, "pending")} role="group" aria-label="The assistant needs you">
              <p className={line}>
                <Icon name="pointer" size={16} />
                <span>
                  <strong className="font-semibold">The assistant needs you in the browser</strong>
                  {takeover?.reason ? `: ${takeover.reason}` : ""}
                </span>
              </p>
              <div className={actions}>
                <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void end("cancel")}>
                  Not now
                </Button>
                <Button type="button" size="sm" disabled={busy || closed} onClick={() => void start()}>
                  Take over
                </Button>
              </div>
            </div>
          )}
          {error && (
            <p
              role="alert"
              className={cn("form-error banner mx-2.5 mt-0 mb-2 w-auto max-w-none", focus && "m-0 basis-full")}
            >
              {error}
            </p>
          )}

          <form
            className={cn("browser-nav mx-2.5 mb-2 flex items-center gap-0.5", focus && "order-1 m-0 flex-[2_1_22rem]")}
            onSubmit={go}
          >
            <Tip label="Back">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={navBtn}
                aria-label="Back"
                disabled={!canControl}
                onClick={() => sendRef.current({ type: "nav", action: "back" })}
              >
                <Icon name="back" size={18} />
              </Button>
            </Tip>
            <Tip label="Forward">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={navBtn}
                aria-label="Forward"
                disabled={!canControl}
                onClick={() => sendRef.current({ type: "nav", action: "forward" })}
              >
                <Icon name="forward" size={18} />
              </Button>
            </Tip>
            <Tip label="Reload">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={navBtn}
                aria-label="Reload"
                disabled={!canControl}
                onClick={() => sendRef.current({ type: "nav", action: "reload" })}
              >
                <Icon name="reload" size={18} />
              </Button>
            </Tip>
            <Input
              className="browser-address ml-1 h-9 min-w-0 flex-1 bg-background px-3 text-sm"
              type="text"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Address"
              aria-invalid={addressError}
              value={address}
              disabled={!canControl}
              onFocus={() => (editing.current = true)}
              onBlur={() => {
                editing.current = false;
                setAddress(url ?? "");
                setAddressError(false);
              }}
              onChange={(e) => {
                setAddress(e.target.value);
                setAddressError(false);
              }}
            />
          </form>
        </div>
        {addressError && (
          <p role="alert" className="field-hint browser-hint m-0 mx-3 -mt-1 mb-1.5 text-sm text-destructive">
            Enter a web address, like example.com.
          </p>
        )}

        <div
          className={cn(
            "live-stage min-h-0 flex-1 overflow-auto overscroll-contain px-2.5 max-md:px-1.5",
            !side && "grid place-items-center overflow-hidden px-3.5 pb-3.5 [container-type:size] max-md:pb-1.5",
          )}
          style={{ "--ar": viewport.width / viewport.height } as CSSProperties}
        >
          <div
            ref={surface}
            className={cn(
              "live-surface relative w-full overflow-hidden rounded-lg border bg-muted [&[data-status=closed]_.live-canvas]:opacity-45 [&[data-status=reconnecting]_.live-canvas]:opacity-45",
              !side && "w-[min(100cqw,calc(100cqh*var(--ar,1.4)))] rounded-[10px] border-0 ring-1 ring-input",
              canControl && "controlling cursor-default touch-none select-none",
              canControl &&
                (side
                  ? "border-attention-border shadow-[0_0_0_2px_var(--attention-soft)]"
                  : "ring-0 shadow-[0_0_0_2px_var(--attention-border),0_0_0_5px_var(--attention-soft)]"),
              hasFrame && "has-frame",
            )}
            data-status={live.status}
            style={{ aspectRatio: `${viewport.width} / ${viewport.height}` }}
            {...surfaceHandlers}
          >
            <canvas
              ref={canvas}
              className="live-canvas block h-full w-full"
              width={viewport.width}
              height={viewport.height}
              role="img"
              aria-label={`Live picture of ${title || host || "the browser window"}`}
            />
            {!hasFrame && (
              <p className="live-empty absolute inset-0 m-0 grid place-items-center p-4 text-center text-sm text-muted-foreground">
                {closed
                  ? "This chat's browser window is closed."
                  : live.status === "denied"
                    ? "You can't watch this window."
                    : "Waiting for the first picture…"}
              </p>
            )}
            {canControl && (
              <textarea
                ref={keys}
                className="live-keys pointer-events-none absolute bottom-0 left-0 size-px resize-none border-0 p-0 text-[16px] opacity-0"
                aria-label="Keyboard input for the page"
                rows={1}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                onKeyDown={onKeyDown}
                onKeyUp={onKeyUp}
                onInput={onInput}
                onCompositionStart={() => (composing.current = true)}
                onCompositionEnd={onCompositionEnd}
                onPaste={onPaste}
                onFocus={() => setKeyboardOn(true)}
                onBlur={() => {
                  setKeyboardOn(false);
                  releaseKeys();
                }}
              />
            )}
          </div>
        </div>

        {!closed && !pending && (
          <div
            className={cn(
              "live-foot flex min-h-14 items-center justify-between gap-2.5 px-3 pt-2.5 pb-[calc(10px+var(--safe-b))] max-md:[&_button]:h-11",
              focus &&
                "min-h-0 justify-start px-3.5 pt-0 pb-2.5 pointer-fine:hidden [&:not(:has(.keyboard-btn))]:hidden",
            )}
          >
            {canControl ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="keyboard-btn"
                aria-pressed={keyboardOn}
                onClick={toggleKeyboard}
              >
                <Icon name="keyboard" size={16} />
                Keyboard
              </Button>
            ) : active ? (
              <p className={cn("live-hint m-0 text-sm text-muted-foreground", focus && "hidden")}>
                Connecting your controls…
              </p>
            ) : (
              <>
                <p className={cn("live-hint m-0 text-sm text-muted-foreground", focus && "hidden")}>Watching</p>
              </>
            )}
          </div>
        )}
      </aside>
      {/* Outside the panel so an Escape in a dialog does not also close it. */}
      {canControl && live.select && (
        <SelectPicker
          select={live.select}
          onChoose={(values) => {
            sendRef.current({ type: "select", values });
            live.clearSelect();
          }}
          onCancel={live.clearSelect}
        />
      )}
      {canControl && live.dialog && (
        <PageDialog
          dialog={live.dialog}
          onAnswer={(accept, text) => {
            sendRef.current({ type: "dialog", accept, ...(text !== undefined ? { text } : {}) });
            live.clearDialog();
          }}
        />
      )}
    </>
  );
}
