// `./rei <command>` in a checkout, `rei <command>` from npm (rei-ai): the basic operations the web app cannot do (set up,
// start, stop, redeploy or upgrade, check, recover the account, show the setup code). Run it on the machine where docker
// runs; it finds the stack from its own location (layout.ts) and reaches it only through `docker compose` and the
// published app port.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callers } from "./commands/callers.ts";
import { doctor } from "./commands/doctor.ts";
import { IMPORT_HELP, importCommand } from "./commands/import.ts";
import { lifecycle } from "./commands/lifecycle.ts";
import { reader } from "./commands/reader.ts";
import { redeploy } from "./commands/redeploy.ts";
import { resetPassword } from "./commands/reset-password.ts";
import { setup } from "./commands/setup.ts";
import { setupCode } from "./commands/setup-code.ts";
import { sources } from "./commands/sources.ts";
import { status } from "./commands/status.ts";
import { upgrade } from "./commands/upgrade.ts";
import type { Ctx, CtxParts, Mode } from "./ctx.ts";
import { BUILD_OVERLAY, makeCtx, secretsPath } from "./ctx.ts";
import { loadGuide, useGuide } from "./guide.ts";
import { initSecrets } from "./init.ts";
import { isInstalled } from "./install.ts";
import { locate, phrase } from "./layout.ts";
import { realClock, realHost, realOut, realPrompter } from "./real.ts";
import { realRunner } from "./runner.ts";
import { envDir, stackProblem } from "./stack.ts";
import { updateNotice } from "./update-check.ts";
import { cliVersion } from "./version.ts";

const USAGE = `Rei レイ · your personal AI workspace

  ./rei setup           Set up and start Rei
  ./rei start           Start Rei services
  ./rei stop            Stop Rei services (--all: Dodai too)
  ./rei restart         Restart Rei services (--all: Dodai too)
  ./rei redeploy        Rebuild Rei images and redeploy (keeps data)
  ./rei upgrade         Move to this version's images (keeps data)
  ./rei status          See whether Rei is running
  ./rei doctor          Check problems and show how to fix them
  ./rei reset-password  Recover your Rei account
  ./rei setup-code      Show the setup code for a new Rei account
  ./rei callers         Manage other services that use the gateway
  ./rei sources         Manage senders of outside events (they start triggers)
  ./rei reader          Show how the shared page reader's engines are doing (stats)
  ./rei import chatgpt  Import past chats from a ChatGPT export
  Models, memory and web search are configured in the web app.

  --basic               Use plain text prompts
  --help                Show help for a command

Run on the computer where Docker runs.`;

