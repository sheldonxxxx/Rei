import type {
  Agent,
  AgentCapabilities,
  AgentCapabilitiesPatch,
  AgentInstructionsResponse,
  Connector,
  KnowledgeTreeNode,
  ModelsResponse,
  ReadWriteAccess,
  ScopeAccess,
  UpdateAgentRequest,
} from "@rei/protocol";
import {
  AGENT_NAME_MAX_CHARS,
  READ_WRITE_ACCESS,
  resolveAgentCapabilities,
  SANDBOX_NETWORK_MODES,
  type SandboxNetworkMode,
  SCOPE_ACCESS,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "@rei/protocol";
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Checkbox } from "@/components/primitives/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/primitives/dialog.tsx";
import { Field, FieldContent, FieldDescription } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Label } from "@/components/primitives/label.tsx";
import { NativeSelect } from "@/components/primitives/native-select.tsx";
import { Sheet, SheetContent, SheetTitle } from "@/components/primitives/sheet.tsx";
import { Switch } from "@/components/primitives/switch.tsx";
import { Textarea } from "@/components/primitives/textarea.tsx";
import type { Api } from "../../api/client.ts";
import { describeError } from "../../api/client.ts";
import { useMediaQuery } from "../../lib/route.ts";
import { Avatar } from "../Avatar.tsx";
import { DialogError } from "../dialogParts.tsx";
import { Icon, type IconName } from "../Icon.tsx";
import { indexKnowledgeTree, KnowledgeFolderTree } from "../KnowledgeFolderTree.tsx";
import { PageShell } from "../PageShell.tsx";
import { Tip } from "../Tip.tsx";

/** The picker's value for "no choice, use the default model". */
const DEFAULT_CHOICE = "";
const EFFORT_HELP =
  "Higher effort can improve complex answers but take longer. The model uses its nearest supported effort.";
const NETWORK_LABEL: Record<SandboxNetworkMode, string> = { block: "Block", whitelist: "Whitelist", any: "Any" };
const NETWORK_HELP: Record<SandboxNetworkMode, string> = {
  block: "Blocks all network access from sandbox commands.",
  whitelist:
    "Allows only sites on the sandbox whitelist (Settings → Permissions). For a local-network hostname, add both the name and its IP address or network.",
  any: "Allows any site on ports 80 and 443, including your local network, without approval.",
};
const READ_WRITE_LABEL: Record<ReadWriteAccess, string> = {
  off: "Off",
  read: "Read-only",
  read_write: "Read & write",
};
const CHAT_HISTORY_LABEL: Record<ScopeAccess, string> = {
  off: "Off",
  own: "Own chats",
  all: "All chats",
};
const TRIGGERS_LABEL: Record<ScopeAccess, string> = {
  off: "Off",
  own: "Own triggers",
  all: "All agents",
};
const DELEGATION_LABEL: Record<ScopeAccess, string> = {
  off: "Off",
  own: "Own workers",
  all: "Any agent",
};
const LIBRARY_HELP: Record<ReadWriteAccess, string> = {
  off: "Hides Library search, reading, publishing, and Library file picking in chat.",
  read: "Allows searching and reading saved Library files, without publishing new ones.",
  read_write: "Allows searching, reading, and publishing deliverables to the Library.",
};
const KNOWLEDGE_HELP: Record<ReadWriteAccess, string> = {
  off: "Hides Knowledge tools, prompt index, and @page mentions.",
  read: "Allows browsing, searching, and reading Knowledge pages without editing them.",
  read_write: "Allows reading, creating, editing, moving, and archiving Knowledge pages.",
};
const MEMORY_HELP: Record<ReadWriteAccess, string> = {
  off: "Omits user profile & agent notes from context and disables memory tools and background review.",
  read: "Includes user profile & agent notes in context as read-only without saving new lines.",
  read_write: "Includes profile & notes in context and allows saving, updating, and background review.",
};
const CHAT_HISTORY_HELP: Record<ScopeAccess, string> = {
  off: "Disables history search, recent activity, read_chat, and @chat mentions.",
  own: "Restricts history search, read_chat, and @chat mentions to this agent's chats.",
  all: "Allows searching and reading chats across all agents.",
};
const TRIGGERS_HELP: Record<ScopeAccess, string> = {
  off: "Prevents this agent from listing, creating, changing, or deleting triggers.",
  own: "Lets this agent manage only its own scheduled and event-driven triggers.",
  all: "Lets this agent create, change, pause, and delete triggers for any agent.",
};
const DELEGATION_HELP: Record<ScopeAccess, string> = {
  off: "Disables starting or managing background worker sessions.",
  own: "Lets this agent start background worker sessions using itself only.",
  all: "Lets this agent start background worker sessions using any agent.",
};

