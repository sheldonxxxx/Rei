// The live view of a session's browser window: a WebSocket that delivers JPEG frames (binary) and JSON messages (text),
// and carries your input while you are in control. Reconnects with backoff while open; nothing is stored.

import type { LiveClientMessage, LiveServerMessage } from "@rei/protocol";
import { LIVE_CLOSE_DENIED } from "@rei/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { defaultBackoff } from "./connection.ts";

/** The slice of WebSocket the live view uses (tests pass a fake). */
export interface SocketLike {
  readyState: number;
  binaryType: string;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type OpenSocket = (url: string) => SocketLike;

const OPEN = 1;

export function liveUrl(sessionId: string, loc: Pick<Location, "protocol" | "host"> = window.location): string {
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/api/sessions/${encodeURIComponent(sessionId)}/browser/live`;
}

export type LiveStatus = "connecting" | "live" | "reconnecting" | "closed" | "denied";

export interface LiveHandlers {
  onFrame: (jpeg: Blob) => void;
  onMessage: (msg: LiveServerMessage) => void;
  onStatus: (status: LiveStatus) => void;
}

export interface LiveOptions extends LiveHandlers {
  url: string;
  openSocket?: OpenSocket;
  backoff?: (attempt: number) => number;
}

export function openLive(opts: LiveOptions): { send: (msg: LiveClientMessage) => boolean; close: () => void } {
  const open = opts.openSocket ?? ((u: string) => new WebSocket(u) as unknown as SocketLike);
  const backoff = opts.backoff ?? defaultBackoff;
  let ws: SocketLike | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let stopped = false;
  let ended = false; // the server said the window is gone: don't reconnect

  function start(first: boolean) {
    if (stopped) return;
    opts.onStatus(first ? "connecting" : "reconnecting");
    const socket = open(opts.url);
    ws = socket;
    socket.binaryType = "blob";
    socket.onopen = () => {
      attempt = 0;
    };
    socket.onmessage = (ev) => {
      if (stopped || ws !== socket) return;
      const data: unknown = ev.data;
      if (typeof data === "string") {
        let msg: LiveServerMessage;
        try {
          msg = JSON.parse(data) as LiveServerMessage;
        } catch {
          return;
        }
        if (msg.type === "hello") opts.onStatus("live");
        if (msg.type === "closed") {
          ended = true;
          opts.onStatus("closed");
        }
        opts.onMessage(msg);
      } else if (data instanceof Blob) {
        opts.onFrame(data);
      } else if (data instanceof ArrayBuffer) {
        opts.onFrame(new Blob([data], { type: "image/jpeg" }));
      }
    };
    socket.onclose = (ev) => {
      if (stopped || ws !== socket) return;
      ws = null;
      if (ev.code === LIVE_CLOSE_DENIED) {
        opts.onStatus("denied");
        return;
      }
      if (ended) return;
      opts.onStatus("reconnecting");
      timer = setTimeout(() => {
        timer = undefined;
        start(false);
      }, backoff(attempt++));
    };
    socket.onerror = () => {}; // a close follows
  }

  start(true);

  return {
    send(msg) {
      if (!ws || ws.readyState !== OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    close() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      const socket = ws;
      ws = null;
      if (socket) {
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
        socket.close();
      }
    },
  };
}

export interface LiveState {
  status: LiveStatus;
  /** From the server's hello and later `viewport` / `page` messages. */
  viewport: { width: number; height: number } | null;
  url: string | null;
  title: string | null;
  /** The server honours your input (a takeover of this session is active). */
  control: boolean;
  select: Extract<LiveServerMessage, { type: "select" }> | null;
  dialog: Extract<LiveServerMessage, { type: "dialog" }> | null;
  closedReason: string | null;
}

const initial: LiveState = {
  status: "connecting",
  viewport: null,
  url: null,
  title: null,
  control: false,
  select: null,
  dialog: null,
  closedReason: null,
};

/**
 * Connects while `enabled` and returns the live state. `send` carries input and does nothing unless the server has said
 * you are in control, so a stray event can never reach a window you don't hold.
 */
export function useBrowserLive(
  sessionId: string,
  enabled: boolean,
  onFrame: (jpeg: Blob) => void,
  openSocket?: OpenSocket,
) {
  const [state, setState] = useState<LiveState>(initial);
  const conn = useRef<ReturnType<typeof openLive> | null>(null);
  const control = useRef(false);
  const frame = useRef(onFrame);
  frame.current = onFrame;

  useEffect(() => {
    if (!enabled) return;
    setState(initial);
    control.current = false;
    const c = openLive({
      url: liveUrl(sessionId),
      ...(openSocket ? { openSocket } : {}),
      onFrame: (b) => frame.current(b),
      onStatus: (status) =>
        setState((s) => {
          if (status === "live") return { ...s, status };
          // Reconnecting or closed: whatever was open on the page is stale, and so is control until the next hello.
          control.current = false;
          return { ...s, status, control: false, select: null, dialog: null };
        }),
      onMessage: (m) => {
        switch (m.type) {
          case "hello":
            control.current = m.control;
            setState((s) => ({
              ...s,
              viewport: m.viewport,
              url: m.url,
              title: m.title,
              control: m.control,
              select: null,
              dialog: null,
              closedReason: null,
            }));
            break;
          case "page":
            setState((s) => ({ ...s, url: m.url, title: m.title }));
            break;
          case "viewport":
            setState((s) => ({ ...s, viewport: { width: m.width, height: m.height } }));
            break;
          case "control":
            control.current = m.control;
            setState((s) => ({ ...s, control: m.control, ...(m.control ? {} : { select: null, dialog: null }) }));
            break;
          case "select":
            setState((s) => ({ ...s, select: m }));
            break;
          case "dialog":
            setState((s) => ({ ...s, dialog: m }));
            break;
          case "closed":
            control.current = false;
            setState((s) => ({ ...s, control: false, select: null, dialog: null, closedReason: m.reason }));
            break;
        }
      },
    });
    conn.current = c;
    return () => {
      c.close();
      conn.current = null;
    };
  }, [sessionId, enabled, openSocket]);

  const send = useCallback((msg: LiveClientMessage): boolean => {
    if (!control.current) return false;
    return conn.current?.send(msg) ?? false;
  }, []);
  const clearSelect = useCallback(() => setState((s) => ({ ...s, select: null })), []);
  const clearDialog = useCallback(() => setState((s) => ({ ...s, dialog: null })), []);

  return { ...state, send, clearSelect, clearDialog };
}