function help(command?: string): string {
  switch (command) {
    case "setup":
      return "./rei setup [--non-interactive] [--skip-build]\n\nPrepare and start Rei infrastructure. Finish your settings in the web app.";
    case "setup-code":
      return "./rei setup-code\n\nShow the one-time setup code a new Rei asks for when its first account is created.";
    case "status":
    case "doctor":
      return `./rei ${command} [--json] [--basic]`;
    case "start":
      return "./rei start\n\nStart Dodai (the gateway and the reader), then the Rei services, without running setup again.";
    case "stop":
    case "restart":
      return `./rei ${command} [--all]\n\n${command === "stop" ? "Stop" : "Restart"} the Rei services without running setup again. Dodai (the gateway and the reader) keeps running, because other callers may use them; --all includes them.`;
    case "callers":
      return "./rei callers <list|add|set|rotate|revoke|usage|purge> [options]\n\nManage the services other than Rei that may call the gateway: their tokens, what they may call and how many calls they may have in flight. Run ./rei callers with no command to see every option.\n\nWith --storage, add, set and rotate also give the caller its own bucket and key in Dodai's Garage (revoke removes the key; purge deletes an empty bucket of a revoked caller; --yes skips its confirmation). See docs/gateway-callers.md.";
    case "reader":
      return "./rei reader stats [--since 30d]\n\nShow how the shared page reader's rendering engines have done: render counts, fallbacks, the rescue rate, shadow divergence and whether the decision rule for dropping the Chromium fallback is met. See docs/reader.md.";
    case "sources":
      return "./rei sources <add|list|rotate|disable|enable|remove> [options]\n\nManage the senders that may tell Rei something happened so a trigger can start: their secrets and whether they are accepted. Run ./rei sources with no command to see every option. See docs/events.md.";
    case "import":
      return IMPORT_HELP;
    case "init":
      return "./rei init\n\nCreate what the stack needs once: containers/.env, the shared secrets in containers/.secrets/secrets.env and the external storage volumes. Existing values are never replaced. Setup runs it.";
    case "upgrade":
      return "./rei upgrade [--force]\n\nMove this installation to the release of this CLI: install it first with npm i -g rei-ai@<version>. The configuration is copied to backups/ in REI_HOME, the new compose files are written, the new images are pulled and the services recreated, and doctor checks the result. Data volumes and secrets are kept; the new release upgrades its databases when it starts. A downgrade is refused; --force writes the older files anyway.";
    case "redeploy":
      return "./rei redeploy [--no-cache]\n\nRebuild the web app and all Rei-built Compose images, then recreate services. Docker's build cache is reused, so unchanged layers are fast; --no-cache forces a full rebuild. Docker data volumes and secrets are preserved.";
    default:
      return USAGE;
  }
}

const FLAGS: Record<string, string[]> = {
  setup: ["--non-interactive", "--skip-build"],
  "setup-code": [],
  start: [],
  stop: ["--all"],
  restart: ["--all"],
  redeploy: ["--no-cache"],
  upgrade: ["--force"],
  doctor: ["--json"],
  status: ["--json"],
  "reset-password": [],
  init: [],
};

/** The overview for this mode: a checkout redeploys from source, an npm installation upgrades to its version. */
function usage(mode: Mode): string {
  const drop = mode === "source" ? "./rei upgrade " : "./rei redeploy ";
  return USAGE.split("\n")
    .filter((line) => !line.trimStart().startsWith(drop))
    .join("\n");
}

