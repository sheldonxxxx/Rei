import type { Agent, Grant, ProfileName, Session } from "@rei/protocol";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Field, FieldContent, FieldDescription } from "@/components/primitives/field.tsx";
import { Label } from "@/components/primitives/label.tsx";
import { NativeSelect } from "@/components/primitives/native-select.tsx";
import type { Api } from "../api/client.ts";
import { ApiError, describeError } from "../api/client.ts";
import { mcpTarget, useConnectorNames } from "../lib/connectors.tsx";
import { PROFILE_HELP, PROFILE_LABEL, PROFILES } from "../lib/policy.ts";
import { formatWhen } from "../lib/time.ts";
import { Icon } from "./Icon.tsx";
import { PageShell } from "./PageShell.tsx";
import { SandboxNetworkSettings } from "./SandboxNetworkSettings.tsx";

interface Props {
  api: Api;
  agents: Agent[];
  sessions: Session[];
}

/** How long a grant lasts, in words. */
export function describeGrant(g: Grant, agents: Agent[], sessions: Session[], now: number = Date.now()): string {
  switch (g.length) {
    case "always":
      return "Always";
    case "web_session":
    case "session": {
      const s = sessions.find((x) => x.id === g.sessionId);
      if (g.length === "web_session") return s ? `All web in “${s.title}”` : "All web in one chat";
      return s ? `For the chat “${s.title}”` : "For one chat";
    }
    case "agent": {
      const a = agents.find((x) => x.id === g.agentId);
      return a ? `For the agent ${a.name}` : "For one agent";
    }
    case "hours":
      return g.expiresAt ? `Until ${formatWhen(g.expiresAt, now)}` : "For a set time";
  }
}

/** Settings > Permissions: what you've allowed agents to do without asking each time. */
export function PermissionsPage({ api, agents, sessions }: Props) {
  const [sessionDetails, setSessionDetails] = useState<Session[]>([]);
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.listGrants().then(
      (r) => setGrants(r.grants),
      (e) => setError(describeError(e)),
    );
  }, [api]);
  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    const ids = [
      ...new Set(
        (grants ?? []).flatMap((g) =>
          g.sessionId && !sessions.some((s) => s.id === g.sessionId) ? [g.sessionId] : [],
        ),
      ),
    ];
    if (ids.length)
      void Promise.all(
        ids.map((id) =>
          api.getSessionSummary(id).then(
            (r) => r.session,
            () => null,
          ),
        ),
      ).then((details) => {
        if (!cancelled) setSessionDetails(details.filter((s): s is Session => s !== null));
      });
    return () => {
      cancelled = true;
    };
  }, [api, grants, sessions]);

  return (
    <PageShell title="Permissions">
      <section className="grid gap-4 rounded-xl border p-4" aria-labelledby="perm-new-chats">
        <h2 id="perm-new-chats" className="m-0 text-sm font-medium">
          New chats
        </h2>
        <ul className="m-0 list-none p-0">
          {agents.map((a) => (
            <DefaultProfileRow key={a.id} api={api} agent={a} showName={agents.length > 1} />
          ))}
        </ul>
      </section>
      <section className="grid gap-4 rounded-xl border p-4" aria-labelledby="perm-sandbox">
        <h2 id="perm-sandbox" className="m-0 text-sm font-medium">
          Sandbox network
        </h2>
        <SandboxNetworkSettings api={api} />
      </section>
      <section className="grid gap-4 rounded-xl border p-4" aria-labelledby="perm-grants">
        <h2 id="perm-grants" className="m-0 text-sm font-medium">
          Allowed in advance
        </h2>
        {error && (
          <div
            role="alert"
            className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
          >
            <span>{error}</span>
            <Button variant="ghost" size="sm" type="button" onClick={load}>
              Try again
            </Button>
          </div>
        )}
        {!grants && !error && <span className="spinner" role="status" aria-label="Loading" />}
        {grants && grants.length === 0 && (
          <p className="m-0 text-sm text-muted-foreground">Nothing allowed in advance.</p>
        )}
        {grants && grants.length > 0 && (
          <ul className="grant-list m-0 flex list-none flex-col divide-y p-0" aria-label="Grants in force">
            {grants.map((g) => (
              <GrantRow
                key={g.id}
                grant={g}
                description={describeGrant(g, agents, [...sessions, ...sessionDetails])}
                onRevoke={async () => {
                  try {
                    await api.revokeGrant(g.id);
                  } catch (e) {
                    if (!(e instanceof ApiError && e.code === "not_found")) throw e; // already gone: same result
                  }
                  setGrants((list) => (list ? list.filter((x) => x.id !== g.id) : list));
                }}
              />
            ))}
          </ul>
        )}
      </section>
    </PageShell>
  );
}

