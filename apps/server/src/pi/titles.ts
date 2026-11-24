import type { TitleSettings } from "@rei/protocol";
import type { BackgroundJob, BackgroundTaskService, TaskContext, TaskOutcome } from "../background/service.ts";
import { TaskFailure } from "../background/service.ts";
import type { AppStore } from "../store/store.ts";
import type { Clock } from "../util/clock.ts";
import type { Logger } from "../util/log.ts";
import type { ModelsConfigSource } from "./model-config.ts";
import { parseModelsConfig } from "./model-config.ts";
import type { ModelRuntime } from "./models.ts";
import { askModelResult } from "./oneshot.ts";
import type { StepRecorder } from "./steps.ts";

const ENABLED_KEY = "title_enabled";
const MODEL_KEY = "title_model";
const CLIP = 1_000;
const TITLE_MAX = 60;
/** The background task kind: one per chat, shown in Background Activity, retryable when it fails. */
export const TITLE_TASK = "session.title";

const SYSTEM = [
  "You write titles for chats.",
  "Reply with only the title: at most 6 words (about 15 characters for Chinese, Japanese or Korean), in the language the user wrote in, with no quotes and no full stop at the end.",
].join(" ");

export interface TitleServiceDeps {
  store: AppStore;
  runtime: ModelRuntime;
  recorder: StepRecorder;
  modelsConfig: ModelsConfigSource;
  background: BackgroundTaskService;
  clock: Clock;
  log: Logger;
  gatewayUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/**
 * What a title job needs: the chat's first-message title (`from`, so a rename since wins) and the clipped first exchange.
 * The text is the one transcript copy a background payload holds; it is dropped once the title is set, and when the chat is deleted.
 */
interface TitlePayload {
  runId: string;
  from: string;
  user: string;
  reply: string;
}

/**
 * A model-written title for a chat you started, once its first reply is in (Settings > Chat titles picks the model).
 * Each title is a background task, so a failure shows in Background Activity with its reason and can be retried there.
 */
export class TitleService {
  readonly #d: TitleServiceDeps;
  readonly #inFlight = new Set<Promise<void>>();
  #stopped = false;

  constructor(deps: TitleServiceDeps) {
    this.#d = deps;
    deps.background.register(TITLE_TASK, (job, task) => this.#title(job, task));
  }

  start(): void {
    this.#stopped = false;
    this.#d.store.onRunFinished = (runId) => {
      const job = this.#enqueue(runId).finally(() => this.#inFlight.delete(job));
      this.#inFlight.add(job);
    };
  }

