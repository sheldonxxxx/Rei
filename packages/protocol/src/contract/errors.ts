import { arr, int, obj, opt, type Static, str } from "@earendil-works/pi-schema";

/** One reason a request was refused: where (a JSON Pointer into the body or query, "" for the whole value) and why. */
export const ErrorIssueSchema = obj({
  path: str(),
  message: str(),
  line: opt(int({ description: "One-based source line, when known." })),
  column: opt(int({ description: "One-based source column, when known." })),
});

/** Every error answer: `{ error: { code, message, issues? } }`. Clients show `message`; `issues` are for forms. */
export const ErrorBodySchema = obj({
  error: obj({
    code: str({ description: "Stable machine-readable code, e.g. bad_request, unauthenticated, not_found." }),
    message: str({ description: "One sentence for the user." }),
    issues: opt(arr(ErrorIssueSchema, { description: "Present on validation failures." })),
  }),
});

export type ErrorIssue = Static<typeof ErrorIssueSchema>;
