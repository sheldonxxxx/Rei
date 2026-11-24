// Fakes for the CLI's edges: a docker-compose stack that answers the commands the CLI issues (and keeps a log of them),
// an in-memory host, a terminal buffer, a clock that only moves when somebody sleeps, and scripted answers to prompts.
import { basename } from "node:path";
import { ASSET_FILES } from "../src/asset-files.ts";
import type { Ctx } from "../src/ctx.ts";
import { makeCtx } from "../src/ctx.ts";
import type { Clock, Host, Out, Prompter, Runner, RunOptions, RunResult } from "../src/io.ts";

export const ROOT = "/repo";
export const COMPOSE = `${ROOT}/containers/compose.yaml`;
/** The shared services' compose file: the gateway and the reader. */
export const SHARED = `${ROOT}/containers/compose.dodai.yaml`;
/** The build overlays a checkout loads after each base file. */
export const COMPOSE_BUILD = `${ROOT}/containers/compose.build.yaml`;
export const SHARED_BUILD = `${ROOT}/containers/compose.dodai.build.yaml`;
const SHARED_SERVICES = new Set(["gateway", "reader", "garage", "qdrant"]);
export const KEY = "brave-key-AAAA1111BBBB2222"; // what the user types at a hidden prompt
/** A credential that the fake docker puts in output the CLI must not echo (container env, extra lines of a command). */
export const SECRET = "standin-SECRET-0123456789abcdef";

export const SERVICES = [
  "browser",
  "control",
  "edge",
  "egress",
  "exec",
  "exec-keys",
  "garage",
  "gateway",
  "qdrant",
  "reader",
  "searxng",
];
/** Services that do their job once and exit. */
const ONE_SHOT_SERVICES = new Set(["exec-keys"]);
const NETWORKS: Record<string, string[]> = {
  browser: ["browser-net"],
  control: ["internal", "gateway-admin", "exec-net", "browser-net", "storage"],
  garage: ["storage", "storage-shared"],
  qdrant: ["storage"],
  edge: ["front", "internal"],
  egress: ["egress-out", "exec-net", "browser-net"],
  exec: ["exec-net"],
  gateway: ["egress", "gateway-admin", "gateway-shared", "reader-internal"],
  reader: ["reader-egress", "reader-internal"],
  searxng: ["search-net", "search-out"],
};

export interface StackOptions {
  /** Services the control plane cannot open a connection to (the storage reachability check). */
  storageUnreachable?: string[];
  services?: string[];
  /** Rows start absent (nothing created yet) and appear healthy after `up`. */
  fresh?: boolean;
  /** `up` leaves these services unhealthy for ever. */
  stuck?: string[];
  /** Services that lack their name as an alias on one network. */
  missingAlias?: string[];
  /** A force-recreate does not repair the alias. */
  recreateDoesNotHelp?: boolean;
  /** Health stays "starting" for this many `ps` calls after an `up`. */
  startingPolls?: number;
  smoke?: { code: number; stdout: string };
  controlReachesInternet?: boolean;
  gatewayReachesInternet?: boolean;
  dockerMissing?: boolean;
  restartCounts?: Record<string, number>;
  /** What control's /data/setup-code.txt holds (default SETUP-CODE-1234); null: the file is missing. */
  setupCode?: string | null;
  /** A gateway container from before the split is still in Rei's own project. */
  legacyGateway?: boolean;
  /** Garage and Qdrant containers from before the move are still in Rei's own project. */
  legacyStorage?: boolean;
  /** External volumes that do not exist yet (full names). */
  missingVolumes?: string[];
  /** External volumes that carry Dodai's project label (so `down -v` would delete them). */
  dodaiOwnedVolumes?: string[];
  /** rei-storage-shared does not exist. */
  noSharedNetwork?: boolean;
}

interface Row {
  state: string;
  health: string;
  exitCode: number;
}

export class FakeStack implements Runner {
  readonly calls: string[] = [];
  readonly o: StackOptions;
  rows = new Map<string, Row>();
  missingAlias: Set<string>;
  /** Each `ps` call counts this down while health reads "starting". */
  startingLeft = 0;
  /** Scripted answers for non-docker programs (the first one that returns a result wins), so a test never calls a real tool. */
  readonly handlers: ((cmd: string, args: string[], opts?: RunOptions) => RunResult | undefined)[] = [];
  /** Every non-docker program the CLI ran, with its exact paths and arguments. */
  readonly execs: { cmd: string; args: string[] }[] = [];
  /** Volumes made with `docker volume create`; they exist from then on. */
  readonly createdVolumes = new Set<string>();

