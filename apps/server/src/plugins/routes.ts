import {
  createPluginRoute,
  deletePluginRoute,
  exportPluginRoute,
  importPluginRoute,
  type PluginPackage,
  pluginInstallationRoute,
  pluginRoute,
  pluginsRoute,
  retryPluginRoute,
  updatePluginRoute,
} from "@rei/protocol";
import type { Context, Hono } from "hono";
import { type ContractOptions, mountRoute } from "../http/contract.ts";
import { HttpError, Invalid } from "../util/errors.ts";
import { exportPluginZip, importPlugin, importPluginZip } from "./package.ts";
import type { PluginService } from "./service.ts";

const PLUGIN_MAX_BYTES = 8_000_000;
const param = (c: Context, name: string): string => c.req.param(name) ?? "";

export function pluginRoutes(app: Hono, plugins: PluginService, contract: ContractOptions) {
  // Bounded before the contract parses the body, including bodies without Content-Length.
  app.use("/api/plugins/*", async (c, next) => {
    const tooLarge = () => new HttpError(413, "too_large", "The plugin is too large.");
    if (Number(c.req.header("content-length") ?? 0) > PLUGIN_MAX_BYTES) throw tooLarge();
    if (c.req.method !== "GET" && (await c.req.text()).length > PLUGIN_MAX_BYTES) throw tooLarge();
    await next();
  });
  mountRoute(app, pluginsRoute, contract, async () => ({ plugins: await plugins.list() }));
  mountRoute(app, createPluginRoute, contract, async (_c, { body }) => ({
    plugin: await plugins.save(body.package, { author: "user" }),
  }));
  mountRoute(app, importPluginRoute, contract, async (_c, { body }) => {
    let pkg: PluginPackage;
    if (typeof body.zip === "string") {
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(atob(body.zip), (c) => c.charCodeAt(0));
      } catch {
        throw new Invalid("The ZIP must be base64.");
      }
      pkg = importPluginZip(bytes);
    } else if (body.files) pkg = importPlugin(body.files);
    else throw new Invalid("Send ZIP content or folder files.");
    // Existing content is updated only against an explicitly supplied revision.
    const existing = (await plugins.list()).find((p) => p.name === pkg.name);
    return {
      plugin: await plugins.save(pkg, {
        author: "user",
        ...(existing ? { id: existing.id, expectedRevision: body.expectedRevision as number } : {}),
      }),
    };
  });
  mountRoute(app, exportPluginRoute, contract, async (c, { query }) => {
    const plugin = await plugins.get(param(c, "id"), undefined, query.revision);
    return c.body(exportPluginZip(plugin.package, plugins.app.clock.now()) as Uint8Array<ArrayBuffer>, 200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${plugin.name}.zip"`,
    });
  });
  mountRoute(app, pluginRoute, contract, async (c, { query }) => ({
    plugin: await plugins.get(param(c, "id"), undefined, query.revision),
  }));
  mountRoute(app, updatePluginRoute, contract, async (c, { body }) => ({
    plugin: await plugins.save(body.package, {
      id: param(c, "id"),
      expectedRevision: body.expectedRevision as number,
      author: "user",
    }),
  }));
  mountRoute(app, pluginInstallationRoute, contract, async (c, { body }) => ({
    plugin: await plugins.installation(param(c, "id"), body),
  }));
  mountRoute(app, retryPluginRoute, contract, async (c) => {
    await plugins.reconcile(param(c, "id"));
    return { plugin: await plugins.get(param(c, "id")) };
  });
  mountRoute(app, deletePluginRoute, contract, async (c) => {
    await plugins.remove(param(c, "id"));
    return { ok: true } as const;
  });
}