function GrantRow({
  grant,
  description,
  onRevoke,
}: {
  grant: Grant;
  description: string;
  onRevoke: () => Promise<void>;
}) {
  const names = useConnectorNames();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mcp = grant.connector === "mcp" ? mcpTarget(grant.destination, names) : null;
  const name = mcp ? `${mcp.app} · ${mcp.tool}` : `${grant.connector} · ${grant.operation}`;

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      await onRevoke();
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  return (
    <li className="grant flex flex-wrap items-center justify-between gap-4 py-4">
      <div className="grant-main min-w-0 flex-1">
        <p className="grant-name m-0 text-sm font-medium [overflow-wrap:anywhere]">{name}</p>
        <p className="grant-meta mt-1 mb-0 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {!mcp && <span>{grant.destination ?? "Any destination"}</span>}
          <span>{description}</span>
          <span>Allowed {formatWhen(grant.createdAt)}</span>
        </p>
        {error && (
          <p
            role="alert"
            className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
          >
            {error}
          </p>
        )}
      </div>
      <div className="grant-actions flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <span className="grant-confirm text-sm font-medium text-destructive">Revoke?</span>
            <Button
              variant="destructive"
              size="sm"
              type="button"
              disabled={busy}
              aria-label={`Yes, revoke ${name}`}
              onClick={() => void revoke()}
            >
              {busy ? "Revoking…" : "Yes, revoke"}
            </Button>
            <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            size="sm"
            type="button"
            aria-label={`Revoke ${name}`}
            onClick={() => setConfirming(true)}
          >
            Revoke
          </Button>
        )}
      </div>
    </li>
  );
}

/** Which permission level an agent's new chats start at. Saved as soon as it is picked; open chats keep theirs. */
function DefaultProfileRow({ api, agent, showName }: { api: Api; agent: Agent; showName: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `default-profile-${agent.id}`;
  async function pick(p: ProfileName) {
    if (p === agent.defaultProfile) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(agent.id, { defaultProfile: p });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <li>
      <Field
        orientation="horizontal"
        className="setting-row max-sm:flex-col max-sm:items-stretch min-w-0 justify-between gap-5 py-5 [&+[data-slot=field]]:border-t"
      >
        <FieldContent className="setting-text min-w-0">
          <Label className="setting-label text-sm font-medium" htmlFor={id}>
            {showName ? `${agent.name}: start new chats at` : "Start new chats at"}
          </Label>
          <FieldDescription className="setting-help m-0 max-w-xl text-sm text-muted-foreground">
            {PROFILE_HELP[agent.defaultProfile]} Chats already open keep their own level.
          </FieldDescription>
        </FieldContent>
        <NativeSelect
          id={id}
          className="setting-select min-w-0 max-w-full shrink-0 max-sm:w-full"
          value={agent.defaultProfile}
          disabled={busy}
          onChange={(e) => void pick(e.target.value as ProfileName)}
        >
          {PROFILES.map((p) => (
            <option key={p} value={p}>
              {PROFILE_LABEL[p]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {agent.defaultProfile === "yolo" && (
        <p className="approval-warn strong yolo-warn rounded-2xl bg-attention-soft px-3 py-2.5 text-attention-text">
          <Icon name="alert" size={16} />
          <span>
            YOLO skips most approvals. Content the agent reads on the web could talk it into things you wouldn't choose.
          </span>
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
    </li>
  );
}
