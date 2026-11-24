// The two services Rei stores things in (M11/M12), in Dodai: Garage holds the file bytes, Qdrant the search indexes. Healthy
// containers are not the question this answers — the question is whether the one process allowed to talk to them can
// actually reach them, which is what breaks when a stack is half-redeployed after a compose change.
import type { Ctx } from "../ctx.ts";
import { EXTERNAL_VOLUMES, expectedServices, legacyStorageContainers, networkName, volumeName } from "../ctx.ts";
import type { CheckResult, Row } from "../format.ts";
import { fail, ok, row, skip } from "../format.ts";

interface Target {
  service: string;
  host: string;
  port: number;
  what: string;
}

/** `service` is the compose service; `host` is the alias on <project>-storage that Rei's control plane uses. */
const TARGETS: Target[] = [
  { service: "garage", host: "rei-garage", port: 3900, what: "the object store" },
  { service: "qdrant", host: "rei-qdrant", port: 6333, what: "the search index" },
];

/** One probe from inside the control plane. Nothing else is allowed on the storage network, so it is the only witness. */
export async function storageReach(ctx: Ctx, target: Target): Promise<CheckResult> {
  const services = await expectedServices(ctx);
  if (!services.includes("garage") || !services.includes("qdrant")) return skip("this stack has no storage services");
  const where = `${target.host}:${target.port}`;
  const probe = await ctx.compose
    .exec("control", ["sh", "-c", `nc -z -w 2 ${target.host} ${target.port} && echo yes || echo no`])
    .catch(() => undefined);
  if (!probe)
    return fail(
      `could not ask the control plane about ${where}`,
      "is the control plane running? ./rei doctor for the stack",
    );
  if (probe.code === 0 && probe.stdout.includes("yes"))
    return ok(`the control plane reaches ${where} (${target.what})`);
  return fail(
    `the control plane cannot reach ${where} (${target.what})`,
    `storage is Dodai's (${networkName(ctx, "storage")}, private by design): ./rei start brings Dodai up first; if control is not on the network, recreate it — ${ctx.compose.command("up -d --force-recreate --no-deps control")}`,
  );
}

export const storageTargets = TARGETS;

/** Dodai's storage, seen from the host: the external volumes exist and Dodai did not create them, no Garage or Qdrant is left in Rei's project, and callers' network exists. Read-only. */
export async function storageRows(ctx: Ctx): Promise<Row[]> {
  const dodai = ctx.shared.project ?? "dodai";
  const missing: string[] = [];
  const owned: string[] = [];
  for (const name of EXTERNAL_VOLUMES) {
    const volume = volumeName(ctx, name);
    const r = await ctx.runner.run(
      "docker",
      ["volume", "inspect", "-f", '{{index .Labels "com.docker.compose.project"}}', volume],
      { timeoutMs: 30_000 },
    );
    if (r.code !== 0) missing.push(volume);
    else if (r.stdout.trim() === dodai) owned.push(volume);
  }
  const volumes = row(
    "volumes",
    "storage volumes",
    missing.length > 0
      ? fail(`missing: ${missing.join(", ")}`, "run ./rei setup (containers/init.sh creates them)")
      : owned.length > 0
        ? fail(
            `${owned.join(", ")} belong${owned.length === 1 ? "s" : ""} to the ${dodai} project, so \`down -v\` would delete ${owned.length === 1 ? "it" : "them"}`,
            "stop callers, back up the volume (docs/storage.md), then recreate it with `docker volume create` so compose treats it as external",
          )
        : ok(`${EXTERNAL_VOLUMES.length} external volumes exist`),
  );
  const legacy = await legacyStorageContainers(ctx);
  const old = row(
    "storage:legacy",
    "legacy storage",
    legacy.length > 0
      ? fail(
          "Garage or Qdrant is still in Rei's own project, beside the ones in Dodai",
          "run ./rei start (it removes them; the volumes are kept)",
        )
      : ok("no Garage or Qdrant left in Rei's project"),
  );
  const sharedNet = networkName(ctx, "storage-shared");
  const net = await ctx.runner.run("docker", ["network", "inspect", sharedNet], { timeoutMs: 30_000 });
  const shared = row(
    "storage:network",
    "callers' storage network",
    net.code === 0
      ? ok(`${sharedNet} exists (external for callers)`)
      : fail(`${sharedNet} does not exist`, "run ./rei start (or ./rei setup)"),
  );
  return [volumes, old, shared];
}