  /** Stops queueing new titles and waits for the ones being queued (the background executor owns the running ones). */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#d.store.onRunFinished = undefined;
    await Promise.allSettled([...this.#inFlight]);
  }

  async settings(): Promise<TitleSettings> {
    const config = parseModelsConfig(await this.#d.modelsConfig.read().catch(() => undefined));
    return {
      enabled: this.#d.store.metaGet(ENABLED_KEY) !== "0",
      model: this.#d.store.metaGet(MODEL_KEY) ?? null,
      default: config.fast.model,
    };
  }

  async update(patch: { enabled?: boolean; model?: string | null }): Promise<TitleSettings> {
    const { store } = this.#d;
    store.tx(() => {
      if (patch.enabled !== undefined) store.metaSet(ENABLED_KEY, patch.enabled ? null : "0");
      if (patch.model !== undefined) store.metaSet(MODEL_KEY, patch.model);
    });
    return this.settings();
  }

  async #enqueue(runId: string): Promise<void> {
    const d = this.#d;
    try {
      const source = d.store.titleSource(runId);
      // Faux mode scripts its replies; a title call would use one up.
      if (!source || d.runtime.mode === "faux") return;
      if (!(await this.settings()).enabled || this.#stopped) return;
      const payload: TitlePayload = {
        runId,
        from: source.current,
        user: clip(source.user),
        reply: clip(source.reply),
      };
      d.background.enqueue({
        kind: TITLE_TASK,
        dedupe: `${TITLE_TASK}:${source.sessionId}`,
        sessionId: source.sessionId,
        agentId: d.store.getSessionRow(source.sessionId)?.agent_id ?? "",
        payload,
      });
    } catch (cause) {
      // A title is a nicety: the first-message title stays.
      if (!this.#stopped)
        d.log.warn("session.title_enqueue_failed", { runId, error: cause instanceof Error ? cause.name : "error" });
    }
  }

  /** One attempt: ask the model, then set the title if the chat still has the title it was given at its first message. */
  async #title(job: BackgroundJob, task: TaskContext): Promise<TaskOutcome> {
    const d = this.#d;
    const payload = JSON.parse(job.payload) as Partial<TitlePayload>;
    const session = job.session_id ? d.store.getSessionRow(job.session_id) : undefined;
    if (!session || typeof payload.from !== "string" || typeof payload.user !== "string")
      throw new TaskFailure("SOURCE_UNAVAILABLE", "The chat or its first message is no longer available.");
    if (session.title !== payload.from) return { status: "skipped", result: { reason: "TITLE_CHANGED" } };
    const settings = await this.settings();
    if (!settings.enabled) return { status: "skipped", result: { reason: "DISABLED" } };
    const modelId = settings.model ?? settings.default;
    const reply = payload.reply ?? "";
    const prompt = `User: ${payload.user}${reply.trim() === "" ? "" : `\n\nAssistant: ${reply}`}\n\nWrite the title for this chat.`;
    let provider: string | null = null;
    let asked: Awaited<ReturnType<typeof askModelResult>>;
    try {
      provider = d.runtime.ref(modelId).provider;
      d.store.db.run(
        "UPDATE background_attempts SET provider=?,model=? WHERE job_id=? AND attempt=?",
        provider,
        modelId,
        job.id,
        job.attempt,
      );
      asked = await askModelResult(d, modelId, SYSTEM, prompt, "title");
    } catch (cause) {
      throw new TaskFailure(
        "MODEL_CALL_FAILED",
        d.runtime.scrub(cause instanceof Error ? cause.message : "The model call could not start."),
      );
    }
    if (!asked.ok)
      throw new TaskFailure(
        asked.reason === "unknown_model"
          ? "MODEL_UNAVAILABLE"
          : asked.reason === "aborted"
            ? "MODEL_TIMED_OUT"
            : "MODEL_CALL_FAILED",
        asked.message,
      );
    const title = cleanTitle(asked.text);
    if (title === undefined) throw new TaskFailure("EMPTY_TITLE", "The model replied with no usable title.");
    return d.store.tx(() => {
      task.assertLive();
      const applied = d.store.setGeneratedTitle(session.id, payload.from!, title);
      // The title is set (or no longer wanted): the copy of the first exchange has done its job.
      d.store.db.run(
        "UPDATE background_jobs SET payload=? WHERE id=?",
        JSON.stringify({ runId: payload.runId }),
        job.id,
      );
      const outcome: TaskOutcome = applied
        ? { status: "succeeded", result: { title } }
        : { status: "skipped", result: { reason: "TITLE_CHANGED" } };
      task.complete(outcome);
      if (applied) d.log.debug("session.titled", { sessionId: session.id });
      return outcome;
    });
  }
}

function clip(text: string): string {
  return text.length > CLIP ? `${text.slice(0, CLIP)}…` : text;
}

/** The first line of the reply, without quotes, a "Title:" lead-in or a closing full stop; undefined when nothing is left. */
export function cleanTitle(text: string): string | undefined {
  let line =
    text
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .find((l) => l !== "") ?? "";
  line = line
    .replace(/^title\s*:\s*/i, "")
    .replace(/^["'“”‘’`*#\s]+|["'“”‘’`*\s]+$/g, "")
    .replace(/[.。]+$/, "")
    .trim();
  if (line === "") return undefined;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}
