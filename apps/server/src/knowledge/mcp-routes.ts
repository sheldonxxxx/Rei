import {
  createKnowledgeMcpTokenRoute,
  listKnowledgeMcpTokensRoute,
  revokeKnowledgeMcpTokenRoute,
  rotateKnowledgeMcpTokenRoute,
  updateKnowledgeMcpTokenRoute,
} from "@rei/protocol";
import type { Context, Hono } from "hono";
import type { AppDeps } from "../http/app.ts";
import { type ContractOptions, mountRoute } from "../http/contract.ts";
import { HttpError } from "../util/errors.ts";
import { KNOWLEDGE_MCP_ENDPOINT_PATH, type KnowledgeMcpTokenStore } from "./mcp-tokens.ts";

const param = (c: Context, name: string): string => c.req.param(name) ?? "";

/** Owner-authenticated REST routes for managing Knowledge MCP tokens (Settings → MCP). */
export function knowledgeMcpRoutes(app: Hono, deps: AppDeps, contract: ContractOptions): void {
  const tokens = (): KnowledgeMcpTokenStore => {
    if (!deps.knowledgeMcpTokens)
      throw new HttpError(503, "unavailable", "Knowledge MCP token management is unavailable.");
    return deps.knowledgeMcpTokens;
  };

  mountRoute(app, listKnowledgeMcpTokensRoute, contract, () => ({
    endpointPath: KNOWLEDGE_MCP_ENDPOINT_PATH,
    tokens: tokens().list(),
  }));

  mountRoute(app, createKnowledgeMcpTokenRoute, contract, async (_c, { body }) => tokens().create(body));

  mountRoute(app, updateKnowledgeMcpTokenRoute, contract, (c, { body }) => ({
    token: tokens().update(param(c, "id"), body),
  }));

  mountRoute(app, rotateKnowledgeMcpTokenRoute, contract, async (c) => tokens().rotate(param(c, "id")));

  mountRoute(app, revokeKnowledgeMcpTokenRoute, contract, (c) => {
    tokens().revoke(param(c, "id"));
    return { ok: true } as const;
  });
}
