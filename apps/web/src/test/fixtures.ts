import type {
  Agent,
  Approval,
  Grant,
  HistoryHit,
  IndexStatus,
  MemoryChange,
  MemoryLine,
  MemorySuggestion,
  Message,
  MessagePart,
  Run,
  RunTrace,
  Session,
  SessionBrowser,
  SkillFile,
  SkillResponse,
  SkillSummary,
  StepSummary,
  Takeover,
  Trigger,
  TriggerPreview,
  TriggerRunSummary,
} from "@rei/protocol";

export const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  agentId: "a1",
  origin: "user",
  pinned: false,
  title: "Hello",
  status: "idle",
  preview: "",
  parentSessionId: null,
  forkedFrom: null,
  depth: 0,
  profile: "standard",
  taint: [],
  pendingApprovals: 0,
  unread: 0,
  browser: null,
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
});

export const agent = (over: Partial<Agent> = {}): Agent => ({
  id: "a1",
  name: "Dot",
  avatar: "D",
  model: null,
  thinkingLevel: "off",
  networkMode: "block",
  defaultProfile: "standard",
  homeSessionId: "home1",
  ...over,
});

export const message = (over: Partial<Message> = {}): Message => ({
  id: "m1",
  sessionId: "s1",
  role: "assistant",
  runId: "r1",
  text: "",
  status: "streaming",
  createdAt: 1000,
  ...over,
});

export const run = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  sessionId: "s1",
  status: "running",
  startedAt: 1000,
  endedAt: null,
  ...over,
});

export const approval = (over: Partial<Approval> = {}): Approval => ({
  id: "ap1",
  number: 3,
  sessionId: "s1",
  sessionTitle: "Hello",
  agentId: "a1",
  tool: "demo_send",
  connector: "demo",
  operation: "send_email",
  actionClass: "send",
  destination: "ana@example.com",
  summary: 'Send "Lunch?" to ana@example.com',
  argsPreview: '{\n  "to": "ana@example.com"\n}',
  taint: [],
  lengths: ["once", "session", "agent", "hours", "always"],
  status: "pending",
  createdAt: 1000,
  expiresAt: Date.now() + 2 * 3_600_000,
  decidedAt: null,
  ...over,
});

export const grant = (over: Partial<Grant> = {}): Grant => ({
  id: "g1",
  connector: "demo",
  operation: "send_email",
  destination: "ana@example.com",
  length: "always",
  sessionId: null,
  agentId: null,
  expiresAt: null,
  approvalId: "ap1",
  createdAt: 1000,
  ...over,
});

export const takeover = (over: Partial<Takeover> = {}): Takeover => ({
  id: "t1",
  sessionId: "s1",
  requestedBy: "agent",
  reason: "Sign in to the bank",
  status: "pending",
  url: "https://bank.example.com/login",
  title: "Sign in",
  note: null,
  createdAt: 1000,
  endedAt: null,
  ...over,
});

export const sessionBrowser = (over: Partial<SessionBrowser> = {}): SessionBrowser => ({
  url: "https://bank.example.com/login",
  title: "Sign in",
  takeover: null,
  ...over,
});

export const memoryLine = (over: Partial<MemoryLine> = {}): MemoryLine => ({
  id: "m1",
  doc: "profile",
  agentId: null,
  text: "Lives in Hong Kong.",
  source: null,
  sourceDeleted: false,
  addedAt: 1000,
  confirmedAt: Date.now() - 3 * 86_400_000,
  updatedAt: 1000,
  ...over,
});

export const memoryChange = (over: Partial<MemoryChange> = {}): MemoryChange => ({
  id: "c1",
  lineId: "m1",
  doc: "profile",
  agentId: null,
  op: "add",
  before: null,
  after: "Lives in Hong Kong.",
  by: "agent",
  sessionId: "s1",
  at: 1000,
  undoneAt: null,
  undoable: true,
  ...over,
});

export const memorySuggestion = (over: Partial<MemorySuggestion> = {}): MemorySuggestion => ({
  id: "sg1",
  doc: "profile",
  agentId: null,
  op: "add",
  lineId: null,
  current: null,
  text: "Prefers metric units.",
  sessionId: "s1",
  status: "pending",
  createdAt: 1000,
  reportedAt: null,
  ...over,
});

export const historyHit = (over: Partial<HistoryHit> = {}): HistoryHit => ({
  chunkId: "e1",
  sessionId: "s1",
  sessionTitle: "Tokyo trip",
  agentId: "a1",
  messageId: "m9",
  kind: "user",
  toolName: null,
  snippet: "We booked the hotel in Shinjuku for March.",
  createdAt: 1000,
  score: 0.03,
  keywordRank: 2,
  vectorRank: 1,
  cosine: 0.71,
  taint: [],
  ...over,
});

export const indexStatus = (over: Partial<IndexStatus> = {}): IndexStatus => ({
  state: "ready",
  model: "mlx-community/embeddinggemma-2-6bit affine-6bit-g64-bf16",
  dimensions: 768,
  entries: 1234,
  embedded: 1234,
  building: null,
  lastError: null,
  remote: false,
  ...over,
});

/** A memory-role message carrying a change. */
export const memoryMessage = (memory: NonNullable<Message["memory"]>, over: Partial<Message> = {}): Message => ({
  id: "mm1",
  sessionId: "s1",
  role: "memory",
  runId: "r1",
  text: "",
  status: "complete",
  createdAt: 1000,
  memory,
  ...over,
});

// ---- Components and Full mode -------------------------------------------------------------------------------------------

