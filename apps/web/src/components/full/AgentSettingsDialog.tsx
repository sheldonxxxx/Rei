import type { Agent, AgentInstructionsResponse, Connector, ModelsResponse, UpdateAgentRequest } from "@rei/protocol";
import {
  AGENT_NAME_MAX_CHARS,
  SANDBOX_NETWORK_MODES,
  type SandboxNetworkMode,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "@rei/protocol";
import { useEffect, useId, useRef, useState } from "react";
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
import { Field, FieldContent, FieldDescription, FieldLegend, FieldSet } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Label } from "@/components/primitives/label.tsx";
import { NativeSelect } from "@/components/primitives/native-select.tsx";
import { Switch } from "@/components/primitives/switch.tsx";
import { Textarea } from "@/components/primitives/textarea.tsx";
import type { Api } from "../../api/client.ts";
import { describeError } from "../../api/client.ts";
import { Avatar } from "../Avatar.tsx";
import { DialogError } from "../dialogParts.tsx";
import { Icon } from "../Icon.tsx";
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

interface Props {
  agent: Agent;
  mode?: "agent" | "model";
  api: Api;
  onClose: () => void;
  /** Open the look picker (closes this dialog first). */
  onChangeLook: () => void;
}

/** Agent identity settings, or the model/effort settings opened from the composer toolbar. */
export function AgentSettingsDialog({ agent, mode = "agent", api, onClose, onChangeLook }: Props) {
  const connectorModeId = useId();
  const [allowedConnectorIds, setAllowedConnectorIds] = useState<string[] | null>(agent.allowedConnectorIds ?? null);
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [connectorsFailed, setConnectorsFailed] = useState(false);
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
  const [canCreateTriggersForOtherAgents, setCanCreateTriggersForOtherAgents] = useState(
    agent.canCreateTriggersForOtherAgents ?? false,
  );
  const networkId = useId();
  const networkHelpId = useId();
  const triggerPermissionId = useId();
  const triggerPermissionHelpId = useId();
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
  if (mode === "agent" && networkMode !== agent.networkMode) patch.networkMode = networkMode;
  if (mode === "agent" && canCreateTriggersForOtherAgents !== (agent.canCreateTriggersForOtherAgents ?? false))
    patch.canCreateTriggersForOtherAgents = canCreateTriggersForOtherAgents;
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

  return (
    <>
      <Dialog open={open} onOpenChange={(open) => !open && !busy && onClose()}>
        <DialogContent
          size="lg"
          showCloseButton={false}
          aria-describedby={undefined}
          className="agent-settings min-w-0 [&>*]:min-w-0"
          onCloseAutoFocus={() => {
            // Let this dialog restore its opener before the replacement picker captures it.
            if (changingLook.current) setTimeout(onChangeLook, 0);
          }}
          onEscapeKeyDown={(e) => busy && e.preventDefault()}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (mode === "agent") nameInput.current?.focus();
            else document.getElementById(modelId)?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{mode === "model" ? "Model settings" : `${agent.name} settings`}</DialogTitle>
            {mode === "model" && (
              <DialogDescription>Applies to all chats with {agent.name}, from the next reply.</DialogDescription>
            )}
          </DialogHeader>
          {mode === "agent" && (
            <>
              <div className="settings-look flex items-center gap-3">
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
              <Field className="gap-2">
                <Label htmlFor={nameId}>Name</Label>
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
            </>
          )}
          {mode === "agent" && (
            <FieldSet className="gap-3">
              <FieldLegend>Connectors</FieldLegend>
              <Field className="gap-2">
                <Label htmlFor={connectorModeId}>Usable connectors</Label>
                <NativeSelect
                  id={connectorModeId}
                  value={allowedConnectorIds === null ? "all" : "selected"}
                  disabled={busy}
                  onChange={(e) => setAllowedConnectorIds(e.target.value === "all" ? null : [])}
                >
                  <option value="all">All connectors</option>
                  <option value="selected">Selected connectors</option>
                </NativeSelect>
                <FieldDescription>
                  {allowedConnectorIds === null
                    ? "Includes connectors added in the future."
                    : "Only checked connectors can be used. Leave all unchecked to disable connectors."}
                </FieldDescription>
              </Field>
              {allowedConnectorIds !== null && (
                <div className="flex max-h-48 flex-col gap-3 overflow-y-auto py-1">
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
                              checked
                                ? [...(ids ?? []), connector.id]
                                : (ids ?? []).filter((id) => id !== connector.id),
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
            </FieldSet>
          )}
          {mode === "agent" && (
            <Field orientation="horizontal" className="items-center justify-between gap-4">
              <FieldContent>
                <Label htmlFor={triggerPermissionId}>Create triggers for other agents</Label>
                <FieldDescription id={triggerPermissionHelpId}>
                  Let this agent set up scheduled or event-driven work for another agent to run.
                </FieldDescription>
              </FieldContent>
              <Switch
                id={triggerPermissionId}
                checked={canCreateTriggersForOtherAgents}
                disabled={busy}
                aria-describedby={triggerPermissionHelpId}
                onCheckedChange={setCanCreateTriggersForOtherAgents}
              />
            </Field>
          )}
          {mode === "agent" && (
            <Field className="gap-2">
              <Label htmlFor={networkId}>Sandbox network</Label>
              <NativeSelect
                id={networkId}
                className="w-full"
                value={networkMode}
                disabled={busy}
                aria-describedby={networkHelpId}
                onChange={(e) => setNetworkMode(e.target.value as SandboxNetworkMode)}
              >
                {SANDBOX_NETWORK_MODES.map((m) => (
                  <option key={m} value={m}>
                    {NETWORK_LABEL[m]}
                  </option>
                ))}
              </NativeSelect>
              <FieldDescription id={networkHelpId}>{NETWORK_HELP[networkMode]}</FieldDescription>
            </Field>
          )}
          {/* The field is here from the first paint, disabled until its text arrives: a surface that fetches must reserve
              the space it will fill, or the dialog re-centres itself as it grows and the open reads as a slide. */}
          {mode === "agent" && (
            <Field className="gap-2">
              <Label htmlFor={instructionsId}>Instructions</Label>
              <Textarea
                id={instructionsId}
                value={instructions}
                rows={8}
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
          )}
          {mode === "model" && (
            <>
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
            </>
          )}
          {error && <DialogError>{error}</DialogError>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" disabled={busy || !changed || nameBad} aria-busy={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
