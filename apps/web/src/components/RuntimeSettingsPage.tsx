import {
  type BehaviorSettingsResponse,
  type CompactionPolicySettings,
  type ContextSettings,
  DEFAULT_MODEL_DEADLINES,
  type HomeContextSettings,
  type ModelSetting,
} from "@rei/protocol";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Field, FieldDescription } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Label } from "@/components/primitives/label.tsx";
import { Switch } from "@/components/primitives/switch.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/primitives/tabs.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import { useDirtyBaseline, useReportUnsaved } from "../lib/unsaved.tsx";
import { PageShell } from "./PageShell.tsx";
import { SaveStatus } from "./SaveStatus.tsx";

type RuntimeApi = Pick<
  Api,
  | "getContextSettings"
  | "updateContextSettings"
  | "getBehaviorSettings"
  | "updateBehaviorSettings"
  | "getModelSettings"
  | "updateModelSettings"
>;

type Flag = "compactionEnabled" | "injectProfile" | "injectRecent" | "nativeSearch" | "codeMode" | "steer";
type Flags = Record<Flag, boolean>;

interface NumberField {
  /** Draft key, "group.field": the same name the request uses for the value. */
  key: string;
  label: string;
  help: string;
  /** What a reset restores, shown after the help text. */
  defaultText: string;
  min: number;
  /** Omitted when the setting has no upper bound. */
  max?: number;
  /** An empty box saves as null, which means the model's own limit. */
  allowEmpty?: boolean;
}

const RUNTIME_TABS = [
  { value: "context", label: "Context" },
  { value: "runs", label: "Runs" },
  { value: "tools", label: "Tools" },
] as const;
type RuntimeTab = (typeof RUNTIME_TABS)[number]["value"];

const TIMEOUT_FIELDS = [
  ["firstEventMs", "First response", "Maximum time before the model starts responding."],
  ["idleMs", "Response pause", "Maximum time between response updates."],
  ["totalMs", "Total call", "Maximum time for the complete model call."],
] as const;
type TimeoutField = (typeof TIMEOUT_FIELDS)[number][0];

interface Section {
  tab: RuntimeTab;
  title: string;
  blurb: string;
  switches: { flag: Flag; label: string }[];
  fields: NumberField[];
}

interface Loaded {
  context: ContextSettings;
  behavior: BehaviorSettingsResponse;
  standard: ModelSetting;
}

const DEFAULT_FLAGS: Flags = {
  compactionEnabled: true,
  injectProfile: true,
  injectRecent: true,
  nativeSearch: false,
  codeMode: false,
  steer: true,
};

const whole = (n: number) => n.toLocaleString();
const rangeMessage = (f: NumberField) =>
  f.max === undefined
    ? `“${f.label}” must be a whole number, ${f.min} or more.`
    : `“${f.label}” must be a whole number from ${f.min} to ${whole(f.max)}.`;

