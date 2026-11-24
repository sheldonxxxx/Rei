// Gateway administration: `node src/cli.ts <login|status|logout|probe-models|ping|search-check|callers>`. Reads GATEWAY_DATA (default /data).
// It talks to the upstream directly (login, probe), so it must run where the gateway runs, not on the control plane.
// `callers` is different: it asks the running gateway over loopback (node/callers-cli.ts), so it runs with
// `docker compose exec`, never `run`.
//
// Inside the container, login needs the OAuth callback port (1455) published to the machine whose browser you use:
//   docker run --rm -it -p 127.0.0.1:1455:1455 -v rei-gateway-data:/data rei/gateway:dev node src/cli.ts login
// (or `docker compose run --rm -p 127.0.0.1:1455:1455 gateway node src/cli.ts login`). If the browser cannot reach
// 127.0.0.1:1455, paste the final redirect URL from its address bar into the prompt instead.
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { createRedactor } from "./core/redact.ts";
import { DEFAULT_PROVIDER_ORDER } from "./core/search/service.ts";
import { createPiModels, fingerprint, PiTokenSource } from "./node/auth.ts";
import { callersCommand } from "./node/callers-cli.ts";
import { CODEX_DEVICE_URL, CODEX_IMAGES, loginCodexImages } from "./node/codex-auth.ts";
import { dataPaths, loadConfig, PROVIDER_ID, resolveStandin } from "./node/config.ts";
import { FileCredentialStore, getDeviceId } from "./node/credstore.ts";
import { pingModel, searchCheck } from "./node/diagnose.ts";
import { readProbe, writeProbe } from "./node/modelsfile.ts";
import { SearchSetup } from "./node/search-setup.ts";
import { FileSecretStore } from "./node/secretstore.ts";
import { subscriptionSearch } from "./node/subscription-search.ts";

process.umask(0o077);
const paths = dataPaths(process.env.GATEWAY_DATA ?? "/data");
const command = process.argv[2];

// pi-ai's callback server binds 127.0.0.1 unless told otherwise; inside a container that is unreachable from the
// published port, so bind all interfaces there (the Dockerfile sets GATEWAY_IN_CONTAINER).
if (process.env.GATEWAY_IN_CONTAINER === "1" || existsSync("/.dockerenv"))
  process.env.PI_OAUTH_CALLBACK_HOST ??= "0.0.0.0";

async function status(): Promise<void> {
  const store = new FileCredentialStore(paths.credentialsFile);
  const c = await store.read(PROVIDER_ID);
  if (!c) console.log(`Not signed in (no credential in ${paths.credentialsFile}).`);
  else if (c.type !== "oauth") console.log(`A ${c.type} credential is stored, not a ChatGPT sign-in.`);
  else {
    const left = Math.round((c.expires - Date.now()) / 60_000);
    console.log(`Signed in. access sha256:${fingerprint(c.access)}  refresh sha256:${fingerprint(c.refresh)}`);
    console.log(
      `expires ${new Date(c.expires).toISOString()} (${left >= 0 ? `in ${left} min` : `${-left} min ago; refreshed automatically on the next request`})`,
    );
    console.log(`scopes ${(c.scopes as string[] | undefined)?.join(" ") ?? "(none recorded)"}`);
  }
  const probe = readProbe(paths.modelsFile);
  console.log(
    probe
      ? `models (probed ${probe.at}): ${probe.accepted.join(", ") || "(none accepted)"}`
      : "models: not probed yet (run probe-models)",
  );
}

async function logout(): Promise<void> {
  await new FileCredentialStore(paths.credentialsFile).delete(PROVIDER_ID);
  console.log("Credential removed.");
}

async function login(): Promise<void> {
  const store = new FileCredentialStore(paths.credentialsFile);
  const models = createPiModels(store);
  const rl = createInterface({ input: process.stdin });
  // Lines that arrive early are queued so a fast paste is not lost; a prompt rejects when pi-ai aborts it (the browser won).
  const queued: string[] = [];
  let waiting: ((line: string) => void) | undefined;
  rl.on("line", (line) => {
    if (waiting) {
      const w = waiting;
      waiting = undefined;
      w(line);
    } else queued.push(line);
  });
  const readLine = (signal: AbortSignal | undefined) =>
    new Promise<string>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("prompt cancelled"));
      const next = queued.shift();
      if (next !== undefined) return resolve(next);
      const onAbort = () => {
        waiting = undefined;
        reject(new Error("prompt cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      waiting = (line) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(line);
      };
    });

  const interaction = {
    signal: new AbortController().signal,
    notify(event: AuthEvent) {
      if (event.type === "auth_url") {
        console.log(`\n1. Open this URL in your browser and sign in to ChatGPT:\n\n   ${event.url}\n`);
        console.log("2. If the browser ends on an error page at 127.0.0.1:1455 (it cannot reach this process),");
        console.log("   copy the FULL URL from the address bar and paste it below, then press Enter.");
        console.log("   If the page says it is done, you do not need to paste anything.\n");
      } else if (event.type === "progress" || event.type === "info") console.log(event.message);
    },
    async prompt(prompt: AuthPrompt): Promise<string> {
      if (prompt.type !== "manual_code") {
        console.log(prompt.message);
        return readLine(prompt.signal);
      }
      // pi-ai fails the whole login on a bad paste, so keep asking until the line looks like the redirect URL.
      for (;;) {
        process.stdout.write("Paste the redirect URL (or wait for the browser): ");
        const line = (await readLine(prompt.signal)).trim();
        try {
          const url = new URL(line);
          if (url.pathname === "/auth/callback" && (url.searchParams.has("code") || url.searchParams.has("error")))
            return line;
        } catch {
          // not a URL
        }
        console.log(
          "That is not the redirect URL (http://127.0.0.1:1455/auth/callback?code=...&state=...). Try again.",
        );
      }
    },
  };
  try {
    const credential = await models.login(PROVIDER_ID, "oauth", interaction, {
      getDeviceId: () => getDeviceId(paths.secretDir),
      agentName: "rei gateway",
    });
    if (credential.type !== "oauth") throw new Error("unexpected credential type");
    console.log(
      `\nSigned in. Credential stored (access sha256:${fingerprint(credential.access)}), expires ${new Date(credential.expires).toISOString()}.`,
    );
  } finally {
    rl.close();
  }
}