async function main(argv: string[]): Promise<number> {
  const here = dirname(fileURLToPath(import.meta.url));
  const layout = locate(here, process.env, homedir(), existsSync);
  const mode: Mode = existsSync(join(layout.containersDir, BUILD_OVERLAY)) ? "source" : "image";
  // REI_ENV_DIR picks the stack: its .env and .secrets/ (default: next to the compose files).
  const stackDir = envDir(process.env, layout.containersDir, process.cwd(), homedir());
  const say = (text: string): string => phrase(text, mode, layout.containersDir, homedir(), stackDir);
  const version = cliVersion(mode === "source" ? layout.root : here);
  const basic = argv.includes("--basic");
  const [command, ...flags] = argv.filter((arg) => arg !== "--basic");
  if (command === "--version" || command === "-v") {
    console.log(version);
    return 0;
  }
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(say(usage(mode)));
    return 0;
  }
  if (command === "import" && (flags.includes("--help") || flags.includes("-h"))) {
    console.log(say(help(command)));
    return 0;
  }
  const parts = (p: Pick<CtxParts, "guide" | "out" | "prompter">): CtxParts => ({
    ...p,
    root: layout.root,
    containersDir: layout.containersDir,
    envDir: stackDir,
    ...(layout.assetsDir ? { assetsDir: layout.assetsDir } : {}),
    version,
    runner: realRunner(),
    clock: realClock,
    host: realHost(),
    fetch: globalThis.fetch,
    env: process.env,
  });
  // An npm installation that was never set up has no compose files to act on: say what to do instead of a docker error.
  const notSetUp = (): boolean => {
    if (mode !== "image" || ["setup", "init", "start", "upgrade"].includes(command)) return false;
    if (existsSync(join(layout.containersDir, "compose.yaml"))) return false;
    console.error(
      `rei: Rei is not set up in ${layout.containersDir}. Run rei setup first (REI_HOME picks another folder).`,
    );
    return true;
  };
  // A second stack beside the first must not collide with it: refused before any compose call.
  const refused = (ctx: Ctx): boolean => {
    const problem = stackProblem(ctx.env);
    if (problem) console.error(`rei: ${problem} (${join(ctx.envDir, ".env")}).`);
    return problem !== undefined;
  };
  // Passed to the gateway's own CLI as they are: its options are its own, and it answers on the terminal.
  // `import` reads an export here and talks to the app's HTTP API; its options are its own too.
  if (command === "callers" || command === "sources" || command === "reader" || command === "import") {
    if (notSetUp()) return 1;
    const ctx = makeCtx(parts({ out: realOut(), prompter: realPrompter() }));
    if (refused(ctx)) return 2;
    if (command === "reader") return reader(ctx, flags);
    if (command === "import") return importCommand(ctx, flags);
    return command === "callers" ? callers(ctx, flags) : sources(ctx, flags);
  }
  const allowed = FLAGS[command];
  if (!allowed) {
    console.error(`rei: unknown command "${command}"\n`);
    console.error(say(usage(mode)));
    return 2;
  }
  if (flags.includes("--help") || flags.includes("-h")) {
    console.log(say(help(command)));
    return 0;
  }
  const unknown = flags.filter((f) => !allowed.includes(f));
  if (unknown.length) {
    console.error(say(`rei ${command}: unknown option ${unknown.join(", ")}\n\n${usage(mode)}`));
    return 2;
  }
  if (notSetUp()) return 1;
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const guidedCommand = ["setup", "reset-password", "redeploy", "upgrade"].includes(command);
  const wantsGuide = guidedCommand && useGuide(argv, process.env, terminal);
  const guided = wantsGuide ? await loadGuide() : undefined;
  if (!basic && wantsGuide && !guided) console.log("Using basic prompts. Run npm ci to enable the guided interface.");
  const ctx = makeCtx(
    parts({
      ...(guided ? { guide: guided.guide } : {}),
      out: guided
        ? {
            line: (text = "") => {
              if (text) guided.guide.message(text);
            },
            color: false,
          }
        : realOut(),
      prompter: guided?.prompter ?? realPrompter(),
    }),
  );
  if (refused(ctx)) return 2;
  const has = (flag: string) => flags.includes(flag);
  const code = await run(ctx, command, has);
  // Once a day, an npm installation may say that a newer rei-ai exists. Never on --json output.
  if (!has("--json") && isInstalled(ctx)) {
    const notice = await updateNotice(ctx);
    if (notice) console.error(`\n${notice}`);
  }
  return code;
}

async function run(ctx: Ctx, command: string, has: (flag: string) => boolean): Promise<number> {
  switch (command) {
    case "start":
      if (!ctx.host.stat(secretsPath(ctx))) return setup(ctx, { nonInteractive: true, skipBuild: false });
      return lifecycle(ctx, command);
    case "stop":
    case "restart":
      return lifecycle(ctx, command, { all: has("--all") });
    case "redeploy":
      return redeploy(ctx, { noCache: has("--no-cache") });
    case "upgrade":
      return upgrade(ctx, { force: has("--force") });
    case "setup":
      return setup(ctx, {
        nonInteractive: has("--non-interactive"),
        skipBuild: has("--skip-build"),
      });
    case "setup-code":
      return setupCode(ctx);
    case "doctor":
      return doctor(ctx, { json: has("--json") });
    case "reset-password":
      return resetPassword(ctx);
    case "init":
      return initSecrets(ctx);
    default:
      return status(ctx, { json: has("--json") });
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(
    error instanceof Error && error.message === "cancelled"
      ? "\ncancelled"
      : `rei: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = error instanceof Error && error.message === "cancelled" ? 130 : 1;
}
process.exit();
