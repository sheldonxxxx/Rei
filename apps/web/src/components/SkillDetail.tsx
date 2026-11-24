import type { Agent, SkillFile, SkillResponse } from "@rei/protocol";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Empty, EmptyDescription } from "@/components/primitives/empty.tsx";
import { Item } from "@/components/primitives/item.tsx";
import { Textarea } from "@/components/primitives/textarea.tsx";
import type { Api } from "../api/client.ts";
import { ApiError, describeSetupError } from "../api/client.ts";
import { pluginHref, sessionHref } from "../lib/route.ts";
import { skillExportHref, skillMdOf, splitSkillMd } from "../lib/skills.ts";
import { formatWhen } from "../lib/time.ts";
import { ConfirmDialog } from "./dialogParts.tsx";
import { Icon } from "./Icon.tsx";
import { InfoTip } from "./InfoTip.tsx";
import { Markdown } from "./Markdown.tsx";
import { PageShell } from "./PageShell.tsx";

interface Props {
  api: Api;
  agents: Agent[];
  id: string;
  rev: number;
  onBack: () => void;
  onDeleted: () => void;
}

/** One skill: its SKILL.md and files, its versions (with Restore), editing, export and delete. */
export function SkillDetail({ api, agents, id, rev, onBack, onDeleted }: Props) {
  const [data, setData] = useState<SkillResponse | null>(null);
  // The version being looked at; null is the current one.
  const [viewing, setViewing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(() => {
    api.getSkill(id, viewing ?? undefined).then(
      (r) => {
        setData(r);
        setError(null);
      },
      (e) => {
        if (e instanceof ApiError && e.code === "not_found") setMissing(true);
        else setError(describeSetupError(e));
      },
    );
  }, [api, id, viewing]);
  useEffect(() => {
    load();
  }, [load, rev]);

  async function restore(version: number) {
    setBusy(true);
    setError(null);
    try {
      await api.updateSkill(id, { restore: version });
      setViewing(null);
      load();
    } catch (e) {
      setError(describeSetupError(e));
    } finally {
      setBusy(false);
    }
  }

  const back = { onBack, backLabel: "Back to Skills" };
  if (missing) {
    return (
      <PageShell title="Skill" {...back}>
        <Empty className="page-empty border px-5 py-8">
          <EmptyDescription>This skill no longer exists.</EmptyDescription>
        </Empty>
      </PageShell>
    );
  }
  if (!data) {
    return (
      <PageShell title="Skill" {...back}>
        {error ? (
          <div
            role="alert"
            className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
          >
            <span>{error}</span>
            <Button variant="ghost" size="sm" type="button" onClick={load}>
              Try again
            </Button>
          </div>
        ) : (
          <span className="spinner" role="status" aria-label="Loading" />
        )}
      </PageShell>
    );
  }

  const { skill } = data;
  const current = data.version === skill.version;
  const skillMd = skillMdOf(data.files);
  const others = data.files.filter((f) => f.path !== "SKILL.md");
  return (
    <PageShell title={skill.name} {...back} className="skill-page">
      <p className="cfg-desc m-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">{skill.description}</p>
      {skill.builtIn ? (
        <Badge variant="secondary">Built-in · Read-only</Badge>
      ) : (
        <p className="m-0 text-sm text-muted-foreground">
          {skill.plugin ? (
            <>
              Part of the plugin <a href={pluginHref(skill.plugin.id)}>{skill.plugin.name}</a>
              {skill.plugin.enabled ? "" : " (disabled)"}
            </>
          ) : (
            "Standalone: no plugin owns it"
          )}
        </p>
      )}
      <div className="cfg-actions flex flex-wrap items-center gap-2">
        {current && !editing && !skill.builtIn && (
          <Button variant="outline" size="sm" type="button" onClick={() => setEditing(true)}>
            <Icon name="edit" size={16} />
            Edit
          </Button>
        )}
        <Button asChild variant="outline" size="sm">
          <a href={skillExportHref(skill.id, current ? undefined : data.version)} download={`${skill.name}.zip`}>
            <Icon name="down" size={16} />
            Export
          </a>
        </Button>
        {!skill.builtIn && (
          <Button
            variant="destructive"
            size="sm"
            type="button"
            className="danger-text text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            <Icon name="trash" size={16} />
            Delete
          </Button>
        )}
      </div>
      {error && (
        <p
          role="alert"
          className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
      {!current && (
        <p className="cfg-banner m-0 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-attention-border bg-attention-soft px-3 py-2.5 text-sm">
          <span>
            Showing version {data.version}. The current one is version {skill.version}.
          </span>
          <Button variant="ghost" size="sm" type="button" onClick={() => setViewing(null)}>
            Back to current
          </Button>
        </p>
      )}

      <section className="cfg-section flex min-w-0 flex-col gap-3 border-t pt-5" aria-labelledby="skill-md-h">
        <h4 id="skill-md-h" className="memory-h m-0 flex items-center gap-2 text-base font-semibold tracking-tight">
          SKILL.md
          <Badge>v{data.version}</Badge>
        </h4>
        {editing && skillMd ? (
          <SkillEditor
            api={api}
            id={skill.id}
            files={data.files}
            skillMd={skillMd.content}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              load();
            }}
          />
        ) : skillMd ? (
          <SkillMdView text={skillMd.content} />
        ) : (
          <Empty className="page-empty border px-5 py-8">
            <EmptyDescription>This version has no SKILL.md.</EmptyDescription>
          </Empty>
        )}
      </section>

      {others.length > 0 && (
        <section className="cfg-section flex min-w-0 flex-col gap-3 border-t pt-5" aria-labelledby="skill-files-h">
          <h4
            id="skill-files-h"
            className="memory-h m-0 flex items-center gap-2 text-base font-semibold tracking-tight"
          >
            Other files
          </h4>
          <ul className="cfg-list m-0 flex min-w-0 list-none flex-col gap-2 p-0" aria-label="Files">
            {others.map((f) => (
              <FileRow key={f.path} file={f} />
            ))}
          </ul>
        </section>
      )}

      {agents.length > 1 && current && !skill.builtIn && (
        <AgentAllow api={api} agents={agents} skillId={skill.id} agentIds={skill.agents} onSaved={load} />
      )}

      <section className="cfg-section flex min-w-0 flex-col gap-3 border-t pt-5" aria-labelledby="skill-versions-h">
        <h4
          id="skill-versions-h"
          className="memory-h m-0 flex items-center gap-2 text-base font-semibold tracking-tight"
        >
          Versions
        </h4>
        <ul className="cfg-list m-0 flex min-w-0 list-none flex-col gap-2 p-0" aria-label="Versions">
          {data.versions.map((v) => (
            <Item key={v.version} asChild variant="outline">
              <li className="cfg-item relative flex min-w-0 flex-col items-stretch gap-1.5 rounded-2xl px-4 py-3 text-foreground no-underline [overflow-wrap:anywhere] [&:is(a)]:pr-10 [&:is(a)]:hover:bg-muted version-item">
                <span className="cfg-item-top flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                  <span className="cfg-item-name inline-flex min-w-0 flex-[1_1_8rem] items-center gap-2 text-sm font-medium [overflow-wrap:anywhere]">
                    Version {v.version}
                    {v.version === skill.version && <Badge>Current</Badge>}
                  </span>
                  {!skill.builtIn && (
                    <time
                      className="cfg-item-when text-xs whitespace-nowrap text-muted-foreground"
                      dateTime={new Date(v.createdAt).toISOString()}
                    >
                      {formatWhen(v.createdAt)}
                    </time>
                  )}
                </span>
                <span className="cfg-item-meta flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere] [&_[data-tone=bad]]:text-destructive">
                  <span>
                    {skill.builtIn ? "Included with Rei" : v.author === "agent" ? "By an assistant" : "By you"}
                  </span>
                  {v.note && <span>{v.note}</span>}
                  {v.sessionId && <a href={sessionHref(v.sessionId)}>Open chat</a>}
                </span>
                <span className="cfg-item-buttons mt-1 flex flex-wrap gap-2">
                  {v.version !== data.version && (
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      aria-label={`View version ${v.version}`}
                      onClick={() => setViewing(v.version === skill.version ? null : v.version)}
                    >
                      View
                    </Button>
                  )}
                  {v.version !== skill.version && !skill.builtIn && (
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      aria-label={`Restore version ${v.version}`}
                      disabled={busy}
                      onClick={() => void restore(v.version)}
                    >
                      <Icon name="undo" size={16} />
                      Restore
                    </Button>
                  )}
                </span>
              </li>
            </Item>
          ))}
        </ul>
      </section>

      {confirmDelete && (
        <DeleteSkillDialog
          api={api}
          name={skill.name}
          id={skill.id}
          onCancel={() => setConfirmDelete(false)}
          onDeleted={onDeleted}
        />
      )}
    </PageShell>
  );
}

/** SKILL.md with its frontmatter as a small table and the instructions rendered as markdown. */
export function SkillMdView({ text }: { text: string }) {
  const { fields, body } = splitSkillMd(text);
  // The name and description are already shown next to the SKILL.md; only the other keys are new.
  const extra = fields.filter(([k]) => k !== "name" && k !== "description");
  return (
    <div className="skill-md flex min-w-0 flex-col gap-3">
      {extra.length > 0 && (
        <dl className="facts skill-front rounded-2xl border bg-muted/40 px-3 py-2.5">
          {extra.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <Markdown text={body} />
    </div>
  );
}

function FileRow({ file }: { file: SkillFile }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <Item asChild variant="outline">
      <li className="cfg-item relative flex min-w-0 flex-col items-stretch gap-1.5 rounded-2xl px-4 py-3 text-foreground no-underline [overflow-wrap:anywhere] [&:is(a)]:pr-10 [&:is(a)]:hover:bg-muted file-item">
        <span className="cfg-item-top flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="cfg-item-name inline-flex min-w-0 flex-[1_1_8rem] items-center gap-2 text-sm font-medium [overflow-wrap:anywhere] mono">
            {file.path}
          </span>
          <Button
            variant="ghost"
            type="button"
            aria-expanded={open}
            aria-controls={panel}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Hide" : "View"}
          </Button>
        </span>
        {open && (
          <div id={panel} className="long-text mono">
            {file.encoding === "text" ? (
              <pre>{file.content}</pre>
            ) : (
              <p className="cfg-hint m-0 text-xs text-muted-foreground">A binary file; it can't be shown here.</p>
            )}
          </div>
        )}
      </li>
    </Item>
  );
}

function SkillEditor({
  api,
  id,
  files,
  skillMd,
  onCancel,
  onSaved,
}: {
  api: Api;
  id: string;
  files: SkillFile[];
  skillMd: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(skillMd);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();
  useEffect(() => area.current?.focus(), []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const next: SkillFile[] = files.map((f) =>
        f.path === "SKILL.md" ? { ...f, encoding: "text", content: text } : f,
      );
      await api.updateSkill(id, { files: next });
      onSaved();
    } catch (e) {
      setError(describeSetupError(e));
      setBusy(false);
    }
  }

  return (
    <form
      className="cfg-form flex min-w-0 flex-col gap-5 border-t pt-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (text !== skillMd && !busy) void save();
      }}
    >
      <label htmlFor={fieldId} className="sr-only">
        SKILL.md
      </label>
      <Textarea
        id={fieldId}
        ref={area}
        className="skill-textarea min-h-64 w-full resize-y font-mono text-xs leading-relaxed"
        rows={18}
        spellCheck={false}
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
      />
      <InfoTip label="About editing skills">
        The name can't change here. Saving makes a new version; the old one stays in the list.
      </InfoTip>
      {error && (
        <p
          role="alert"
          className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
      <div className="cfg-save flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        <Button variant="outline" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="default" type="submit" disabled={busy || text === skillMd} aria-busy={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

/** Which agents see the skill: all, or only the ones ticked. Shown only when there is more than one agent. */
function AgentAllow({
  api,
  agents,
  skillId,
  agentIds,
  onSaved,
}: {
  api: Api;
  agents: Agent[];
  skillId: string;
  agentIds: string[] | null;
  onSaved: () => void;
}) {
  const [only, setOnly] = useState(agentIds !== null);
  const [picked, setPicked] = useState<string[]>(agentIds ?? agents.map((a) => a.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = useId();
  const changed =
    only !== (agentIds !== null) || (only && [...picked].sort().join() !== [...(agentIds ?? [])].sort().join());

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.updateSkill(skillId, { agents: only ? picked : null });
      onSaved();
    } catch (e) {
      setError(describeSetupError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset
      className="cfg-group m-0 flex min-w-0 flex-col gap-3 border-0 p-0 [&_legend]:mb-3 [&_legend]:p-0 [&_legend]:text-sm [&_legend]:font-medium"
      disabled={busy}
    >
      <legend>Who can use it</legend>
      <label className="choice flex min-h-9 cursor-pointer items-center gap-2.5 text-sm [&_input]:size-4 [&_input]:shrink-0 [&_input]:accent-primary">
        <input type="radio" name={name} checked={!only} onChange={() => setOnly(false)} />
        <span>Every agent</span>
      </label>
      <label className="choice flex min-h-9 cursor-pointer items-center gap-2.5 text-sm [&_input]:size-4 [&_input]:shrink-0 [&_input]:accent-primary">
        <input type="radio" name={name} checked={only} onChange={() => setOnly(true)} />
        <span>Only some agents</span>
      </label>
      {only &&
        agents.map((a) => (
          <label
            key={a.id}
            className="choice flex min-h-9 cursor-pointer items-center gap-2.5 text-sm [&_input]:size-4 [&_input]:shrink-0 [&_input]:accent-primary cfg-indent ml-7"
          >
            <input
              type="checkbox"
              checked={picked.includes(a.id)}
              onChange={() => setPicked((p) => (p.includes(a.id) ? p.filter((x) => x !== a.id) : [...p, a.id]))}
            />
            <span>{a.name}</span>
          </label>
        ))}
      {error && (
        <p
          role="alert"
          className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
      <div>
        <Button variant="outline" size="sm" type="button" disabled={!changed || busy} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </fieldset>
  );
}

function DeleteSkillDialog({
  api,
  id,
  name,
  onCancel,
  onDeleted,
}: {
  api: Api;
  id: string;
  name: string;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteSkill(id);
      onDeleted();
    } catch (e) {
      if (e instanceof ApiError && e.code === "not_found") onDeleted();
      else {
        setError(describeSetupError(e));
        setBusy(false);
      }
    }
  }

  return (
    <ConfirmDialog
      title="Delete this skill?"
      description={
        <p>
          “{name}” and all its versions will be removed. Triggers that use it will fail until you change them. This
          can't be undone.
        </p>
      }
      error={error}
      busy={busy}
      confirmLabel="Delete"
      busyLabel="Deleting…"
      onCancel={onCancel}
      onConfirm={() => void confirm()}
    />
  );
}
