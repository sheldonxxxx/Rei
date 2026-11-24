import type { Agent, SkillSummary } from "@rei/protocol";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Empty, EmptyDescription } from "@/components/primitives/empty.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Item } from "@/components/primitives/item.tsx";
import { Textarea } from "@/components/primitives/textarea.tsx";
import type { Api } from "../api/client.ts";
import { describeSetupError } from "../api/client.ts";
import { agentsLine } from "../lib/agents-line.ts";
import { navigate, SKILLS_PATH, skillHref } from "../lib/route.ts";
import { importRequestFor } from "../lib/skills.ts";
import { ago } from "../lib/time.ts";
import { useNow } from "../lib/useNow.ts";
import { Icon } from "./Icon.tsx";
import { PageShell } from "./PageShell.tsx";
import { SkillDetail } from "./SkillDetail.tsx";

type SkillsApi = Pick<Api, "getSkills" | "importSkill">;

interface Props {
  api: Api;
  agents: Agent[];
  /** The open skill; null shows the list. */
  id: string | null;
  /** From the global stream: rises when a skill changed. */
  rev: number;
}

/** Settings → Capabilities → Skills: every skill, standalone or from a plugin. Create one, import one, or open one. */
export function SkillsPage({ api, agents, id, rev }: Props) {
  if (id)
    return (
      <SkillDetail
        key={id}
        api={api}
        agents={agents}
        id={id}
        rev={rev}
        onBack={() => navigate(SKILLS_PATH)}
        onDeleted={() => navigate(SKILLS_PATH)}
      />
    );
  return <SkillList api={api} agents={agents} rev={rev} />;
}

/** The SKILL.md a new skill starts from. The description is quoted so any text is valid YAML. */
export const newSkillMd = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description.trim())}\n---\n\n${body.trim()}\n`;

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function NewSkill({ api, onCancel }: { api: SkillsApi; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameOk = NAME.test(name);
  const ready = nameOk && description.trim() !== "" && body.trim() !== "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const { skill } = await api.importSkill({
        files: [{ path: "SKILL.md", encoding: "text", content: newSkillMd(name, description, body) }],
      });
      navigate(skillHref(skill.id));
    } catch (err) {
      setError(describeSetupError(err));
      setBusy(false);
    }
  }

  return (
    <form
      className="flex min-w-0 flex-col gap-4 rounded-2xl border p-4"
      aria-label="New skill"
      onSubmit={(e) => void submit(e)}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="new-skill-name">Name</FieldLabel>
          <Input
            id="new-skill-name"
            value={name}
            placeholder="weekly-review"
            autoComplete="off"
            aria-invalid={name !== "" && !nameOk}
            onChange={(e) => setName(e.target.value)}
          />
          <FieldDescription>Lowercase letters, numbers and single hyphens.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="new-skill-description">Description</FieldLabel>
          <Input
            id="new-skill-description"
            value={description}
            placeholder="What it does and when to use it"
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="new-skill-body">Instructions</FieldLabel>
          <Textarea id="new-skill-body" rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
      </FieldGroup>
      {error && (
        <p role="alert" className="m-0 text-sm text-destructive [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!ready || busy}>
          {busy ? "Creating…" : "Create skill"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function SkillList({ api, agents, rev }: { api: SkillsApi; agents: Agent[]; rev: number }) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const now = useNow();

  const load = useCallback(() => {
    api.getSkills().then(
      (r) => {
        setSkills(r.skills);
        setError(null);
      },
      (e) => setError(describeSetupError(e)),
    );
  }, [api]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refetch when the stream says a skill changed; rev is the signal, not an input.
  useEffect(() => {
    load();
  }, [load, rev]);

  async function onPick(file: File | undefined) {
    if (picker.current) picker.current.value = ""; // the same file can be picked again
    if (!file) return;
    setImporting(true);
    setImportError(null);
    try {
      const { skill } = await api.importSkill(await importRequestFor(file));
      load();
      navigate(skillHref(skill.id));
    } catch (e) {
      setImportError(describeSetupError(e));
    } finally {
      setImporting(false);
    }
  }

  return (
    <PageShell
      title="Skills"
      className="skills-page"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <label className="file-btn cursor-pointer" aria-disabled={importing}>
              <Icon name="upload" size={16} />
              {importing ? "Importing…" : "Import a skill"}
              <input
                ref={picker}
                className="sr-only"
                type="file"
                accept=".zip,.md,application/zip,text/markdown"
                disabled={importing}
                onChange={(e) => void onPick(e.target.files?.[0])}
              />
            </label>
          </Button>
          <Button size="sm" type="button" onClick={() => setCreating(true)} disabled={creating}>
            New skill
          </Button>
        </div>
      }
    >
      <p className="m-0 text-sm text-muted-foreground">
        Instructions an assistant reads before a task. A skill you add here stands on its own; a plugin's skills are
        named <code>plugin/skill</code>.
      </p>
      {creating && <NewSkill api={api} onCancel={() => setCreating(false)} />}
      {importError && (
        <p
          role="alert"
          className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
        >
          {importError}
        </p>
      )}
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
      {!skills && !error && <span className="spinner" role="status" aria-label="Loading" />}
      {skills && skills.length === 0 && (
        <Empty className="page-empty border px-5 py-8">
          <EmptyDescription>No skills yet.</EmptyDescription>
        </Empty>
      )}
      {skills && skills.length > 0 && (
        <ul className="cfg-list m-0 flex min-w-0 list-none flex-col gap-2 p-0" aria-label="Skills">
          {skills.map((s) => (
            <li key={s.id}>
              <Item asChild variant="outline">
                <a
                  className="cfg-item relative flex min-w-0 flex-col items-stretch gap-1.5 rounded-2xl px-4 py-3 text-foreground no-underline [overflow-wrap:anywhere] [&:is(a)]:pr-10 [&:is(a)]:hover:bg-muted"
                  href={skillHref(s.id)}
                >
                  <span className="cfg-item-top flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span className="cfg-item-name inline-flex min-w-0 flex-[1_1_8rem] items-center gap-2 text-sm font-medium [overflow-wrap:anywhere]">
                      {s.name}
                    </span>
                    {s.builtIn ? (
                      <Badge>Built-in</Badge>
                    ) : (
                      <Badge variant="secondary">{s.plugin ? `Plugin: ${s.plugin.name}` : "Standalone"}</Badge>
                    )}
                    <Badge>v{s.version}</Badge>
                    {s.plugin && !s.plugin.enabled && <Badge variant="outline">Plugin disabled</Badge>}
                  </span>
                  <span className="cfg-item-line text-sm text-muted-foreground [overflow-wrap:anywhere] clamp line-clamp-2">
                    {s.description}
                  </span>
                  <span className="cfg-item-meta flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere] [&_[data-tone=bad]]:text-destructive">
                    {s.builtIn ? (
                      <span>Included with Rei · Read-only</span>
                    ) : (
                      <>
                        <span>{agentsLine(s.agents, agents)}</span>
                        <span>Updated {ago(s.updatedAt, now)}</span>
                        <span>{s.author === "agent" ? "Saved by an assistant" : "Edited by you"}</span>
                      </>
                    )}
                  </span>
                  <span
                    className="cfg-item-action absolute top-1/2 right-3 inline-grid -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  >
                    <Icon name="forward" size={16} />
                  </span>
                </a>
              </Item>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}
