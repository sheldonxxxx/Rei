// The real Host, Clock, Out and Prompter. Nothing else in the CLI touches the file system, the terminal or a socket.
import {
  chmodSync,
  mkdirSync,
  openAsBlob,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import type { Clock, Host, Out, Prompter } from "./io.ts";
import { LineReader } from "./prompt.ts";

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function realOut(env: NodeJS.ProcessEnv = process.env): Out {
  return {
    line: (text = "") => void process.stdout.write(`${text}\n`),
    color: Boolean(process.stdout.isTTY) && !env.NO_COLOR,
  };
}

export function realHost(): Host {
  return {
    platform: process.platform,
    arch: process.arch,
    homeDir: homedir(),
    nodeVersion: process.versions.node,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    stat(path) {
      try {
        const s = statSync(path);
        return { size: s.size, mode: s.mode & 0o777 };
      } catch {
        return undefined;
      }
    },
    readText(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    async openFile(path, type) {
      try {
        return await openAsBlob(path, { type });
      } catch {
        return undefined;
      }
    },
    list(dir) {
      try {
        return readdirSync(dir);
      } catch {
        return undefined;
      }
    },
    writeText(path, text, mode) {
      writeFileSync(path, text, mode === undefined ? undefined : { mode });
      if (mode !== undefined) chmodSync(path, mode);
    },
    mkdirp(path, mode) {
      mkdirSync(path, { recursive: true, mode });
    },
    rename(from, to) {
      renameSync(from, to);
    },
    remove(path) {
      rmSync(path, { force: true });
    },
    removeDir(path) {
      try {
        rmdirSync(path);
        return true;
      } catch {
        return false;
      }
    },
    freeBytes(path) {
      try {
        const s = statfsSync(path);
        return Number(s.bavail) * Number(s.bsize);
      } catch {
        return undefined;
      }
    },
    portFree(host, port) {
      return new Promise((resolve) => {
        const server = createServer();
        // Only "in use" (or not allowed) counts: an address this machine does not have is not our concern here.
        server.once("error", (error: NodeJS.ErrnoException) =>
          resolve(error.code !== "EADDRINUSE" && error.code !== "EACCES"),
        );
        server.listen(port, host || "0.0.0.0", () => server.close(() => resolve(true)));
      });
    },
  };
}

/** Raw mode on a terminal, line by line; Ctrl-C cancels. */
function readLine(question: string, echo: boolean): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    const reader = new LineReader(echo);
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(reader.value);
    };
    const onData = (chunk: string) => {
      const fed = reader.feed(chunk);
      if (fed.echo) process.stdout.write(fed.echo);
      if (fed.cancelled) finish(new Error("cancelled"));
      else if (fed.done) finish();
    };
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

export function realPrompter(): Prompter {
  return {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: (question) => readLine(question, true),
    askHidden: (question) => readLine(question, false),
    async confirm(question, defaultYes) {
      const answer = (await readLine(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `, true)).trim();
      return answer === "" ? defaultYes : /^y/i.test(answer);
    },
  };
}
