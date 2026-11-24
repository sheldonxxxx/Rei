// Small HTTP helpers shared by the route modules (Web APIs only).
import type { ErrorInfo } from "@rei/protocol";

export const errorResponse = (status: number, error: ErrorInfo, headers?: HeadersInit): Response =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", ...headers } });

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
    this.code = code;
  }
}

/** The request body as a JSON object, within `max` characters; throws HttpError(400) otherwise. */
export async function readJsonObject(req: Request, max = 64 * 1024): Promise<Record<string, unknown>> {
  if (Number(req.headers.get("content-length") ?? 0) > max)
    throw new HttpError(400, "bad_request", "The request body is too large.");
  const text = await req.text();
  if (text.length > max) throw new HttpError(400, "bad_request", "The request body is too large.");
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "bad_request", "The body must be a JSON object.");
  }
}

export const b64u = {
  encode(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  /** Throws on anything outside the base64url alphabet. */
  decode(text: string): Uint8Array<ArrayBuffer> {
    if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
    const pad = text.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};
