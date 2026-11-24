import type { Message, Session } from "@rei/protocol";
import { useEffect, useRef, useState } from "react";
import type { Api } from "../api/client.ts";

/** The newest settled item a reader has seen once the end of the chat is on screen; undefined while nothing is there. */
export function readTarget(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.internal || m.status === "pending" || m.status === "streaming") continue;
    return m;
  }
  return undefined;
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/**
 * Moves the session's read marker (shared by every device) to the newest item once the end of the chat is actually on
 * screen: `onScreen` while the reader is at the bottom of the chat, and the tab is visible. Only when the session has
 * unread entries, and once per item; a failure is retried on the next change.
 */
export function useReadMarker(
  api: Pick<Api, "markRead">,
  session: Pick<Session, "id" | "unread"> | null | undefined,
  messages: Message[],
  onScreen: boolean,
): void {
  const visible = useDocumentVisible();
  const target = readTarget(messages);
  const sent = useRef<string | null>(null);
  const sessionId = session?.id;
  const unread = session?.unread ?? 0;
  const targetId = target?.id;
  const targetAt = target?.createdAt;
  useEffect(() => {
    if (!sessionId || !onScreen || !visible || unread === 0 || !targetId || targetAt === undefined) return;
    const key = `${sessionId}:${targetId}`;
    if (sent.current === key) return;
    sent.current = key;
    api.markRead(sessionId, { itemId: targetId, at: targetAt }).catch(() => {
      sent.current = null;
    });
  }, [api, sessionId, onScreen, visible, unread, targetId, targetAt]);
}
