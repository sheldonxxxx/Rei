import type { RunTrace } from "@rei/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";

const DEBOUNCE_MS = 500;
/** While a run is going, its steps are fetched again this often (tool calls don't upsert messages). */
const LIVE_POLL_MS = 3_000;

export interface TraceState {
  /** Newest first. */
  runs: RunTrace[];
  loaded: boolean;
  error: string | null;
  /** There are older runs than the ones loaded. */
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
  reload: () => void;
}

/**
 * The session's step summaries for chat activity and Full mode. It reloads (debounced) whenever `rev` changes, which the
 * chat bumps on message and run upserts, and every few seconds while a run is going, so no new stream events are needed.
 * Request and result payloads are fetched separately, only when the inspector opens them.
 */
export function useTrace(api: Api, sessionId: string, enabled: boolean, rev: string): TraceState {
  const [first, setFirst] = useState<RunTrace[]>([]);
  const [firstNext, setFirstNext] = useState<string | null>(null);
  const [older, setOlder] = useState<RunTrace[]>([]);
  const [olderNext, setOlderNext] = useState<string | null | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const gen = useRef(0);

  useEffect(() => {
    setFirst([]);
    setFirstNext(null);
    setOlder([]);
    setOlderNext(undefined);
    setLoaded(false);
    setError(null);
    setLoadingOlder(false);
  }, [api, sessionId]);

  useEffect(() => {
    if (!enabled) return;
    const mine = ++gen.current;
    clearTimeout(timer.current);
    timer.current = setTimeout(
      async () => {
        try {
          const r = await api.getTrace(sessionId);
          if (mine !== gen.current) return;
          setFirst(r.runs);
          setFirstNext(r.next);
          setLoaded(true);
          setError(null);
        } catch (e) {
          if (mine === gen.current) setError(describeError(e));
        }
      },
      loaded ? DEBOUNCE_MS : 0,
    );
    return () => {
      clearTimeout(timer.current);
      gen.current++;
    };
    // `loaded` only picks the first delay
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sessionId, enabled, rev, tick]);

  const live = enabled && first.some((r) => r.run.status === "running" || r.run.status === "queued");
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setTick((t) => t + 1), LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [live]);

  const next = olderNext === undefined ? firstNext : olderNext;
  const loadOlder = useCallback(() => {
    if (!next || loadingOlder) return;
    setLoadingOlder(true);
    api.getTrace(sessionId, next).then(
      (r) => {
        setOlder((o) => [...o, ...r.runs]);
        setOlderNext(r.next);
        setLoadingOlder(false);
      },
      (e) => {
        setError(describeError(e));
        setLoadingOlder(false);
      },
    );
  }, [api, sessionId, next, loadingOlder]);

  const runs = useMemo(() => {
    const seen = new Set(first.map((r) => r.run.id));
    return [...first, ...older.filter((r) => !seen.has(r.run.id))];
  }, [first, older]);
  return {
    runs,
    loaded,
    error,
    hasOlder: next !== null,
    loadingOlder,
    loadOlder,
    reload: useCallback(() => setTick((t) => t + 1), []),
  };
}
