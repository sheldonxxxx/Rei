// Structured JSON logs. Fields carry ids, counts and codes; never message text, tokens or passwords (ADR 0003).
import { createLogger as createServiceLogger, type Logger, type LogLevel, redactCredentials } from "@rei/logging";

export type { LogFields, Logger, LogLevel } from "@rei/logging";
export { classifyError, nullLogger } from "@rei/logging";

/** The control plane's logger. Tests pass no level and see every event; the host passes REI_LOG_LEVEL's. */
export function createLogger(
  write: (line: string) => void,
  now: () => number = () => Date.now(),
  level: LogLevel = "debug",
): Logger {
  return createServiceLogger({ service: "control", write, now, level });
}

/** Removes anything that looks like a credential from a string headed for an error message or a stored status. */
export const redact = redactCredentials;
