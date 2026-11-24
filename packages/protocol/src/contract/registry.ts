import { authRoutes } from "./auth.ts";
import { backgroundRoutes } from "./background.ts";
import { capabilityRoutes } from "./capabilities.ts";
import { chatRoutes } from "./chat.ts";
import type { RouteContract, StreamContract } from "./define.ts";
import { importRoutes } from "./imports.ts";
import { knowledgeRoutes, libraryRoutes } from "./knowledge.ts";
import { memoryRoutes } from "./memory.ts";
import { operationRoutes } from "./operations.ts";
import { sessionExtraRoutes } from "./sessions.ts";
import { settingsRoutes } from "./settings.ts";
import { streamContracts } from "./stream.ts";
import { surfaceRoutes } from "./surfaces.ts";
import { systemRoutes } from "./system.ts";

export type AnyRouteContract = RouteContract<unknown, unknown, unknown>;

/** Every converted route. A route outside this list is not part of the published contract yet. */
export const CONTRACT_ROUTES: readonly AnyRouteContract[] = [
  ...systemRoutes,
  ...backgroundRoutes,
  ...authRoutes,
  ...chatRoutes,
  ...settingsRoutes,
  ...memoryRoutes,
  ...knowledgeRoutes,
  ...libraryRoutes,
  ...capabilityRoutes,
  ...operationRoutes,
  ...sessionExtraRoutes,
  ...surfaceRoutes,
  ...importRoutes,
];

/** Every server-sent event stream a client may open. */
export const CONTRACT_STREAMS: readonly StreamContract[] = streamContracts;
