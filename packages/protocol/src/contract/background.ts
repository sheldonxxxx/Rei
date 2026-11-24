import { arr, bool, int, nullable, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import { defineRoute } from "./define.ts";
import { MemoryChangeSchema } from "./entities.ts";

export const BackgroundJobSchema = obj({
  id: str(),
  kind: str(),
  dedupe: str(),
  session_id: nullable(str()),
  agent_id: str(),
  payload: str(),
  status: str(),
  attempt: int(),
  fence: int(),
  lease_until: nullable(int()),
  retry_at: int(),
  created_at: int(),
  finished_at: nullable(int()),
  diagnostic: nullable(str()),
  result: nullable(str()),
  summary: opt(
    obj({
      sessionTitle: nullable(str()),
      agentName: nullable(str()),
      provider: nullable(str()),
      model: nullable(str()),
      eligibleTurns: int(),
      usage: nullable(str()),
      durationMs: nullable(int()),
    }),
  ),
});
export const BackgroundListSchema = obj({ jobs: arr(BackgroundJobSchema), next: nullable(str()) });
export const BackgroundDetailSchema = obj({
  job: BackgroundJobSchema,
  attempts: arr(
    obj({
      job_id: str(),
      attempt: int(),
      started_at: int(),
      finished_at: nullable(int()),
      provider: nullable(str()),
      model: nullable(str()),
      usage: nullable(str()),
      outcome: nullable(str()),
    }),
  ),
  changes: arr(MemoryChangeSchema),
  sources: arr(obj({ messageId: str(), runId: str(), entryId: str() })),
});
export type BackgroundList = Static<typeof BackgroundListSchema>;
export type BackgroundDetail = Static<typeof BackgroundDetailSchema>;
export const backgroundListRoute = defineRoute({
  method: "GET",
  path: "/api/background",
  tag: "operations",
  summary: "List background activity.",
  query: obj({
    kind: opt(str()),
    status: opt(str()),
    sessionId: opt(str()),
    before: opt(str({ pattern: "^[1-9][0-9]*$", maxLength: 16 })),
    limit: opt(str({ pattern: "^(?:[1-9]|[1-9][0-9]|100)$" })),
  }),
  response: BackgroundListSchema,
});
export const backgroundDetailRoute = defineRoute({
  method: "GET",
  path: "/api/background/:id",
  tag: "operations",
  summary: "Inspect background work and memory changes.",
  response: BackgroundDetailSchema,
});
export const backgroundRetryRoute = defineRoute({
  method: "POST",
  path: "/api/background/:id/retry",
  tag: "operations",
  summary: "Retry a failed background task.",
  response: obj({ retried: bool() }),
});
export const backgroundRoutes = [backgroundListRoute, backgroundDetailRoute, backgroundRetryRoute];
