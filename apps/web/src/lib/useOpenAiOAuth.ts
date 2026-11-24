import { useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";

type OAuthApi = Pick<
  Api,
  "startOpenAiOAuth" | "getOpenAiOAuthStatus" | "submitOpenAiOAuthCallback" | "cancelOpenAiOAuth"
>;
interface AttemptState {
  pending: boolean;
  authorizationUrl: string;
  busy: boolean;
}
const EMPTY: AttemptState = { pending: false, authorizationUrl: "", busy: false };
const POLL_MS = 1000;

/** One mounted observer of the gateway's resumable sign-in attempt. Leaving the view never cancels sign-in. */
export function useOpenAiOAuth(api: OAuthApi, onError: (error: string | null) => void, onSettled: () => Promise<void>) {
  const [state, setState] = useState<AttemptState>(EMPTY);
  const currentState = useRef(state);
  const generation = useRef(0);
  const mounted = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const statusTail = useRef<Promise<void>>(Promise.resolve());
  const startingPopup = useRef<Window | null>(null);
  const callbacks = useRef({ onError, onSettled });
  callbacks.current = { onError, onSettled };

  const isCurrent = useCallback((mine: number) => mounted.current && mine === generation.current, []);
  const publish = useCallback((next: Partial<AttemptState>) => {
    currentState.current = { ...currentState.current, ...next };
    setState(currentState.current);
  }, []);
  const invalidate = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    return ++generation.current;
  }, []);
  const observer = useRef<(mine: number, notify: boolean) => void>(() => {});
  const schedule = useCallback(
    (mine: number) => {
      if (!isCurrent(mine)) return;
      timer.current = setTimeout(() => observer.current(mine, true), POLL_MS);
    },
    [isCurrent],
  );
  const observe = useCallback(
    (mine: number, notify: boolean) => {
      // Queue status reads even across attempt changes: a slow reply must not overlap the next poll.
      const job = statusTail.current.then(async () => {
        if (!isCurrent(mine)) return;
        try {
          const result = await api.getOpenAiOAuthStatus();
          if (!isCurrent(mine)) return;
          publish({
            pending: result.pending,
            authorizationUrl: result.pending ? (result.authorizationUrl ?? currentState.current.authorizationUrl) : "",
          });
          if (result.pending) schedule(mine);
          else {
            if (result.error) callbacks.current.onError(result.error);
            if (notify) await callbacks.current.onSettled();
          }
        } catch (error) {
          if (!isCurrent(mine)) return;
          callbacks.current.onError(describeError(error));
          if (currentState.current.pending) schedule(mine);
        }
      });
      statusTail.current = job.catch(() => {});
    },
    [api, isCurrent, publish, schedule],
  );
  observer.current = observe;

  useEffect(() => {
    mounted.current = true;
    const mine = invalidate();
    publish(EMPTY);
    observe(mine, false);
    return () => {
      mounted.current = false;
      invalidate();
      startingPopup.current?.close();
      startingPopup.current = null;
    };
  }, [invalidate, observe, publish]);

  const start = async () => {
    if (!mounted.current || currentState.current.busy || currentState.current.pending) return;
    const mine = invalidate();
    // Must open synchronously during the user's gesture; navigation waits for the gateway's URL.
    const popup = window.open("about:blank", "rei-openai-oauth");
    if (popup) popup.opener = null;
    startingPopup.current = popup;
    publish({ busy: true });
    callbacks.current.onError(null);
    try {
      const result = await api.startOpenAiOAuth();
      if (!isCurrent(mine)) return;
      startingPopup.current = null;
      publish({ pending: true, authorizationUrl: result.authorizationUrl });
      if (popup && !popup.closed) popup.location.href = result.authorizationUrl;
      schedule(mine);
    } catch (error) {
      if (!isCurrent(mine)) return;
      popup?.close();
      startingPopup.current = null;
      callbacks.current.onError(describeError(error));
    } finally {
      if (isCurrent(mine)) publish({ busy: false });
    }
  };

  const submit = async (url: string): Promise<boolean> => {
    if (!mounted.current || currentState.current.busy || !currentState.current.pending) return false;
    const mine = invalidate();
    publish({ busy: true });
    callbacks.current.onError(null);
    try {
      await api.submitOpenAiOAuthCallback(url);
      return isCurrent(mine);
    } catch (error) {
      if (isCurrent(mine)) callbacks.current.onError(describeError(error));
      return false;
    } finally {
      if (isCurrent(mine)) {
        publish({ busy: false });
        schedule(mine);
      }
    }
  };

  const cancel = async (): Promise<boolean> => {
    if (!mounted.current) return false;
    const mine = invalidate();
    startingPopup.current?.close();
    startingPopup.current = null;
    publish({ busy: true });
    callbacks.current.onError(null);
    try {
      await api.cancelOpenAiOAuth();
      if (!isCurrent(mine)) return false;
      publish({ pending: false, authorizationUrl: "" });
      return true;
    } catch (error) {
      if (isCurrent(mine)) {
        callbacks.current.onError(describeError(error));
        if (currentState.current.pending) schedule(mine);
      }
      return false;
    } finally {
      if (isCurrent(mine)) publish({ busy: false });
    }
  };

  return { ...state, start, submit, cancel };
}
