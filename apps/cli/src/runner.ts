// The real Runner on node:child_process: no shell, arguments go to the program as they are.
import { spawn } from "node:child_process";
import type { Runner, RunOptions, RunResult } from "./io.ts";

export function realRunner(): Runner {
  return {
    run(cmd, args, opts: RunOptions = {}) {
      return new Promise<RunResult>((resolve) => {
        const child = spawn(cmd, args, {
          cwd: opts.cwd,
          env: { ...process.env, ...opts.env },
          stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const settle = (result: RunResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = opts.timeoutMs
          ? setTimeout(() => {
              child.kill("SIGKILL");
              settle({ code: 124, stdout, stderr: `${stderr}timed out after ${opts.timeoutMs} ms` });
            }, opts.timeoutMs)
          : undefined;
        child.stdout?.setEncoding("utf8").on("data", (d: string) => (stdout += d));
        child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
        child.on("error", (error: NodeJS.ErrnoException) =>
          settle({ code: error.code === "ENOENT" ? 127 : 126, stdout, stderr: `${cmd}: ${error.message}` }),
        );
        child.on("close", (code, signal) => settle({ code: code ?? (signal ? 128 : 1), stdout, stderr }));
        if (opts.input !== undefined) child.stdin?.on("error", () => {}).end(opts.input);
      });
    },
    interactive(cmd, args, opts = {}) {
      return new Promise<number>((resolve) => {
        const child = spawn(cmd, args, { cwd: opts.cwd, stdio: "inherit" });
        child.on("error", (error) => {
          process.stderr.write(`${cmd}: ${error.message}\n`);
          resolve(127);
        });
        child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
      });
    },
  };
}