  constructor(o: StackOptions = {}) {
    this.o = o;
    this.missingAlias = new Set(o.missingAlias ?? []);
    if (!o.fresh) this.bringUp();
  }

  get services(): string[] {
    return this.o.services ?? SERVICES;
  }

  private bringUp(): void {
    this.rows = new Map(
      this.services.map((s) => [
        s,
        ONE_SHOT_SERVICES.has(s)
          ? { state: "exited", health: "", exitCode: 0 }
          : this.o.stuck?.includes(s)
            ? { state: "running", health: "unhealthy", exitCode: 0 }
            : { state: "running", health: "healthy", exitCode: 0 },
      ]),
    );
    this.startingLeft = this.o.startingPolls ?? 0;
  }

  /** The compose subcommands issued, in order (docker version and friends keep their own name). Those of the shared
   * project carry a `shared: ` prefix. */
  get compose(): string[] {
    return this.calls.filter((c) => c.startsWith("compose: ")).map((c) => c.slice(9));
  }

  /** Splits a `docker compose` argument list into the project it names and the subcommand (after the last -f file). */
  private parse(args: string[]): { shared: boolean; rest: string[] } {
    const shared = args.some((a) => a.endsWith("/compose.dodai.yaml"));
    const rest = args.slice(args.lastIndexOf("-f") + 2);
    if (rest[0] === "-p") rest.splice(0, 2);
    this.calls.push(`compose: ${shared ? "shared: " : ""}${rest.join(" ")}`);
    return { shared, rest };
  }

  async run(cmd: string, args: string[], _opts?: RunOptions): Promise<RunResult> {
    const done = (stdout = "", code = 0, stderr = ""): RunResult => ({ code, stdout, stderr });
    if (cmd !== "docker") {
      this.calls.push(`${basename(cmd)} ${args.join(" ")}`.trim());
      this.execs.push({ cmd, args: [...args] });
      // First handler that answers wins, and the rest are never invoked (so a test can prove the order matters).
      let scripted: RunResult | undefined;
      for (const handler of this.handlers) {
        const result = handler(cmd, args, _opts);
        if (result !== undefined) {
          scripted = result;
          break;
        }
      }
      if (scripted) return scripted;
      return basename(cmd) === "smoke-exec.sh" || basename(cmd) === "smoke-browser.sh"
        ? done(
            (this.o.smoke ?? { code: 0, stdout: "PASS  a\nPASS  b\n\nall checks passed\n" }).stdout,
            (this.o.smoke ?? { code: 0 }).code,
          )
        : done("", 127, "not found");
    }
    if (this.o.dockerMissing) return done("", 127, "docker: spawn docker ENOENT");
    if (args[0] === "version") return done("29.9.2\n");
    if (args[0] === "inspect") {
      this.calls.push(`inspect ${args.slice(1).length} containers`);
      return done(JSON.stringify(args.slice(1).map((id) => this.inspected(id))));
    }
    if (args[0] === "ps") {
      const service = args.find((a) => a.startsWith("label=com.docker.compose.service="))?.split("=")[2] ?? "";
      if (service === "gateway") return done(this.o.legacyGateway ? "legacy-gateway-id\n" : "");
      return done(this.o.legacyStorage ? `legacy-${service}-id\n` : "");
    }
    if (args[0] === "rm") {
      this.calls.push(`rm ${args.slice(1).join(" ")}`);
      return done();
    }
    if (args[0] === "volume" && args[1] === "create") {
      const name = args[2] ?? "";
      this.calls.push(`volume create ${name}`);
      this.createdVolumes.add(name);
      return done(`${name}\n`);
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      const name = args[args.length - 1] ?? "";
      if (this.o.missingVolumes?.includes(name) && !this.createdVolumes.has(name))
        return done("", 1, `Error: No such volume: ${name}`);
      return done(this.o.dodaiOwnedVolumes?.includes(name) ? "dodai\n" : "rei\n");
    }
    if (args[0] === "network" && args[1] === "inspect")
      return this.o.noSharedNetwork ? done("", 1, "Error: No such network") : done("[]");
    if (args[0] === "network" && args[1] === "rm") {
      this.calls.push(`network rm ${args.slice(2).join(" ")}`);
      return done();
    }
    if (args[0] !== "compose") return done("", 1, "unsupported");
    if (args[1] === "version") return done("5.6.1\n");
    const { shared, rest } = this.parse(args);
    const mine = (service: string) => SHARED_SERVICES.has(service) === shared;
    if (rest[0] === "ps") return done(this.ps(mine));
    if (rest[0] === "config") return done(`${this.services.filter(mine).join("\n")}\n`);
    if (rest[0] === "up") {
      this.bringUp();
      return done();
    }
    if (rest[0] === "pull") return done();
    if (rest[0] === "exec") return this.exec(rest.slice(2));
    return done("", 1, `unsupported: ${rest.join(" ")}`);
  }