const CANDIDATES = [
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-sol",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5-mini",
];

/** One tiny request per candidate model id; a model this login cannot use fails fast with a 400. Stored for /status. */
async function probeModels(ids: string[]): Promise<void> {
  const store = new FileCredentialStore(paths.credentialsFile);
  const stored = await store.read(PROVIDER_ID);
  if (!stored) throw new Error("not signed in; run login first");
  const redactor = createRedactor();
  if (stored.type === "oauth") redactor.add(stored.access, stored.refresh);
  const models = createPiModels(store);
  const template = models.getModels(PROVIDER_ID)[0];
  if (!template) throw new Error("pi-ai has no openai models to use as a request template");
  const accepted: string[] = [];
  const rejected: { id: string; reason: string }[] = [];
  for (const id of ids) {
    // The catalogue may not list a candidate; the request only needs the id, so clone a catalogue model with it.
    const model = models.getModel(PROVIDER_ID, id) ?? { ...template, id, name: id };
    const reply = await models.completeSimple(
      model,
      { messages: [{ role: "user", content: "PING. Reply with exactly one word: PONG.", timestamp: Date.now() }] },
      { signal: AbortSignal.timeout(90_000) },
    );
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      rejected.push({ id, reason: redactor.redact(reply.errorMessage ?? reply.stopReason).slice(0, 300) });
      console.log(`${id}: rejected`);
    } else {
      accepted.push(id);
      console.log(`${id}: accepted`);
    }
  }
  writeProbe(paths.modelsFile, { at: new Date().toISOString(), accepted, rejected });
  console.log(`\nAccepted ${accepted.length} of ${ids.length}; stored in ${paths.modelsFile} (shown by /status).`);
}

/** `ping [model-id]`: one tiny completion; prints `ok <model> <ms>ms` or `failed: <message>` (exit 1). Writes nothing. */
async function ping(): Promise<void> {
  const result = await pingModel({
    store: new FileCredentialStore(paths.credentialsFile),
    modelsFile: paths.modelsFile,
    model: process.argv[3],
  });
  console.log(result.line);
  if (!result.ok) process.exitCode = 1;
}

/** Each configured search provider once, as JSON lines, in the order saved in the web app. Never a key. */
async function searchCheckCommand(): Promise<void> {
  const config = loadConfig();
  const credentials = new FileCredentialStore(config.credentialsFile);
  const redactor = createRedactor();
  const tokens = new PiTokenSource(credentials, redactor);
  const setup = await SearchSetup.load(new FileSecretStore(config.secretsFile), {
    providers: [...DEFAULT_PROVIDER_ORDER],
    subscription: subscriptionSearch(credentials, tokens, (value) => redactor.add(value)),
    exaAuth: "keyless",
    keys: async () => null, // keys are saved settings; SearchSetup reads them
  });
  const lines = await searchCheck(setup.config);
  for (const line of lines) console.log(JSON.stringify(line));
}

try {
  switch (command) {
    case "login":
      await login();
      break;
    case "codex-images": {
      const store = new FileCredentialStore(paths.codexCredentialsFile);
      switch (process.argv[3]) {
        case "login":
          await loginCodexImages(store, (code) => console.log(`Open ${CODEX_DEVICE_URL} and enter ${code}.`));
          console.log("Signed in to Codex Images.");
          break;
        case "logout":
          await store.delete(CODEX_IMAGES);
          console.log("Codex Images credential removed.");
          break;
        case "status":
          console.log(
            (await store.read(CODEX_IMAGES))?.type === "oauth"
              ? "Signed in to Codex Images."
              : "Codex Images needs sign-in.",
          );
          break;
        default:
          throw new Error("Use codex-images login, logout or status.");
      }
      break;
    }
    case "status":
      await status();
      break;
    case "logout":
      await logout();
      break;
    case "probe-models":
      await probeModels(process.argv.length > 3 ? process.argv.slice(3) : CANDIDATES);
      break;
    case "ping":
      await ping();
      break;
    case "search-check":
      await searchCheckCommand();
      break;
    case "callers":
      process.exitCode = await callersCommand(process.argv.slice(3), {
        baseUrl: `http://127.0.0.1:${process.env.GATEWAY_PORT ?? 8780}`,
        token: resolveStandin(loadConfig()),
        fetch: (input, init) => fetch(input, init),
        out: (line) => console.log(line),
        err: (line) => console.error(line),
      });
      break;
    default:
      console.error(
        "usage: node src/cli.ts <login | status | logout | probe-models [model-id ...] | ping [model-id] | search-check | codex-images <login|status|logout> | callers ...>",
      );
      process.exitCode = 2;
  }
} catch (error) {
  console.error(`${command} failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