/** Every section of the page, in order, with the defaults and limits the server reported. */
function sectionsFor({ context, behavior }: Loaded): Section[] {
  const c = context.defaults.compaction;
  const h = context.defaults.home;
  const { ceilings, defaults } = behavior;
  const bDefault = (group: keyof typeof defaults, key: string) => {
    const v = (defaults[group] as Record<string, unknown>)[key];
    return v === null ? "none" : whole(Number(v));
  };
  return [
    {
      tab: "context",
      title: "Automatic summaries",
      blurb:
        "When a chat outgrows its model's window, Rei summarizes its older messages. Off, such a chat fails instead of being summarized.",
      switches: [{ flag: "compactionEnabled", label: "Summarize long chats automatically" }],
      fields: [
        {
          key: "compaction.reserveTokens",
          label: "Room kept for the answer (tokens)",
          help: "Rei summarizes once a chat is within this many tokens of the model's context window.",
          defaultText: whole(c.reserveTokens),
          min: 1,
        },
        {
          key: "compaction.keepRecentTokens",
          label: "Recent context kept word for word (tokens)",
          help: "About how much of the newest conversation a summary leaves as it is.",
          defaultText: whole(c.keepRecentTokens),
          min: 1,
        },
        {
          key: "compaction.backgroundTokens",
          label: "Start early in the background (tokens)",
          help: "Summarize this many tokens before the limit, while the chat keeps working. 0 turns early summaries off.",
          defaultText: whole(c.backgroundTokens),
          min: 0,
        },
      ],
    },
    {
      tab: "context",
      title: "Home chat",
      blurb: "Rei summarizes older turns when the chat grows or has been quiet. The full transcript stays in the chat.",
      switches: [],
      fields: [
        {
          key: "home.idleGapMinutes",
          label: "Idle time before summarizing (minutes)",
          help: "After this much time without a message from you, Rei checks whether there is enough older context to summarize.",
          defaultText: whole(h.idleGapMinutes),
          min: 1,
        },
        {
          key: "home.maxTokens",
          label: "Context budget (tokens)",
          help: "Working budget for Home chat. Rei starts summarizing before it reaches this limit.",
          defaultText: whole(h.maxTokens),
          min: 1,
        },
      ],
    },
    {
      tab: "runs",
      title: "Messages during a reply",
      blurb:
        "On, a message you send while a reply is running joins it after its current step, so the agent can change course. Off, it waits and gets its own reply. Alt+Enter does the other for one message.",
      switches: [{ flag: "steer", label: "Steer the running reply" }],
      fields: [],
    },
    {
      tab: "runs",
      title: "Run limits",
      blurb: `Safety limits that stop a run that loops. They can't be turned off; the highest allowed is ${ceilings.maxModelCalls} calls and ${ceilings.maxRunMinutes} minutes.`,
      switches: [],
      fields: [
        {
          key: "runLimits.maxModelCalls",
          label: "Model calls per run",
          help: "A run is stopped before its next call after this many.",
          defaultText: bDefault("runLimits", "maxModelCalls"),
          min: 1,
          max: ceilings.maxModelCalls,
        },
        {
          key: "runLimits.maxRunMinutes",
          label: "Longest run (minutes)",
          help: "A run over this time is stopped before its next model call.",
          defaultText: bDefault("runLimits", "maxRunMinutes"),
          min: 1,
          max: ceilings.maxRunMinutes,
        },
      ],
    },
    {
      tab: "runs",
      title: "Agent chat timeouts",
      blurb: "Set how long Rei waits during a model call in an agent chat.",
      switches: [],
      fields: TIMEOUT_FIELDS.map(([field, label, help]) => ({
        key: `timeout.${field}`,
        label: `${label} (seconds)`,
        help,
        defaultText: whole(DEFAULT_MODEL_DEADLINES[field] / 1000),
        min: 1,
        max: 7200,
      })),
    },
    {
      tab: "runs",
      title: "Retries",
      blurb:
        "When a model call fails for a temporary reason. Only the model call is retried, never a tool's side effects.",
      switches: [],
      fields: [
        {
          key: "retry.maxRetries",
          label: "Retries per failed call",
          help: "0 turns retries off.",
          defaultText: bDefault("retry", "maxRetries"),
          min: 0,
          max: ceilings.maxRetries,
        },
        {
          key: "retry.baseDelaySeconds",
          label: "Wait before the first retry (seconds)",
          help: "Later retries wait longer.",
          defaultText: bDefault("retry", "baseDelaySeconds"),
          min: 1,
          max: 60,
        },
      ],
    },
    {
      tab: "runs",
      title: "Output",
      blurb:
        "Limits how long a single model reply may be. Leave empty to use each model's own limit; this never raises it.",
      switches: [],
      fields: [
        {
          key: "generation.maxOutputTokens",
          label: "Reply length cap (tokens)",
          help: "Empty means no cap.",
          defaultText: bDefault("generation", "maxOutputTokens"),
          min: 1,
          max: 10_000_000,
          allowEmpty: true,
        },
      ],
    },
    {
      tab: "context",
      title: "Memory",
      blurb: "What agents see from memory at the start of each reply.",
      switches: [
        { flag: "injectProfile", label: "Put the profile and agent notes in context" },
        { flag: "injectRecent", label: "Put recent chats in context" },
      ],
      fields: [
        {
          key: "memory.historyHits",
          label: "Chat history results",
          help: "How many matches a history search returns.",
          defaultText: bDefault("memory", "historyHits"),
          min: 1,
          max: 20,
        },
      ],
    },
    {
      tab: "tools",
      title: "Web search",
      blurb:
        "OpenAI models can search with OpenAI's built-in tool instead of the web_search tool and the providers set up under Providers. Other models keep using web_search.",
      switches: [{ flag: "nativeSearch", label: "Use OpenAI's built-in search with OpenAI models" }],
      fields: [],
    },
    {
      tab: "tools",
      title: "Code mode",
      blurb:
        "Lets an agent write a short script that calls its tools in a sandbox, so multi-step work takes fewer replies. Every call the script makes follows the same approval rules.",
      switches: [{ flag: "codeMode", label: "Let agents run scripts" }],
      fields: [],
    },
    {
      tab: "tools",
      title: "Capability search",
      blurb: "How much the search_capabilities tool loads for an agent at once.",
      switches: [],
      fields: [
        {
          key: "discovery.maxConnectorTools",
          label: "Connector tools per search",
          help: "More tools make the model's list longer.",
          defaultText: bDefault("discovery", "maxConnectorTools"),
          min: 1,
          max: 20,
        },
        {
          key: "discovery.maxSkills",
          label: "Skills per search",
          help: "0 stops search from suggesting skills.",
          defaultText: bDefault("discovery", "maxSkills"),
          min: 0,
          max: 10,
        },
      ],
    },
  ];
}