  async interactive(cmd: string, args: string[]): Promise<number> {
    if (cmd !== "docker") {
      this.calls.push(`${basename(cmd)} ${args.join(" ")}`.trim());
      this.execs.push({ cmd, args: [...args] });
      return 0;
    }
    const { rest } = this.parse(args);
    if (rest[0] === "up") {
      if (rest.includes("--force-recreate")) {
        const names = rest.filter((a) => !a.startsWith("-") && a !== "up");
        if (!this.o.recreateDoesNotHelp) for (const n of names) this.missingAlias.delete(n);
        this.bringUp();
      }
      this.bringUp();
    }
    return 0;
  }

  private ps(mine: (service: string) => boolean): string {
    const starting = this.startingLeft > 0;
    // One poll asks both projects; only Rei's own counts it down.
    if (starting && mine("control")) this.startingLeft--;
    return [...this.rows]
      .filter(([service]) => mine(service))
      .map(([service, r]) =>
        JSON.stringify({
          Service: service,
          ID: `id-${service}`.padEnd(12, "0"),
          State: r.state,
          Health: starting && r.health === "healthy" ? "starting" : r.health,
          ExitCode: r.exitCode,
          Publishers:
            service === "edge"
              ? [{ URL: "127.0.0.1", TargetPort: 8787, PublishedPort: 8787, Protocol: "tcp" }]
              : [{ URL: "", TargetPort: 80, PublishedPort: 0, Protocol: "tcp" }],
        }),
      )
      .join("\n");
  }

  private inspected(id: string) {
    const service = SERVICES.find((s) => `id-${s}`.padEnd(12, "0") === id) ?? "unknown";
    const nets = NETWORKS[service] ?? [];
    return {
      Id: `${id}${"f".repeat(52)}`,
      RestartCount: this.o.restartCounts?.[service] ?? 0,
      Config: { Env: [`REI_STANDIN=${SECRET}`] },
      NetworkSettings: {
        Networks: Object.fromEntries(
          nets.map((n, i) => {
            const name =
              this.missingAlias.has(service) && i === 0 ? [`rei-${service}-1`] : [`rei-${service}-1`, service];
            return [`rei_${n}`, { Aliases: name, DNSNames: [...name, id] }];
          }),
        ),
      },
    };
  }

  private exec(rest: string[]): RunResult {
    const [service, ...argv] = rest;
    const done = (stdout = "", code = 0, stderr = ""): RunResult => ({ code, stdout, stderr });
    const row = this.rows.get(service ?? "");
    if (row?.state !== "running") return done("", 1, `service "${service}" is not running`);
    if (argv.join(" ").includes("nc -z")) {
      // `sh -c "nc -z -w 2 <service> <port> && ..."`: the fifth word names the service being probed.
      const host = (argv[2]?.split(/\s+/)[4] ?? "").replace(/^rei-/, "");
      return this.o.storageUnreachable?.includes(host) ? done("no\n", 0) : done("yes\n", 0);
    }
    if (argv[0] === "cat")
      return this.o.setupCode === null
        ? done("", 1, "No such file")
        : done(`${this.o.setupCode ?? "SETUP-CODE-1234"}\n`);
    if (argv[1] === "-e" && /example\.com/.test(argv[2] ?? "")) {
      const reaches =
        service === "control" ? (this.o.controlReachesInternet ?? false) : (this.o.gatewayReachesInternet ?? true);
      return done(reaches ? "reached\n" : "blocked\n");
    }
    if (service === "control" && argv.join(" ").includes("e.probe()")) return done("ok");
    return done("", 1, "unsupported");
  }

  /** Commands that would change the stack. */
  get mutating(): string[] {
    return this.compose.filter((c) =>
      /^(shared: )?(up|run|stop|rm|restart|--profile|down|start|create|kill)\b/.test(c),
    );
  }
}