/** A surface part, as the server sends it: one createSurface message in Rei's catalog. */
export const surfacePart = (
  components: Record<string, unknown>[],
  over: {
    surfaceId?: string;
    title?: string;
    data?: Record<string, unknown>;
    revision?: number;
    state?: "live" | "idle" | "removed" | "frozen";
    fallback?: string;
  } = {},
): MessagePart => {
  const surfaceId = over.surfaceId ?? "srf_1";
  return {
    type: "surface",
    surface: {
      surfaceId,
      sessionId: "s1",
      runId: "r1",
      revision: over.revision ?? 1,
      state: over.state ?? "idle",
      title: over.title ?? "Surface",
      fallback: over.fallback ?? "fallback text",
      protocolVersion: "1.0",
      updatedAt: 1000,
      ...(over.state === "removed"
        ? {}
        : {
            message: {
              version: "1.0",
              createSurface: {
                surfaceId,
                catalogId: "rei/catalog/1",
                components: components as { id: string; component: string }[],
                dataModel: over.data ?? {},
              },
            },
          }),
    },
  };
};

export const step = (over: Partial<StepSummary> = {}): StepSummary => ({
  id: "st1",
  runId: "r1",
  sessionId: "s1",
  type: "llm.call",
  status: "ok",
  startedAt: 1000,
  latencyMs: 2300,
  piEntryId: "e1",
  sideEffect: false,
  provider: "gateway",
  providerName: "Gateway",
  model: "gpt-6.1-sol",
  firstByteMs: 400,
  tokens: { input: 1234, output: 321, cached: 100, reasoning: 0, total: 1555 },
  ...over,
});

export const toolStep = (over: Partial<StepSummary> = {}): StepSummary =>
  step({
    id: "st2",
    type: "tool.call",
    toolName: "web_search",
    actionClass: "read_external",
    decision: "allow",
    approvalId: null,
    summary: "Search the web",
    latencyMs: 800,
    model: undefined as never,
    tokens: undefined as never,
    provider: undefined as never,
    firstByteMs: undefined as never,
    ...over,
  });

export const runTrace = (over: Partial<RunTrace> = {}): RunTrace => ({
  run: run({ status: "completed", endedAt: 5000 }),
  triggerMessageId: "u1",
  steps: [step(), toolStep()],
  totals: { modelCalls: 1, toolCalls: 1, tokens: 1555, durationMs: 4000 },
  ...over,
});

export const trigger = (over: Partial<Trigger> = {}): Trigger => ({
  id: "trg1",
  name: "Morning check",
  agentId: "a1",
  start: { kind: "schedule", schedule: { kind: "daily", times: ["09:00"], timeZone: "Asia/Macau" } },
  startText: "Every day at 09:00 (Asia/Macau)",
  action: { kind: "prompt", prompt: "Check the weather and tell me if I need an umbrella." },
  landing: "new",
  ongoingSessionId: null,
  report: "on_change",
  hideInList: true,
  latenessMinutes: 120,
  catchUp: "once",
  overlap: "skip",
  profile: "standard",
  allow: [],
  status: "active",
  pausedReason: null,
  failures: 0,
  nextRunAt: Date.now() + 3_600_000,
  lastEventAt: null,
  lastRun: null,
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
});

export const triggerRun = (over: Partial<TriggerRunSummary> = {}): TriggerRunSummary => ({
  id: "trr1",
  triggerId: "trg1",
  scheduledAt: 1_700_000_000_000,
  startedAt: 1_700_000_000_000,
  finishedAt: 1_700_000_042_000,
  status: "succeeded",
  reason: null,
  manual: false,
  sessionId: "s9",
  runId: "r9",
  skillVersion: null,
  report: null,
  attempt: 0,
  events: [],
  droppedEvents: 0,
  ...over,
});

export const triggerPreview = (over: Partial<TriggerPreview> = {}): TriggerPreview => ({
  kind: "trigger",
  op: "create",
  name: "Morning check",
  agentName: "Dot",
  startKind: "schedule",
  startText: "Every day at 09:00 (Asia/Macau)",
  nextRuns: [Date.now() + 3_600_000, Date.now() + 90_000_000, Date.now() + 176_400_000],
  action: { kind: "prompt", prompt: "Check the weather." },
  landing: "new",
  report: "on_change",
  hideInList: true,
  latenessMinutes: 120,
  catchUp: "once",
  overlap: "skip",
  profile: "standard",
  allow: [],
  ...over,
});

export const skillSummary = (over: Partial<SkillSummary> = {}): SkillSummary => ({
  id: "skl1",
  name: "weekly-review",
  description: "Summarise the week from my notes.",
  version: 2,
  agents: null,
  fileCount: 1,
  author: "agent",
  createdAt: 1000,
  updatedAt: 2000,
  ...over,
});

export const SKILL_MD =
  "---\nname: weekly-review\ndescription: Summarise the week from my notes.\n---\n# Weekly review\n\n1. Read the notes.\n2. Write the summary.\n";

export const skillFile = (over: Partial<SkillFile> = {}): SkillFile => ({
  path: "SKILL.md",
  encoding: "text",
  content: SKILL_MD,
  ...over,
});

export const skillResponse = (over: Partial<SkillResponse> = {}): SkillResponse => ({
  skill: skillSummary(),
  version: 2,
  files: [skillFile()],
  versions: [
    { version: 2, author: "agent", sessionId: "s5", note: "Saved from chat", createdAt: 2000 },
    { version: 1, author: "user", sessionId: null, note: "Imported", createdAt: 1000 },
  ],
  ...over,
});