/** Settings > Runtime keeps one draft across its tabs. */
export function RuntimeSettingsPage({ api }: { api: RuntimeApi }) {
  const id = useId();
  const [tab, setTab] = useState<RuntimeTab>("context");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [flags, setFlags] = useState<Flags>(DEFAULT_FLAGS);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { dirty, markSaved } = useDirtyBaseline({ draft, flags });
  useReportUnsaved(dirty);

  const load = useCallback(
    ({ context, behavior, standard }: Loaded) => {
      const s = behavior.settings;
      const nextFlags: Flags = {
        compactionEnabled: context.compaction.enabled,
        injectProfile: s.memory.injectProfile,
        injectRecent: s.memory.injectRecent,
        nativeSearch: s.search.useOpenAiNativeSearch,
        codeMode: s.codeMode.enabled,
        steer: (s.chat?.whenBusy ?? "steer") === "steer",
      };
      const nextDraft: Record<string, string> = {
        "compaction.reserveTokens": String(context.compaction.reserveTokens),
        "compaction.keepRecentTokens": String(context.compaction.keepRecentTokens),
        "compaction.backgroundTokens": String(context.compaction.backgroundTokens),
        "home.idleGapMinutes": String(context.home.idleGapMinutes),
        "home.maxTokens": String(context.home.maxTokens),
        "runLimits.maxModelCalls": String(s.runLimits.maxModelCalls),
        "runLimits.maxRunMinutes": String(s.runLimits.maxRunMinutes),
        "retry.maxRetries": String(s.retry.maxRetries),
        "retry.baseDelaySeconds": String(s.retry.baseDelaySeconds),
        "memory.historyHits": String(s.memory.historyHits),
        "generation.maxOutputTokens": s.generation.maxOutputTokens === null ? "" : String(s.generation.maxOutputTokens),
        "discovery.maxConnectorTools": String(s.discovery.maxConnectorTools),
        "discovery.maxSkills": String(s.discovery.maxSkills),
      };
      for (const [field] of TIMEOUT_FIELDS) {
        nextDraft[`timeout.${field}`] = String(Math.round(standard[field] / 1000));
      }
      setLoaded({ context, behavior, standard });
      setFlags(nextFlags);
      setDraft(nextDraft);
      markSaved({ draft: nextDraft, flags: nextFlags });
    },
    [markSaved],
  );

  useEffect(() => {
    let live = true;
    Promise.all([api.getContextSettings(), api.getBehaviorSettings(), api.getModelSettings()])
      .then(([context, behavior, models]) => {
        if (live) load({ context, behavior, standard: models.standard });
      })
      .catch((e) => {
        if (live) setError(describeError(e));
      });
    return () => {
      live = false;
    };
  }, [api, load]);

  const run = async (call: () => Promise<Loaded>) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      load(await call());
      setSaved(true);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const sections = loaded ? sectionsFor(loaded) : [];

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !loaded) return;
    const values: Record<string, number | null> = {};
    for (const section of sections)
      for (const f of section.fields) {
        const text = (draft[f.key] ?? "").trim();
        if (text === "" && f.allowEmpty) {
          values[f.key] = null;
          continue;
        }
        const n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
        if (!(n >= f.min && (f.max === undefined || n <= f.max))) {
          setTab(section.tab);
          return setError(rangeMessage(f));
        }
        values[f.key] = n;
      }
    // Pick one group's values out of the flat draft, e.g. "home.maxTokens" -> { maxTokens }.
    const group = (name: string) =>
      Object.fromEntries(
        Object.entries(values)
          .filter(([k]) => k.startsWith(`${name}.`))
          .map(([k, v]) => [k.slice(name.length + 1), v]),
      );
    const compaction = {
      enabled: flags.compactionEnabled,
      ...group("compaction"),
    } as Partial<CompactionPolicySettings>;
    const home = group("home") as Partial<HomeContextSettings>;
    const behavior = {
      runLimits: group("runLimits"),
      retry: group("retry"),
      memory: { ...group("memory"), injectProfile: flags.injectProfile, injectRecent: flags.injectRecent },
      generation: group("generation"),
      discovery: group("discovery"),
      search: { useOpenAiNativeSearch: flags.nativeSearch },
      codeMode: { enabled: flags.codeMode },
      chat: { whenBusy: flags.steer ? "steer" : "queue" },
    };
    const timeouts: Partial<Record<TimeoutField, number>> = {};
    for (const [field] of TIMEOUT_FIELDS) {
      const seconds = values[`timeout.${field}`]!;
      if (seconds !== Math.round(loaded.standard[field] / 1000)) timeouts[field] = seconds * 1000;
    }
    await run(async () => {
      const [context, nextBehavior, models] = await Promise.all([
        api.updateContextSettings({ compaction, home }),
        api.updateBehaviorSettings(behavior as never),
        Object.keys(timeouts).length ? api.updateModelSettings({ standard: timeouts }) : undefined,
      ]);
      return { context, behavior: nextBehavior, standard: models?.standard ?? loaded.standard };
    });
  };

  const reset = () =>
    run(async () => {
      const [context, behavior, models] = await Promise.all([
        api.updateContextSettings({ compaction: null, home: null }),
        api.updateBehaviorSettings(null),
        api.updateModelSettings({ standard: DEFAULT_MODEL_DEADLINES }),
      ]);
      return { context, behavior, standard: models.standard };
    });

  return (
    <PageShell title="Runtime">
      {!loaded && !error && <p className="m-0 text-sm text-muted-foreground">Loading runtime settings…</p>}
      {loaded && (
        <form className="grid max-w-2xl gap-6" onSubmit={(e) => void save(e)}>
          <Tabs value={tab} onValueChange={(value) => setTab(value as RuntimeTab)} className="min-w-0 gap-5">
            <TabsList aria-label="Runtime settings" className="max-w-full">
              {RUNTIME_TABS.map(({ value, label }) => (
                <TabsTrigger key={value} value={value}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
            {RUNTIME_TABS.map(({ value }) => (
              <TabsContent key={value} value={value} className="space-y-5">
                {sections
                  .filter((section) => section.tab === value)
                  .map((section) => (
                    <section key={section.title} className="grid gap-4 rounded-2xl border p-4">
                      <h2 className="m-0 text-sm font-medium">{section.title}</h2>
                      <FieldDescription>{section.blurb}</FieldDescription>
                      {section.switches.map(({ flag, label }) => (
                        <div key={flag} className="flex items-center justify-between gap-4">
                          <Label htmlFor={`${id}-${flag}`}>{label}</Label>
                          <Switch
                            id={`${id}-${flag}`}
                            checked={flags[flag]}
                            disabled={busy}
                            onCheckedChange={(on) => {
                              setFlags({ ...flags, [flag]: on });
                              setSaved(false);
                            }}
                          />
                        </div>
                      ))}
                      {section.fields.map((f) => (
                        <Field className="gap-2" key={f.key}>
                          <Label htmlFor={`${id}-${f.key}`}>{f.label}</Label>
                          <Input
                            id={`${id}-${f.key}`}
                            inputMode="numeric"
                            value={draft[f.key] ?? ""}
                            disabled={busy}
                            aria-describedby={`${id}-${f.key}-help`}
                            onChange={(e) => {
                              setDraft({ ...draft, [f.key]: e.target.value });
                              setSaved(false);
                            }}
                          />
                          <FieldDescription id={`${id}-${f.key}-help`}>
                            {f.help} Default: {f.defaultText}.
                          </FieldDescription>
                        </Field>
                      ))}
                    </section>
                  ))}
              </TabsContent>
            ))}
          </Tabs>
          {error && (
            <p className="m-0 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save settings"}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void reset()}>
              Reset all to defaults
            </Button>
            <SaveStatus dirty={dirty} saved={saved} message="Saved. Applies from the next model call." />
          </div>
        </form>
      )}
      {!loaded && error && (
        <p className="m-0 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </PageShell>
  );
}