export class FakeHost implements Host {
  platform?: string;
  arch?: string;
  homeDir = "/Users/tester";
  readonly files = new Map<string, { text: string; mode: number }>();
  readonly writes: { path: string; text: string; mode: number | undefined }[] = [];
  readonly dirs: string[] = [];
  nodeVersion = "24.22.1";
  timeZone = "Asia/Macau";
  free: number | undefined = 100 * 1024 ** 3;
  portIsFree = true;

  stat(path: string) {
    const f = this.files.get(path);
    return f ? { size: this.sized.get(path) ?? f.text.length, mode: f.mode } : undefined;
  }
  readText(path: string) {
    return this.files.get(path)?.text;
  }
  /** Paths whose Blob is a stand-in of this size instead of the text (a large file a test should not allocate). */
  readonly sized = new Map<string, number>();
  async openFile(path: string, type: string) {
    const f = this.files.get(path);
    if (!f) return undefined;
    const size = this.sized.get(path);
    return new Blob([size === undefined ? f.text : new Uint8Array(size)], { type });
  }
  list(dir: string) {
    const prefix = `${dir.replace(/\/$/, "")}/`;
    const names = [...this.files.keys()]
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length).split("/")[0]!);
    if (names.length === 0) return this.dirs.includes(dir) ? [] : undefined;
    return [...new Set(names)].sort();
  }
  removeDir(path: string) {
    const prefix = `${path.replace(/\/$/, "")}/`;
    if ([...this.files.keys()].some((p) => p.startsWith(prefix))) return false;
    const at = this.dirs.indexOf(path);
    if (at < 0) return false;
    this.dirs.splice(at, 1);
    return true;
  }
  writeText(path: string, text: string, mode?: number) {
    this.writes.push({ path, text, mode });
    this.files.set(path, { text, mode: mode ?? this.files.get(path)?.mode ?? 0o644 });
  }
  mkdirp(path: string) {
    this.dirs.push(path);
  }
  rename(from: string, to: string) {
    const f = this.files.get(from);
    if (!f) throw new Error(`no such file to rename: ${from}`);
    this.writes.push({ path: to, text: f.text, mode: f.mode });
    this.files.set(to, f);
    this.files.delete(from);
  }
  remove(path: string) {
    this.files.delete(path);
  }
  freeBytes() {
    return this.free;
  }
  async portFree(_host: string, _port: number) {
    return this.portIsFree;
  }
}

export class FakeOut implements Out {
  readonly lines: string[] = [];
  readonly color = false;
  line(text = "") {
    this.lines.push(text);
  }
  get text(): string {
    return this.lines.join("\n");
  }
}

export class FakeClock implements Clock {
  t = 1_700_000_000_000;
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.t += ms;
  }
}

/** Answers prompts from a queue (hidden or not), recording the questions. */
export class FakePrompter implements Prompter {
  readonly asked: string[] = [];
  readonly interactive: boolean;
  readonly answers: string[];
  confirmAnswer = true;
  /** Scripted yes/no for questions containing these strings, checked before confirmAnswer. */
  readonly confirms: { match: string; answer: boolean }[] = [];
  constructor(answers: string[] | null) {
    this.interactive = answers !== null;
    this.answers = answers ?? [];
  }
  async confirm(question: string) {
    this.asked.push(question);
    const scripted = this.confirms.find((c) => question.includes(c.match));
    return scripted ? scripted.answer : this.confirmAnswer;
  }
  async ask(question: string) {
    this.asked.push(question);
    return this.answers.shift() ?? "";
  }
  async askHidden(question: string) {
    this.asked.push(question);
    return this.answers.shift() ?? "";
  }
}

/** secrets.env of a set-up installation: every variable rei init makes (fixed, made-up values). */
export const SET_UP_SECRETS = `REI_STANDIN=${SECRET}
GARAGE_RPC_SECRET=${"1".repeat(64)}
GARAGE_ADMIN_TOKEN=${"2".repeat(32)}
GARAGE_DEFAULT_BUCKET=rei-files
GARAGE_DEFAULT_ACCESS_KEY=GK${"3".repeat(32)}
GARAGE_DEFAULT_SECRET_KEY=${"4".repeat(64)}
QDRANT__SERVICE__API_KEY=${"5".repeat(64)}
REI_EVENTS_KEY=${"6".repeat(64)}
`;