type AgentSection = "general" | "tools" | "context" | "automation" | "connectors";

const AGENT_SECTIONS: readonly { id: AgentSection; label: string; title: string; icon: IconName }[] = [
  { id: "general", label: "General", title: "General", icon: "sliders" },
  { id: "tools", label: "Tools", title: "Workspace & tools", icon: "wrench" },
  { id: "context", label: "Context & data", title: "Context & data", icon: "memory" },
  { id: "automation", label: "Automation", title: "Automation & delegation", icon: "clock" },
  { id: "connectors", label: "Connectors", title: "Connectors", icon: "globe" },
];

interface Props {
  agent: Agent;
  mode?: "agent" | "model";
  /** Wide viewports show a two-pane landscape window matching Settings; narrow viewports use a full-screen sheet. */
  wide?: boolean;
  api: Api;
  onClose: () => void;
  /** Open the look picker (closes this dialog first). */
  onChangeLook: () => void;
}

function SettingSwitchRow({
  id,
  label,
  help,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Field orientation="horizontal" className="setting-row min-w-0 items-center justify-between gap-5 py-5">
      <FieldContent className="setting-text min-w-0">
        <Label htmlFor={id} className="setting-label text-sm font-medium">
          {label}
        </Label>
        <FieldDescription className="setting-help m-0 max-w-xl text-sm text-muted-foreground">{help}</FieldDescription>
      </FieldContent>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </Field>
  );
}

