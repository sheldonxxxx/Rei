import { PROVIDER_HEADER, STEP_ID_HEADER, UPSTREAM_HEADER } from "@rei/protocol";
import { DEADLINE_PREFIX, GATEWAY_DOWN_PREFIX } from "./errors.ts";
import type { DeadlineKind, StepHandle } from "./steps.ts";

const OPENAI_BASE = "https://api.openai.com/v1";

/** Where pi-ai's request for `original` goes on the gateway: `${GATEWAY_URL}/v1/...`, same path as upstream. */
export function gatewayTarget(gatewayUrl: string, original: string): string {
  const base = gatewayUrl.replace(/\/+$/, "");
  if (original.startsWith(OPENAI_BASE)) return `${base}/v1${original.slice(OPENAI_BASE.length)}`;
  const url = new URL(original);
  const path = url.pathname.startsWith("/v1/") ? url.pathname : `/v1${url.pathname}`;
  return `${base}${path}${url.search}`;
}

export function deadlineMessage(kind: DeadlineKind, step: StepHandle): string {
  const d = step.deadlines;
  const secs = (ms: number) => (ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`);
  if (kind === "first_event") return `${DEADLINE_PREFIX} no response event within ${secs(d.firstEventMs)}`;
  if (kind === "idle") return `${DEADLINE_PREFIX} no response event for ${secs(d.idleMs)}`;
  return `${DEADLINE_PREFIX} the call took longer than ${secs(d.totalMs)}`;
}

const urlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

/** An SSE event line is anything that is not blank and not a `:` comment (keep-alives do not count as events). */
class EventDetector {
  #buf = "";
  readonly #decoder = new TextDecoder();
  /** Returns true if the chunk completed at least one event line. */
  feed(chunk: Uint8Array): boolean {
    this.#buf += this.#decoder.decode(chunk, { stream: true });
    let seen = false;
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl).replace(/\r$/, "");
      this.#buf = this.#buf.slice(nl + 1);
      if (line !== "" && !line.startsWith(":")) seen = true;
    }
    if (this.#buf.length > 1_000_000) this.#buf = ""; // a line this long is not a keep-alive; do not grow forever
    return seen;
  }
}

export interface GatewayFetchOptions {
  gatewayUrl: string;
  step: StepHandle;
  providerId?: string;
  fetchImpl?: typeof fetch;
}

/**
 * pi-ai's `fetch` option for one model call (never change the model's baseUrl). Re-targets the request to the
 * gateway, adds the step id and the original URL as headers, and enforces the model-call deadlines:
 * first event, gap between events, and a cap for the whole call including pi-ai's own retries.
 */
export function createGatewayFetch(options: GatewayFetchOptions): typeof fetch {
  const { gatewayUrl, step } = options;
  const realFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    step.httpErrorStatus = undefined;
    step.gatewayDown = false;
    const original = urlOf(input);
    const target = gatewayTarget(gatewayUrl, original);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(STEP_ID_HEADER, step.id);
    headers.set(UPSTREAM_HEADER, original);
    if (options.providerId) headers.set(PROVIDER_HEADER, options.providerId);

    const ac = new AbortController();
    const callerSignal = init?.signal ?? undefined;
    const onCallerAbort = () => ac.abort(callerSignal?.reason);
    if (callerSignal?.aborted) ac.abort(callerSignal.reason);
    else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    let hit: DeadlineKind | undefined = step.deadline;
    const trip = (kind: DeadlineKind) => {
      if (hit === undefined) hit = kind;
      step.deadline ??= kind;
      ac.abort(new Error(deadlineMessage(kind, step)));
    };

    // The cap covers the whole call, retries included: one timer per step, started by its first request.
    if (step.totalStartedAt === undefined) {
      step.totalStartedAt = Date.now();
      step.totalTimer = setTimeout(() => {
        step.deadline ??= "total";
        step.abortInFlight?.(new Error(deadlineMessage("total", step)));
      }, step.deadlines.totalMs);
    }
    step.abortInFlight = (reason) => {
      hit ??= "total";
      ac.abort(reason);
    };
    if (step.deadline === "total") {
      callerSignal?.removeEventListener("abort", onCallerAbort);
      throw new Error(deadlineMessage("total", step));
    }

    let firstTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => trip("first_event"),
      step.deadlines.firstEventMs,
    );
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (firstTimer !== undefined) clearTimeout(firstTimer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      firstTimer = idleTimer = undefined;
      callerSignal?.removeEventListener("abort", onCallerAbort);
      if (step.abortInFlight !== undefined) step.abortInFlight = undefined;
    };
    const failure = (cause: unknown): Error => {
      if (hit !== undefined || step.deadline !== undefined)
        return new Error(deadlineMessage((hit ?? step.deadline)!, step));
      return cause instanceof Error ? cause : new Error(String(cause));
    };

    let response: Response;
    try {
      response = await realFetch(target, { ...init, headers, signal: ac.signal });
    } catch (error) {
      cleanup();
      if (hit !== undefined || step.deadline !== undefined) throw failure(error);
      if (callerSignal?.aborted) throw error;
      // Nothing answered at the gateway's address: that is "gateway unreachable", whatever the socket said.
      step.gatewayDown = true;
      const code =
        (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code ?? "fetch failed";
      throw new Error(`${GATEWAY_DOWN_PREFIX} connection refused or lost (${code}), fetch failed`);
    }
    step.firstByteMs ??= Date.now() - step.startedAt;
    if (response.status >= 400) step.httpErrorStatus = response.status;

    if (!response.ok || response.body === null) {
      // Error bodies are small and not event streams; only the total cap applies to them.
      cleanup();
      return response;
    }

    const reader = response.body.getReader();
    const detector = new EventDetector();
    let sawFirst = false;
    const armIdle = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => trip("idle"), step.deadlines.idleMs);
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            cleanup();
            controller.close();
            return;
          }
          if (detector.feed(value)) {
            if (!sawFirst) {
              sawFirst = true;
              if (firstTimer !== undefined) clearTimeout(firstTimer);
              firstTimer = undefined;
            }
            armIdle();
          }
          controller.enqueue(value);
        } catch (error) {
          cleanup();
          controller.error(failure(error));
        }
      },
      cancel(reason) {
        cleanup();
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
}
