import { int, lit, obj, type Static } from "@earendil-works/pi-schema";
import { defineRoute } from "./define.ts";

export const HealthResponseSchema = obj({
  ok: lit(true),
  protocolVersion: int({ minimum: 1, description: "The contract this server speaks." }),
  minClientProtocol: int({ minimum: 1, description: "Older clients are refused with client_outdated." }),
});
export type HealthResponse = Static<typeof HealthResponseSchema>;

export const healthRoute = defineRoute({
  method: "GET",
  path: "/api/health",
  tag: "system",
  summary: "Whether the server is up, and which protocol versions it serves.",
  description: "Open, so a client can check compatibility before signing in.",
  auth: "open",
  response: HealthResponseSchema,
});

export const systemRoutes = [healthRoute];