function SettingSelectRow<T extends string>({
  id,
  label,
  help,
  helpId,
  value,
  disabled,
  options,
  optionLabel,
  className = "",
  onChange,
  children,
}: {
  id: string;
  label: string;
  help: string;
  helpId?: string;
  value: T;
  disabled: boolean;
  options: readonly T[];
  optionLabel: (value: T) => string;
  className?: string;
  onChange: (value: T) => void;
  children?: ReactNode;
}) {
  return (
    <div className={`min-w-0 ${className}`.trim()}>
      <Field
        orientation="horizontal"
        className="setting-row max-sm:flex-col max-sm:items-stretch min-w-0 items-start justify-between gap-5 py-5"
      >
        <FieldContent className="setting-text min-w-0">
          <Label htmlFor={id} className="setting-label text-sm font-medium">
            {label}
          </Label>
          <FieldDescription id={helpId} className="setting-help m-0 max-w-xl text-sm text-muted-foreground">
            {help}
          </FieldDescription>
        </FieldContent>
        <NativeSelect
          id={id}
          className="setting-select min-w-0 max-w-full shrink-0 sm:min-w-40 max-sm:w-full"
          value={value}
          disabled={disabled}
          aria-describedby={helpId}
          onChange={(e) => onChange(e.target.value as T)}
        >
          {options.map((v) => (
            <option key={v} value={v}>
              {optionLabel(v)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {children}
    </div>
  );
}

/** Agent identity settings, or the model/effort settings opened from the composer toolbar. */
export function AgentSettingsDialog({ agent, mode = "agent", wide, api, onClose, onChangeLook }: Props) {
  const mediaWide = useMediaQuery("(min-width: 768px)");
  const isWide = wide ?? mediaWide;
  const [section, setSection] = useState<AgentSection>("general");
  const bodyRef = useRef<HTMLDivElement>(null);
  const connectorModeId = useId();
  const [allowedConnectorIds, setAllowedConnectorIds] = useState<string[] | null>(agent.allowedConnectorIds ?? null);
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [connectorsFailed, setConnectorsFailed] = useState(false);
  const knowledgeScopeId = useId();
  const [allowedKnowledgePageIds, setAllowedKnowledgePageIds] = useState<string[] | null>(
    agent.allowedKnowledgePageIds ?? null,
  );
  const [knowledgeTreeNodes, setKnowledgeTreeNodes] = useState<KnowledgeTreeNode[] | null>(null);
  const [knowledgeTreeError, setKnowledgeTreeError] = useState("");
  const nameId = useId();
  const modelId = useId();
  const effortId = useId();
  const effortHelpId = useId();
  const [open, setOpen] = useState(true);
  const changingLook = useRef(false);
  const [name, setName] = useState(agent.name);
  const [choice, setChoice] = useState(agent.model ?? DEFAULT_CHOICE);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(agent.thinkingLevel);
  const [networkMode, setNetworkMode] = useState<SandboxNetworkMode>(agent.networkMode);
  const initialCapabilities = resolveAgentCapabilities(agent.capabilities, agent.canCreateTriggersForOtherAgents);
  const [capabilities, setCapabilities] = useState<AgentCapabilities>(initialCapabilities);
  const sandboxId = useId();
  const networkId = useId();
  const networkHelpId = useId();
  const webId = useId();
  const browserId = useId();
  const libraryId = useId();
  const imagesId = useId();
  const knowledgeId = useId();
  const memoryId = useId();
  const chatHistoryId = useId();
  const triggersId = useId();
  const delegationId = useId();
  const [catalog, setCatalog] = useState<ModelsResponse | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const instructionsId = useId();
  const [saved, setSaved] = useState<AgentInstructionsResponse | null>(null);
  const [instructions, setInstructions] = useState("");

  useEffect(() => {
    if (mode !== "agent") return;
    let live = true;
    void Promise.resolve()
      .then(() => api.getAgentInstructions(agent.id))
      .then(
        (r) => {
          if (!live) return;
          setSaved(r);
          setInstructions(r.instructions);
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [api, mode, agent.id]);

  useEffect(() => {
    if (mode !== "model") return;
    let live = true;
    void (async () => {
      try {
        const models = await api.getModels();
        if (live) setCatalog(models);
      } catch {
        if (live) setCatalogFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [api, mode]);

  useEffect(() => {
    if (mode !== "agent") return;
    let live = true;
    void Promise.resolve()
      .then(() => api.getConnectors())
      .then(
        (result) => {
          if (live) setConnectors(result.connectors);
        },
        () => {
          if (live) setConnectorsFailed(true);
        },
      );
    return () => {
      live = false;
    };
  }, [api, mode]);

  useEffect(() => {
    if (mode !== "agent" || capabilities.knowledge === "off" || allowedKnowledgePageIds === null) return;
    if (knowledgeTreeNodes !== null || !api.knowledgeTree) return;
    let cancelled = false;
    api.knowledgeTree().then(
      (res) => {
        if (cancelled) return;
        setKnowledgeTreeNodes(res.pages);
        setKnowledgeTreeError("");
      },
      (e) => {
        if (!cancelled) setKnowledgeTreeError(describeError(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, mode, capabilities.knowledge, allowedKnowledgePageIds, knowledgeTreeNodes]);

  const knowledgeTree = useMemo(() => indexKnowledgeTree(knowledgeTreeNodes ?? []), [knowledgeTreeNodes]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset scroll position when switching sections.
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [section]);

  const trimmed = name.trim();
  const chosen = choice === DEFAULT_CHOICE ? null : choice; // null is "the default model"
  const patch: UpdateAgentRequest = {};
  if (mode === "agent" && trimmed !== agent.name) patch.name = trimmed;
  if (
    mode === "agent" &&
    JSON.stringify(allowedConnectorIds?.toSorted() ?? null) !==
      JSON.stringify(agent.allowedConnectorIds?.toSorted() ?? null)
  )
    patch.allowedConnectorIds = allowedConnectorIds;
  if (
    mode === "agent" &&
    JSON.stringify(allowedKnowledgePageIds?.toSorted() ?? null) !==
      JSON.stringify(agent.allowedKnowledgePageIds?.toSorted() ?? null)
  )
    patch.allowedKnowledgePageIds = allowedKnowledgePageIds;
  if (mode === "agent" && networkMode !== agent.networkMode) patch.networkMode = networkMode;
  if (mode === "agent") {
    const capPatch: AgentCapabilitiesPatch = {};
    if (capabilities.sandbox !== initialCapabilities.sandbox) capPatch.sandbox = capabilities.sandbox;
    if (capabilities.web !== initialCapabilities.web) capPatch.web = capabilities.web;
    if (capabilities.browser !== initialCapabilities.browser) capPatch.browser = capabilities.browser;
    if (capabilities.library !== initialCapabilities.library) capPatch.library = capabilities.library;
    if (capabilities.images !== initialCapabilities.images) capPatch.images = capabilities.images;
    if (capabilities.knowledge !== initialCapabilities.knowledge) capPatch.knowledge = capabilities.knowledge;
    if (capabilities.memory !== initialCapabilities.memory) capPatch.memory = capabilities.memory;
    if (capabilities.chatHistory !== initialCapabilities.chatHistory) capPatch.chatHistory = capabilities.chatHistory;
    if (capabilities.triggers !== initialCapabilities.triggers) capPatch.triggers = capabilities.triggers;
    if (capabilities.delegation !== initialCapabilities.delegation) capPatch.delegation = capabilities.delegation;
    if (Object.keys(capPatch).length > 0) patch.capabilities = capPatch;
  }
  if (mode === "agent" && saved && instructions.trim() !== saved.instructions) patch.instructions = instructions.trim();
  if (mode === "model" && chosen !== agent.model) patch.model = chosen;
  if (mode === "model" && thinkingLevel !== agent.thinkingLevel) patch.thinkingLevel = thinkingLevel;
  const changed = Object.keys(patch).length > 0;
  const nameBad = trimmed.length < 1 || trimmed.length > AGENT_NAME_MAX_CHARS;
  const options = catalog?.models ?? [];
  const defaultAvailable = !!catalog && options.includes(catalog.default);
  const supported = catalog?.thinkingLevels?.[chosen ?? catalog.default];
  const efforts = THINKING_LEVELS.filter(
    (level) => level === "off" || level === thinkingLevel || !supported || supported.includes(level),
  );

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(agent.id, patch);
      onClose();
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  if (mode === "model") {
    return (
      <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
        <DialogContent
          size="lg"
          showCloseButton={false}
          aria-describedby={undefined}
          className="agent-settings min-w-0 [&>*]:min-w-0"
          onEscapeKeyDown={(e) => busy && e.preventDefault()}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            document.getElementById(modelId)?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Model settings</DialogTitle>
            <DialogDescription>Applies to all chats with {agent.name}, from the next reply.</DialogDescription>
          </DialogHeader>
          <Field className="gap-2">
            <Label htmlFor={modelId}>Model</Label>
            <NativeSelect
              id={modelId}
              className="w-full"
              value={choice}
              disabled={busy || !options.length}
              onChange={(e) => setChoice(e.target.value)}
            >
              <option value={DEFAULT_CHOICE} disabled={!defaultAvailable}>
                {!catalog
                  ? "Loading models…"
                  : !options.length
                    ? "No models available"
                    : defaultAvailable
                      ? `Default (${catalog.default})`
                      : "Default unavailable"}
              </option>
              {choice && !options.includes(choice) && options.length > 0 && (
                <option value={choice} disabled>
                  Current model unavailable
                </option>
              )}
              {options.map((m) => (
                <option key={m} value={m}>
                  {catalog?.labels?.[m] ?? m}
                </option>
              ))}
            </NativeSelect>
            <FieldDescription>
              {catalogFailed
                ? "The model list could not be loaded."
                : !options.length
                  ? "Configure a provider in Settings → Providers."
                  : "Applies from the next reply."}
            </FieldDescription>
          </Field>
          <Field className="gap-2">
            <div className="flex items-center gap-1.5">
              <Label htmlFor={effortId}>Thinking effort</Label>
              <Tip label={EFFORT_HELP}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
                  aria-label="About thinking effort"
                >
                  <Icon name="info" size={14} />
                </Button>
              </Tip>
            </div>
            <NativeSelect
              id={effortId}
              className="w-full"
              value={thinkingLevel}
              disabled={busy}
              aria-describedby={effortHelpId}
              onChange={(e) => setThinkingLevel(e.target.value as ThinkingLevel)}
            >
              {efforts.map((level) => (
                <option key={level} value={level}>
                  {level === "off"
                    ? "Default"
                    : level === "xhigh"
                      ? "Extra high"
                      : level === "max"
                        ? "Maximum"
                        : level.charAt(0).toUpperCase() + level.slice(1)}
                </option>
              ))}
            </NativeSelect>
            <span id={effortHelpId} className="sr-only max-w-px">
              {EFFORT_HELP}
            </span>
          </Field>
          {error && <DialogError>{error}</DialogError>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" disabled={busy || !changed} aria-busy={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const activeSection = AGENT_SECTIONS.find((s) => s.id === section) ?? AGENT_SECTIONS[0]!;
  const closeBtn = (
    <Tip label="Close" shortcut="Esc">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="settings-close text-muted-foreground"
        aria-label="Close settings"
        disabled={busy}
        onClick={onClose}
      >
        <Icon name="close" />
      </Button>
    </Tip>
  );
  const navBtn =
    "row flex min-h-10 shrink-0 items-center gap-2.5 rounded-xl px-3 text-left text-sm text-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30 aria-[current=page]:bg-accent aria-[current=page]:font-medium";
  const footer = (
    <>
      {error && <DialogError>{error}</DialogError>}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" disabled={busy || !changed || nameBad} aria-busy={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </>
  );

  const sectionBody = (
    <PageShell title={activeSection.title} className="[&>.page-col]:gap-0 [&>.page-col>*+*]:border-t">
      {section === "general" && (
        <>
          <div className="settings-look flex items-center gap-3 py-5">
            <Avatar value={agent.avatar} size={44} />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => {
                changingLook.current = true;
                setOpen(false);
              }}
            >
              Change look…
            </Button>
          </div>
          <Field className="setting-row min-w-0 gap-2 py-5">
            <Label htmlFor={nameId} className="setting-label text-sm font-medium">
              Name
            </Label>
            <Input
              ref={nameInput}
              id={nameId}
              type="text"
              value={name}
              maxLength={AGENT_NAME_MAX_CHARS}
              autoComplete="off"
              disabled={busy}
              aria-invalid={nameBad || undefined}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {/* The field is here from the first paint, disabled until its text arrives: a surface that fetches must reserve
              the space it will fill, or the panel jumps as it grows. */}
          <Field className="setting-row min-w-0 gap-2 py-5">
            <Label htmlFor={instructionsId} className="setting-label text-sm font-medium">
              Instructions
            </Label>
            <Textarea
              id={instructionsId}
              value={instructions}
              rows={10}
              maxLength={saved?.maxLength}
              disabled={busy || saved === null}
              aria-describedby={`${instructionsId}-help`}
              onChange={(e) => setInstructions(e.target.value)}
            />
            <FieldDescription id={`${instructionsId}-help`}>
              What this agent is told about its role and how to work. Applies from its next reply in every chat; each
              change is kept below so you can restore an earlier version.
            </FieldDescription>
            {saved && saved.history.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  Earlier versions ({saved.history.length})
                </summary>
                <ul className="m-0 mt-2 grid list-none gap-2 p-0">
                  {saved.history.map((h) => (
                    <li key={`${h.at}-${h.text.length}`} className="flex items-start justify-between gap-3">
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        <span className="text-xs text-muted-foreground">
                          {new Date(h.at).toLocaleString()} · {h.author === "agent" ? "agent" : "you"}
                        </span>
                        <br />
                        {h.text.length > 160 ? `${h.text.slice(0, 160)}…` : h.text || "(empty)"}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => setInstructions(h.text)}
                      >
                        Restore
                      </Button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Field>
        </>
      )}
      {section === "tools" && (
        <>
          <SettingSwitchRow
            id={sandboxId}
            label="Sandbox"
            help={
              capabilities.sandbox
                ? "Allows bash commands and workspace file tools."
                : "Disables bash and workspace tools. Chat uploads accept text and image files only."
            }
            checked={capabilities.sandbox}
            disabled={busy}
            onCheckedChange={(sandbox) => setCapabilities((c) => ({ ...c, sandbox }))}
          />
          {capabilities.sandbox && (
            <SettingSelectRow
              id={networkId}
              label="Sandbox network"
              help={NETWORK_HELP[networkMode]}
              helpId={networkHelpId}
              value={networkMode}
              disabled={busy}
              options={SANDBOX_NETWORK_MODES}
              optionLabel={(m) => NETWORK_LABEL[m]}
              className="sm:pl-4"
              onChange={setNetworkMode}
            />
          )}
          <SettingSwitchRow
            id={webId}
            label="Web search & fetch"
            help="Allows searching the web and reading web pages."
            checked={capabilities.web}
            disabled={busy}
            onCheckedChange={(web) => setCapabilities((c) => ({ ...c, web }))}
          />
          <SettingSwitchRow
            id={browserId}
            label="Browser"
            help="Allows opening and interacting with sites in the built-in browser."
            checked={capabilities.browser}
            disabled={busy}
            onCheckedChange={(browser) => setCapabilities((c) => ({ ...c, browser }))}
          />
          <SettingSelectRow
            id={libraryId}
            label="File Library"
            help={LIBRARY_HELP[capabilities.library]}
            value={capabilities.library}
            disabled={busy}
            options={READ_WRITE_ACCESS}
            optionLabel={(v) => READ_WRITE_LABEL[v]}
            onChange={(library) => setCapabilities((c) => ({ ...c, library }))}
          />
          <SettingSwitchRow
            id={imagesId}
            label="Image generation"
            help="Allows generating and editing images when configured on the server."
            checked={capabilities.images}
            disabled={busy}
            onCheckedChange={(images) => setCapabilities((c) => ({ ...c, images }))}
          />
        </>
      )}
      {section === "context" && (
        <>
          <SettingSelectRow
            id={knowledgeId}
            label="Knowledge"
            help={KNOWLEDGE_HELP[capabilities.knowledge]}
            value={capabilities.knowledge}
            disabled={busy}
            options={READ_WRITE_ACCESS}
            optionLabel={(v) => READ_WRITE_LABEL[v]}
            onChange={(knowledge) => setCapabilities((c) => ({ ...c, knowledge }))}
          />
          {capabilities.knowledge !== "off" && (
            <SettingSelectRow
              id={knowledgeScopeId}
              label="Knowledge scope"
              help={
                allowedKnowledgePageIds === null
                  ? "Allows all Knowledge pages, including folders created in the future."
                  : "Restricts Knowledge tools, prompt context, and @page mentions to checked folders and their subpages."
              }
              value={allowedKnowledgePageIds === null ? "all" : "selected"}
              disabled={busy}
              options={["all", "selected"] as const}
              optionLabel={(v) => (v === "all" ? "All Knowledge" : "Selected folders")}
              className="sm:pl-4"
              onChange={(v) => setAllowedKnowledgePageIds(v === "all" ? null : [])}
            >
              {allowedKnowledgePageIds !== null && (
                <div className="pt-1 pb-5">
                  <KnowledgeFolderTree
                    tree={knowledgeTree}
                    loading={knowledgeTreeNodes === null && !knowledgeTreeError}
                    treeError={knowledgeTreeError}
                    selectedIds={allowedKnowledgePageIds}
                    busy={busy}
                    emptySelectionNote="No allowed folders selected — this agent cannot access any Knowledge pages."
                    onChange={setAllowedKnowledgePageIds}
                  />
                </div>
              )}
            </SettingSelectRow>
          )}
          <SettingSelectRow
            id={memoryId}
            label="Memory"
            help={MEMORY_HELP[capabilities.memory]}
            value={capabilities.memory}
            disabled={busy}
            options={READ_WRITE_ACCESS}
            optionLabel={(v) => READ_WRITE_LABEL[v]}
            onChange={(memory) => setCapabilities((c) => ({ ...c, memory }))}
          />
          <SettingSelectRow
            id={chatHistoryId}
            label="Chat history"
            help={CHAT_HISTORY_HELP[capabilities.chatHistory]}
            value={capabilities.chatHistory}
            disabled={busy}
            options={SCOPE_ACCESS}
            optionLabel={(v) => CHAT_HISTORY_LABEL[v]}
            onChange={(chatHistory) => setCapabilities((c) => ({ ...c, chatHistory }))}
          />
        </>
      )}
      {section === "automation" && (
        <>
          <SettingSelectRow
            id={triggersId}
            label="Triggers"
            help={TRIGGERS_HELP[capabilities.triggers]}
            value={capabilities.triggers}
            disabled={busy}
            options={SCOPE_ACCESS}
            optionLabel={(v) => TRIGGERS_LABEL[v]}
            onChange={(triggers) => setCapabilities((c) => ({ ...c, triggers }))}
          />
          <SettingSelectRow
            id={delegationId}
            label="Worker delegation"
            help={DELEGATION_HELP[capabilities.delegation]}
            value={capabilities.delegation}
            disabled={busy}
            options={SCOPE_ACCESS}
            optionLabel={(v) => DELEGATION_LABEL[v]}
            onChange={(delegation) => setCapabilities((c) => ({ ...c, delegation }))}
          />
        </>
      )}
      {section === "connectors" && (
        <SettingSelectRow
          id={connectorModeId}
          label="Usable connectors"
          help={
            allowedConnectorIds === null
              ? "Includes connectors added in the future."
              : "Only checked connectors can be used. Leave all unchecked to disable connectors."
          }
          value={allowedConnectorIds === null ? "all" : "selected"}
          disabled={busy}
          options={["all", "selected"] as const}
          optionLabel={(v) => (v === "all" ? "All connectors" : "Selected connectors")}
          onChange={(v) => setAllowedConnectorIds(v === "all" ? null : [])}
        >
          {allowedConnectorIds !== null && (
            <div className="flex max-h-72 flex-col gap-3 overflow-y-auto pt-1 pb-5">
              {connectorsFailed ? (
                <p role="alert" className="text-sm text-muted-foreground">
                  Could not load connectors. Reopen settings to retry.
                </p>
              ) : connectors === null ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading connectors…
                </p>
              ) : connectors.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No connectors configured. Add one in Settings → Capabilities → Connectors.
                </p>
              ) : (
                connectors.map((connector) => (
                  <Label key={connector.id} className="flex items-center gap-3 py-1">
                    <Checkbox
                      checked={allowedConnectorIds.includes(connector.id)}
                      disabled={busy}
                      onCheckedChange={(checked) =>
                        setAllowedConnectorIds((ids) =>
                          checked ? [...(ids ?? []), connector.id] : (ids ?? []).filter((id) => id !== connector.id),
                        )
                      }
                    />
                    <span className="min-w-0 break-words">{connector.name}</span>
                    {connector.status !== "connected" && (
                      <span className="text-xs text-muted-foreground">Unavailable</span>
                    )}
                  </Label>
                ))
              )}
            </div>
          )}
        </SettingSelectRow>
      )}
    </PageShell>
  );

  const handleCloseAutoFocus = () => {
    // Let this dialog restore its opener before the replacement picker captures it.
    if (changingLook.current) setTimeout(onChangeLook, 0);
  };
  const handleOpenAutoFocus = (e: Event) => {
    e.preventDefault();
    nameInput.current?.focus();
  };

  if (isWide) {
    return (
      <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
        <DialogContent
          size="xl"
          showCloseButton={false}
          aria-describedby={undefined}
          onCloseAutoFocus={handleCloseAutoFocus}
          onEscapeKeyDown={(e) => busy && e.preventDefault()}
          onOpenAutoFocus={handleOpenAutoFocus}
          className="agent-settings settings grid h-[min(46rem,88dvh)] grid-cols-[12rem_minmax(0,1fr)] gap-0 overflow-hidden overscroll-contain p-0 md:max-w-[min(60rem,92vw)]"
        >
          <nav
            className="settings-nav flex min-h-0 flex-col gap-5 overflow-y-auto overscroll-contain border-r bg-sidebar px-3 py-6"
            aria-label="Agent settings sections"
          >
            <DialogTitle className="truncate px-3 text-lg">{agent.name} settings</DialogTitle>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {AGENT_SECTIONS.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`${navBtn} w-full`}
                    aria-current={section === s.id ? "page" : undefined}
                    onClick={() => setSection(s.id)}
                  >
                    <Icon name={s.icon} size={18} />
                    <span className="row-title truncate">{s.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div className="flex min-h-0 min-w-0 flex-col">
            <div
              ref={bodyRef}
              className="settings-body min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-8 pt-10 [scrollbar-gutter:stable]"
            >
              {sectionBody}
            </div>
            <div className="flex shrink-0 flex-col gap-3 border-t bg-popover px-8 py-4">{footer}</div>
          </div>
          <div className="absolute top-3 right-3">{closeBtn}</div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Sheet open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        aria-modal="true"
        aria-describedby={undefined}
        onCloseAutoFocus={handleCloseAutoFocus}
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onOpenAutoFocus={handleOpenAutoFocus}
        className="agent-settings settings sheet inset-0 flex h-dvh w-full flex-col border-0 pt-[var(--safe-t)] data-[side=bottom]:h-dvh"
      >
        <header className="settings-head flex min-h-14 shrink-0 items-center gap-2 border-b px-3 py-2">
          <span className="w-8 shrink-0" aria-hidden="true" />
          <SheetTitle className="flex-1 truncate text-center">{agent.name} settings</SheetTitle>
          {closeBtn}
        </header>
        <nav
          className="settings-nav flex shrink-0 gap-1 overflow-x-auto overscroll-contain border-b bg-sidebar px-3 py-2"
          aria-label="Agent settings sections"
        >
          {AGENT_SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={navBtn}
              aria-current={section === s.id ? "page" : undefined}
              onClick={() => setSection(s.id)}
            >
              <Icon name={s.icon} size={16} />
              <span className="row-title whitespace-nowrap">{s.label}</span>
            </button>
          ))}
        </nav>
        <div
          ref={bodyRef}
          className="settings-body min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-6 pb-6"
        >
          {sectionBody}
        </div>
        <div className="flex shrink-0 flex-col gap-3 border-t bg-popover px-5 pt-3 pb-[calc(1rem+var(--safe-b))]">
          {footer}
        </div>
      </SheetContent>
    </Sheet>
  );
}
