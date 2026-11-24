// /notify/*: Web Push sender. The control plane's outbox worker decides what to send and when; this only delivers and
// holds the VAPID key. Everything it learns from the push service is reduced to ok / gone / status.

import { classifyError, type Logger } from "@rei/logging";
import type { WebPushKeyResponse, WebPushSendResponse } from "@rei/protocol";
import type { Hono } from "hono";
import { b64u, errorResponse, HttpError, jsonResponse, readJsonObject } from "../http.ts";
import type { Redactor } from "../redact.ts";
import type { SecretStore } from "../secrets.ts";
import type { FcmSender } from "./fcm.ts";
import type { EncryptOptions, VapidKeys } from "./webpush.ts";
import { buildPushRequest, generateVapidKeys, isAllowedPushEndpoint, MAX_PAYLOAD_BYTES } from "./webpush.ts";

export const DEFAULT_VAPID_SUBJECT = "https://example.com/";
const VAPID_KEY = "vapid";
const SEND_TIMEOUT_MS = 15_000;

export interface NotifyContext {
  secrets: SecretStore;
  fetch: typeof fetch;
  now: () => number;
  log: Logger;
  redactor: Redactor;
  vapidSubject?: string;
  fcm?: FcmSender;
  /** Test seam for the RFC 8291 vector; unset in production. */
  encrypt?: EncryptOptions;
}

export function registerNotifyRoutes(app: Hono, ctx: NotifyContext): void {
  const subject = ctx.vapidSubject || DEFAULT_VAPID_SUBJECT;
  let vapid: Promise<VapidKeys> | null = null;

  /** The VAPID pair, generated and stored on first use (`modify` makes a concurrent first use agree on one pair). */
  function vapidKeys(): Promise<VapidKeys> {
    vapid ??= (async () => {
      const fresh = await generateVapidKeys();
      const keys = (await ctx.secrets.modify<VapidKeys>(VAPID_KEY, (cur) => cur ?? fresh))!;
      ctx.redactor.add(keys.privateJwk.d);
      return keys;
    })().catch((cause) => {
      vapid = null;
      throw cause;
    });
    return vapid;
  }

  const guard = (handler: (req: Request) => Promise<Response>) => async (c: { req: { raw: Request } }) => {
    try {
      return await handler(c.req.raw);
    } catch (cause) {
      if (cause instanceof HttpError) return errorResponse(cause.status, { code: cause.code, message: cause.message });
      throw cause;
    }
  };

  app.post(
    "/notify/fcm/send",
    guard(async (req) => {
      if (!ctx.fcm) throw new HttpError(503, "fcm_unavailable", "Firebase Cloud Messaging is not configured.");
      const { token, data, ttl, urgency } = await readJsonObject(req);
      if (
        typeof token !== "string" ||
        token.length < 1 ||
        token.length > 4096 ||
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        Object.entries(data).some(([, value]) => typeof value !== "string") ||
        new TextEncoder().encode(JSON.stringify(data)).length > 3500 ||
        typeof ttl !== "number" ||
        !Number.isInteger(ttl) ||
        ttl < 0 ||
        ttl > 86_400
      )
        throw new HttpError(400, "bad_request", "Invalid FCM token, message data or TTL.");
      return jsonResponse(
        await ctx.fcm({
          token,
          data: data as Record<string, string>,
          ttl,
          urgent: urgency === "high",
        }),
      );
    }),
  );

  app.get("/notify/webpush/key", async () =>
    jsonResponse({ publicKey: (await vapidKeys()).publicKey } satisfies WebPushKeyResponse),
  );

  app.post(
    "/notify/webpush/send",
    guard(async (req) => {
      const body = await readJsonObject(req);
      const sub = body.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
      if (
        typeof sub?.endpoint !== "string" ||
        typeof sub.keys?.p256dh !== "string" ||
        typeof sub.keys.auth !== "string"
      )
        throw new HttpError(400, "bad_request", "subscription needs endpoint and keys.p256dh and keys.auth.");
      if (!isAllowedPushEndpoint(sub.endpoint))
        throw new HttpError(
          400,
          "endpoint_not_allowed",
          "The push endpoint is not an https URL of a known push service.",
        );
      try {
        const p = b64u.decode(sub.keys.p256dh);
        if (p.length !== 65 || p[0] !== 0x04 || b64u.decode(sub.keys.auth).length !== 16) throw new Error();
      } catch {
        throw new HttpError(
          400,
          "bad_request",
          "subscription.keys are not a valid p256dh (65 bytes) and auth (16 bytes) pair.",
        );
      }
      if (typeof body.payload !== "string") throw new HttpError(400, "bad_request", "payload must be a string.");
      if (new TextEncoder().encode(body.payload).length > MAX_PAYLOAD_BYTES)
        throw new HttpError(400, "payload_too_large", `payload is over ${MAX_PAYLOAD_BYTES} bytes.`);
      const ttl = body.ttl ?? undefined;
      if (ttl !== undefined && (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl < 0))
        throw new HttpError(400, "bad_request", "ttl must be a non-negative number of seconds.");
      const urgency = body.urgency ?? undefined;
      if (urgency !== undefined && urgency !== "normal" && urgency !== "high")
        throw new HttpError(400, "bad_request", "urgency must be normal or high.");
      const topic = body.topic ?? undefined;
      if (topic !== undefined && (typeof topic !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(topic)))
        throw new HttpError(400, "bad_request", "topic must be 1 to 32 URL-safe base64 characters.");

      const request = await buildPushRequest(
        {
          subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
          payload: body.payload,
          ...(ttl !== undefined ? { ttl } : {}),
          ...(urgency ? { urgency } : {}),
          ...(topic ? { topic } : {}),
        },
        await vapidKeys(),
        subject,
        ctx.now(),
        ctx.encrypt,
      );
      const host = new URL(request.url).hostname;
      let res: Response;
      try {
        res = await ctx.fetch(request.url, {
          method: "POST",
          headers: request.headers,
          body: request.body as BodyInit,
          redirect: "manual",
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (cause) {
        ctx.log.warn("notify.webpush_unreachable", { host, ...classifyError(cause) });
        return jsonResponse({ ok: false, gone: false, status: 0 } satisfies WebPushSendResponse);
      }
      await res.body?.cancel().catch(() => {});
      // Never the endpoint path: it identifies the device.
      ctx.log[res.ok ? "debug" : "info"]("notify.webpush_sent", { host, status: res.status });
      if (res.status >= 200 && res.status < 300) return jsonResponse({ ok: true } satisfies WebPushSendResponse);
      const retry = Number(res.headers.get("retry-after"));
      return jsonResponse({
        ok: false,
        gone: res.status === 404 || res.status === 410,
        status: res.status,
        ...(Number.isFinite(retry) && retry > 0 ? { retryAfterMs: Math.ceil(retry * 1000) } : {}),
      } satisfies WebPushSendResponse);
    }),
  );
}
