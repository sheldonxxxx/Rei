// The edges of the CLI as interfaces, so the commands can be tested with fakes: processes, the terminal, the clock and
// the few files and sockets it touches. The real ones are in real.ts.

export interface RunOptions {
  /** Written to the child's stdin; without it stdin is closed (so `compose exec -T` never waits for input). */
  input?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  cwd?: string;
}
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface Runner {
  /** Captures the output. Never throws: a missing program is code 127, a timeout 124. No shell. */
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>;
  /** Hands the terminal to the child (output goes straight there, not through this process). Resolves with its exit code. */
  interactive(cmd: string, args: string[], opts?: { cwd?: string }): Promise<number>;
}

export interface Out {
  line(text?: string): void;
  /** Colours only on a terminal with NO_COLOR unset. */
  readonly color: boolean;
}

export interface Prompter {
  /** stdin is a terminal. */
  readonly interactive: boolean;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  ask(question: string): Promise<string>;
  /** No echo. */
  askHidden(question: string): Promise<string>;
  select?<T extends string>(question: string, options: Choice<T>[], initial: T): Promise<T>;
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export interface Guide {
  intro(title: string): void;
  outro(message: string): void;
  message(message: string, kind?: "info" | "warn" | "error" | "success"): void;
  task<T>(message: string, work: () => Promise<T>): Promise<T>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface Host {
  platform?: string;
  arch?: string;
  /** The real home directory of whoever runs the CLI; nothing expands `~` in a shell. */
  homeDir: string;
  stat(path: string): { size: number; mode: number } | undefined;
  readText(path: string): string | undefined;
  /** The file as a Blob that reads it from disk when it is sent, never whole into memory; undefined when unreadable. */
  openFile(path: string, type: string): Promise<Blob | undefined>;
  /** The names in a directory; undefined when it cannot be read. */
  list(dir: string): string[] | undefined;
  /** Writes, then chmods (the mode is exact whatever the umask). */
  writeText(path: string, text: string, mode?: number): void;
  mkdirp(path: string, mode: number): void;
  /** Move `from` onto `to` on the same filesystem: a config write becomes all-or-nothing. */
  rename(from: string, to: string): void;
  remove(path: string): void;
  /** Removes an empty directory; false when it is not empty or not there. */
  removeDir(path: string): boolean;
  freeBytes(path: string): number | undefined;
  /** False only when something else holds the port. */
  portFree(host: string, port: number): Promise<boolean>;
  nodeVersion: string;
  /** The IANA time zone of this machine, e.g. "Asia/Macau". */
  timeZone: string;
}