export interface Rig {
  ctx: Ctx;
  stack: FakeStack;
  host: FakeHost;
  out: FakeOut;
  clock: FakeClock;
  prompter: FakePrompter;
  fetched: string[];
}

export interface RigOptions extends StackOptions {
  /** Answers for the prompts; null: stdin is not a terminal. */
  answers?: string[] | null;
  env?: Record<string, string | undefined>;
  /** What the app answers: undefined = account exists. */
  setupRequired?: boolean;
  appDown?: boolean;
  /** An already set-up checkout: node_modules, secrets, .env. With `image`, an already set-up REI_HOME. */
  checkout?: boolean;
  /** An npm installation (image mode): REI_HOME at HOME_REI, the package's files at ASSETS, this CLI at `version`. */
  image?: boolean;
  /** This CLI's version (default 1.2.0). */
  version?: string;
  /** With `image` and a set-up REI_HOME: the version it was set up with (default: the CLI's). */
  installed?: string;
  /** The latest rei-ai the npm registry names; without it the registry cannot be reached. */
  registry?: string;
  /** Answer specific confirmations differently (matched by a substring of the question). */
  confirms?: { match: string; answer: boolean }[];
}

/** REI_HOME of an npm installation in the image-mode rig. */
export const HOME_REI = "/Users/tester/.rei";
/** The package's assets/ in the image-mode rig. */
export const ASSETS = "/npm/lib/node_modules/rei-ai/assets";
/** What the package carries for each asset file: its path, so a test can tell which one landed where. */
export const assetText = (path: string): string => `# packaged ${path}\n`;

export function makeRig(o: RigOptions = {}): Rig {
  const stack = new FakeStack(o);
  const host = new FakeHost();
  const version = o.version ?? "1.2.0";
  if (o.image) {
    for (const f of ASSET_FILES) host.files.set(`${ASSETS}/${f.path}`, { text: assetText(f.path), mode: 0o644 });
    if (o.checkout !== false) {
      for (const f of ASSET_FILES) host.files.set(`${HOME_REI}/${f.path}`, { text: assetText(f.path), mode: f.mode });
      host.files.set(`${HOME_REI}/.secrets/secrets.env`, { text: SET_UP_SECRETS, mode: 0o600 });
      host.files.set(`${HOME_REI}/.env`, { text: "REI_TZ=Asia/Macau\n", mode: 0o644 });
      host.files.set(`${HOME_REI}/.installed-version`, { text: `${o.installed ?? version}\n`, mode: 0o644 });
    }
  } else {
    // A checkout: the build overlays are part of the repository.
    host.files.set(COMPOSE_BUILD, { text: "services: {}\n", mode: 0o644 });
    host.files.set(SHARED_BUILD, { text: "services: {}\n", mode: 0o644 });
  }
  if (!o.image && o.checkout !== false) {
    host.files.set(`${ROOT}/node_modules/.package-lock.json`, { text: "{}", mode: 0o644 });
    host.files.set(`${ROOT}/node_modules`, { text: "", mode: 0o755 });
    host.files.set(`${ROOT}/containers/.secrets/secrets.env`, { text: SET_UP_SECRETS, mode: 0o600 });
    host.files.set(`${ROOT}/containers/.env`, { text: "COMPOSE_PROFILES=searxng\nREI_TZ=Asia/Macau\n", mode: 0o644 });
  }
  const out = new FakeOut();
  const clock = new FakeClock();
  const prompter = new FakePrompter(o.answers === undefined ? null : o.answers);
  prompter.confirms.push(...(o.confirms ?? []));
  const fetched: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    fetched.push(url);
    if (url.startsWith("https://registry.npmjs.org/")) {
      if (o.registry === undefined) throw new TypeError("fetch failed");
      return Response.json({ name: "rei-ai", version: o.registry });
    }
    if (o.appDown) throw new TypeError("fetch failed");
    if (url.endsWith("/api/health")) return Response.json({ ok: true });
    if (url.endsWith("/api/auth/state"))
      return Response.json({ setupRequired: o.setupRequired ?? false, signedIn: false });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  const ctx = makeCtx({
    root: o.image ? HOME_REI : ROOT,
    ...(o.image ? { containersDir: HOME_REI, assetsDir: ASSETS } : {}),
    version,
    runner: stack,
    out,
    clock,
    host,
    prompter,
    fetch: fetchFn,
    env: o.env ?? {},
  });
  return { ctx, stack, host, out, clock, prompter, fetched };
}
