/** Runtime boundaries are enforced independently of TypeScript's type safety. */
module.exports = {
  forbidden: [
    {
      name: "history-indexing-hides-its-implementation",
      severity: "error",
      from: {
        path: "^apps/server/src/",
        pathNot: "^apps/server/src/(memory/(history-indexing|index|worker)[.]ts$|retrieval/)",
      },
      to: { path: "^apps/server/src/(memory/(index|worker)|retrieval/(outbox|syncer))[.]ts$" },
    },
    {
      name: "no-unresolved-imports",
      severity: "error",
      from: {},
      to: { couldNotResolve: true, pathNot: "^vite/client$" },
    },
    {
      name: "logging-is-independent",
      severity: "error",
      from: { path: "^packages/logging/src/" },
      to: { path: "^(apps|packages/protocol)/" },
    },
    {
      name: "protocol-is-independent",
      severity: "error",
      from: { path: "^packages/protocol/src/" },
      to: { path: "^apps/" },
    },
    ...["server", "gateway", "web", "egress", "cli"].map((app) => ({
      name: `${app}-workspace-boundary`,
      severity: "error",
      from: { path: `^apps/${app}/src/` },
      to: {
        path: "^apps/",
        pathNot: app === "cli" ? "^apps/cli/" : `^apps/${app}/`,
      },
    })),
    {
      name: "gateway-core-does-not-import-node-adapters",
      severity: "error",
      from: { path: "^apps/gateway/src/core/" },
      to: { path: "^apps/gateway/src/node/" },
    },
    {
      name: "server-domain-does-not-import-node-adapters",
      severity: "error",
      from: { path: "^apps/server/src/", pathNot: "^apps/server/src/(node/|main[.]ts$)" },
      to: { path: "^apps/server/src/node/" },
    },
    {
      name: "production-does-not-import-tests",
      severity: "error",
      from: { path: "^(apps/[^/]+|packages/[^/]+)/src/", pathNot: "[.]test[.]tsx?$|/test/" },
      to: { path: "[.]test[.]tsx?$|/(test|tests|eval)/" },
    },
    {
      name: "web-does-not-import-node",
      severity: "error",
      from: { path: "^apps/web/src/" },
      to: { dependencyTypes: ["core"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "apps/web/tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "node", "default"],
      extensions: [".ts", ".tsx", ".js", ".json"],
    },
  },
};
