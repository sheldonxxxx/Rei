import type { Session } from "@rei/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";

/** Cursor history belongs to one agent, one filter and one authoritative stream snapshot. */
export function useSessionPages(
  api: Api,
  agentId: string | null,
  snapshotVersion: number | undefined,
  hydrate: (sessions: Session[], version: number | undefined) => void,
  triggers = false,
) {
  const [page, setPage] = useState({ loading: false, more: false, error: "" });
  const request = useRef<{
    agent: string;
    triggers: boolean;
    version: number | undefined;
    cursor?: string;
    busy: boolean;
    more: boolean;
  } | null>(null);
  const load = useCallback(async () => {
    const current = request.current;
    if (!current || current.busy || !current.more) return;
    current.busy = true;
    setPage({ loading: true, more: true, error: "" });
    try {
      const result = await api.getSessions({
        agent: current.agent,
        ...(current.triggers ? { triggers: "1" as const } : {}),
        ...(current.cursor ? { before: current.cursor } : {}),
      });
      if (request.current !== current) return;
      hydrate(result.sessions, current.version);
      current.cursor = result.nextCursor ?? undefined;
      current.more = !!result.nextCursor;
      setPage({ loading: false, more: current.more, error: "" });
    } catch (error) {
      if (request.current === current) setPage({ loading: false, more: true, error: describeError(error) });
    } finally {
      current.busy = false;
    }
  }, [api, hydrate]);
  useEffect(() => {
    request.current =
      agentId && snapshotVersion
        ? { agent: agentId, triggers, version: snapshotVersion, busy: false, more: true }
        : null;
    setPage({ loading: false, more: !!request.current, error: "" });
    void load();
    return () => {
      request.current = null;
    };
  }, [agentId, snapshotVersion, triggers, load]);
  const pending =
    !!agentId &&
    !!snapshotVersion &&
    (request.current?.agent !== agentId ||
      request.current.triggers !== triggers ||
      request.current.version !== snapshotVersion);
  return { ...page, loading: pending || page.loading, more: pending || page.more, load };
}
