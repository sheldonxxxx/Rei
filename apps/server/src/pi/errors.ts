import type { ErrorInfo } from "@rei/protocol";
import { redact } from "../util/log.ts";

export const DEADLINE_PREFIX = "deadline_exceeded:";
export const GATEWAY_DOWN_PREFIX = "gateway_unavailable:";
export const LOOP_GUARD_PREFIX = "loop_guard:";
/** The model stopped at its output cap before writing any answer (typically all of it went to reasoning). */
export const OUTPUT_LIMIT_PREFIX = "output_limit:";
/** The input (instructions, tools and history) does not fit the model's known context window. */
export const CONTEXT_LIMIT_PREFIX = "context_too_large:";

const PROVIDER_ERROR_PREFIX = "provider_error:";

/** Keeps provider diagnostics distinct from Rei's own failure prefixes when Pi stores the message. */
export function providerErrorText(detail: string, status?: number): string {
  return `${PROVIDER_ERROR_PREFIX} ${status === undefined ? "" : `HTTP ${status}: `}${detail}`.trimEnd();
}

const MODEL_ERROR_COPY: Record<string, string> = {
  gateway_auth: "The gateway rejected this server's stand-in token.",
  gateway_auth_error: "The model connection is unavailable. Check Settings → Providers.",
  provider_not_allowed: "The gateway does not allow Rei to use this provider. Check its provider configuration.",
  caller_concurrency: "Rei has too many calls to this provider in progress. Wait for one to finish, then try again.",
  provider_auth_error: "The model provider rejected the credentials. Check the connection in Settings → Providers.",
  provider_access_denied: "The model provider denied access. Check that the connected account can use this model.",
  model_unavailable: "The model is unavailable to this connection. Choose another model or check Settings → Models.",
  content_filtered: "The model provider blocked this request because its content filter flagged the input.",
  context_too_large:
    "The provider rejected the request because it exceeds the model's context window. Shorten or compact the conversation, or choose a model with a larger context window.",
  request_too_large: "The model request is too large. Shorten it or remove large attachments.",
  model_request_rejected:
    "The model provider rejected the request. Check the model settings or open Inspect for details.",
  usage_limit: "The model's usage limit was reached. Try again later.",
  provider_quota_exhausted:
    "The model provider's quota or billing limit was reached. Check the provider account or choose another model.",
  rate_limited: "The model provider is rate limiting requests. Wait a moment and try again.",
  provider_timeout: "The model provider did not answer in time. Try again.",
  provider_unreachable: "The gateway could not reach the model provider. Check the provider connection and try again.",
  provider_unavailable: "The model provider is temporarily unavailable. Try again or choose another model.",
  provider_stream_interrupted: "The response from the model provider ended before the reply finished. Try again.",
  model_error: "The model call failed. Open Inspect for details.",
};

// Specific provider and gateway signals take precedence over HTTP fallbacks. Match known signals only.
// The text may include quoted input or credentials, so the error returned to chat always uses fixed copy.
const PROVIDER_ERROR_SIGNALS = [
  ["gateway_auth", /\bbad_token\b/i],
  [
    "gateway_auth_error",
    /\b(?:gateway_auth_error|not_signed_in|credential_refresh_failed|credential_error|not signed in)\b/i,
  ],
  ["provider_not_allowed", /\b(?:provider_not_allowed|upstream_not_allowed|missing_upstream)\b/i],
  ["caller_concurrency", /\bcaller_concurrency\b/i],
  [
    "content_filtered",
    /\b(?:InternalError\.Algo\.DataInspectionFailed|content_filter(?:ed)?|content_policy_violation|responsibleaipolicyviolation)\b/i,
  ],
  [
    "context_too_large",
    /\b(?:context_length_exceeded|(?:model_)?context_window_exceeded|prompt_too_long|prompt (?:is )?too long|maximum context length|exceeds the context window)\b/i,
  ],
  ["request_too_large", /\b(?:body_too_large|request_too_large|payload_too_large)\b/i],
  ["model_unavailable", /\b(?:model_not_found|model_not_available|model_not_supported)\b/i],
  ["provider_auth_error", /\b(?:invalid_api_key|invalid_token|authentication_error)\b/i],
  ["provider_quota_exhausted", /\b(?:insufficient_quota|billing_hard_limit_reached|quota_exceeded)\b/i],
  [
    "usage_limit",
    /\b(?:usage(?:_| )limit(?:_reached)?|usage_not_included|subscription_sharing_(?:workplace_individual_)?usage_limit_exceeded|GoUsageLimitError|FreeUsageLimitError)\b/i,
  ],
  ["rate_limited", /\b(?:rate_limit(?:_exceeded|_error)?|rate_limited|rate limit)\b/i],
  ["provider_timeout", /\b(?:upstream_timeout|capped_call_timeout|request_timeout)\b/i],
  ["provider_unreachable", /\bupstream_unreachable\b/i],
  [
    "provider_stream_interrupted",
    /\b(?:stream_truncated|stream ended (?:before|without)|response[ _]incomplete|stream was interrupted|network_error|ECONNRESET|socket hang up)\b/i,
  ],
  ["provider_unavailable", /\b(?:overloaded_error|service_unavailable|server_error|internal_server_error)\b/i],
] as const;

