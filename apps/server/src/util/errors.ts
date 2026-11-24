import type { ErrorInfo, ErrorIssue } from "@rei/protocol";

/** An error that maps straight to an HTTP response `{ error: { code, message } }`. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ErrorIssue[] | undefined;
  constructor(status: number, code: string, message: string, issues?: ErrorIssue[]) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
  info(): ErrorInfo {
    return { code: this.code, message: this.message, ...(this.issues ? { issues: this.issues } : {}) };
  }
}

export const unauthenticated = () => new HttpError(401, "unauthenticated", "Sign in first.");
export const notFound = (what = "Not found.") => new HttpError(404, "not_found", what);
export const badRequest = (code: string, message: string) => new HttpError(400, code, message);

/** A request or a tool call that broke a rule; the message is one clear sentence for the user or the model. */
export class Invalid extends HttpError {
  constructor(message: string) {
    super(400, "bad_request", message);
    this.name = "Invalid";
  }
}