const HTTP_ERROR_CODES: Record<number, string> = {
  400: "model_request_rejected",
  401: "provider_auth_error",
  402: "provider_quota_exhausted",
  403: "provider_access_denied",
  404: "model_unavailable",
  408: "provider_timeout",
  413: "request_too_large",
  422: "model_request_rejected",
  429: "rate_limited",
  504: "provider_timeout",
};

function mapProviderError(detail: string): ErrorInfo {
  const status = Number(
    /^(?:HTTP )?([45]\d{2})(?=[:\s]|$)/i.exec(detail)?.[1] ??
      /^(?:[^\n:(]{1,80} )?API error \(([45]\d{2})\)/i.exec(detail)?.[1] ??
      /\(([45]\d{2})\)$/.exec(detail)?.[1],
  );
  const signal = PROVIDER_ERROR_SIGNALS.find(([, pattern]) => pattern.test(detail))?.[0];
  // An HTTP error supplies a better diagnosis than a generic upstream "server_error" label.
  const fromStatus = HTTP_ERROR_CODES[status] ?? (status >= 500 ? "provider_unavailable" : undefined);
  const code = (signal === "provider_unavailable" ? (fromStatus ?? signal) : (signal ?? fromStatus)) ?? "model_error";
  const message = MODEL_ERROR_COPY[code]!;
  return { code, message: Number.isNaN(status) ? message : message.replace(".", ` (HTTP ${status}).`) };
}

/** Turns Pi's recorded failure into safe user-facing copy for chat and the Trace. */
export function mapModelError(rawText: string | undefined): ErrorInfo {
  const text = redact(rawText ?? "");
  if (text.startsWith(PROVIDER_ERROR_PREFIX)) return mapProviderError(text.slice(PROVIDER_ERROR_PREFIX.length).trim());
  if (text.startsWith(DEADLINE_PREFIX)) {
    const detail = text.slice(DEADLINE_PREFIX.length).trim();
    return {
      code: "deadline_exceeded",
      message: `The model did not answer in time (${detail || "deadline exceeded"}). The run was stopped.`,
    };
  }
  if (text.startsWith(LOOP_GUARD_PREFIX)) {
    return {
      code: "loop_guard",
      message: text.slice(LOOP_GUARD_PREFIX.length).trim() || "The run reached its limit and was stopped.",
    };
  }
  if (text.startsWith(OUTPUT_LIMIT_PREFIX)) {
    return {
      code: "output_limit",
      message:
        text.slice(OUTPUT_LIMIT_PREFIX.length).trim() ||
        "The model stopped at its output limit before writing a reply. Raise Max output tokens for this model in Settings → Models.",
    };
  }
  if (text.startsWith(CONTEXT_LIMIT_PREFIX)) {
    return {
      code: "context_too_large",
      message:
        text.slice(CONTEXT_LIMIT_PREFIX.length).trim() ||
        "This chat is larger than the model's context window. Start a new chat or raise the context window in Settings → Models.",
    };
  }
  if (text.startsWith(GATEWAY_DOWN_PREFIX)) {
    return {
      code: "gateway_unavailable",
      message: "The model gateway is not reachable. Check that it is running, then send the message again.",
    };
  }
  return mapProviderError(text);
}

/** Copy for each reason a run ended without an answer (`pi.live.runFailure.reason`). */
const RUN_FAILURE_COPY: Record<string, string> = {
  no_model: "No model is set up for this chat, or the chosen one is not available. Check Settings → Models.",
  aborted: "The run was stopped.",
  reset: "The chat started a new context before the run could answer.",
  faulted: "The run hit an internal error and stopped. Continue to try again.",
  orphaned: "The run could not be resumed after a restart. Continue to try again.",
  interrupted: "The server stopped while the model was answering, more often than it retries. Continue to try again.",
  restart_limit: "The run was cut off by repeated restarts, so it was stopped. Continue to try again.",
  nothing_to_answer: "There was nothing new to answer.",
  turn_limit: "The run reached its limit on tool rounds. Continue to let it keep going.",
};

/**
 * The error a run failure shows. A model error keeps the model-error mapping; every other reason has its own fixed copy
 * and code, and the detail is only used where it is a count Pi wrote (turn_limit), never raw error text.
 */
export function runFailureError(reason: string, detail?: string): ErrorInfo {
  if (reason === "model_error") return mapModelError(detail);
  const message = RUN_FAILURE_COPY[reason] ?? "The run did not finish.";
  if (reason === "turn_limit" && detail && /^\d+ turns?$/.test(detail))
    return {
      code: reason,
      message: `The run reached its limit on tool rounds (${detail}). Continue to let it keep going.`,
    };
  return { code: reason, message };
}
