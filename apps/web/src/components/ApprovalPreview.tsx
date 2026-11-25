import type { Approval, SkillPreview, TriggerPreview } from "@rei/protocol";
import { useId, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { cn } from "@/lib/utils.ts";
import { CLASS_LABEL, PROFILE_LABEL } from "../lib/policy.ts";
import { CATCH_UP_LABEL, formatNextRun, LANDING_LABEL, OVERLAP_LABEL, REPORT_LABEL } from "../lib/triggers.ts";
import { FACTS } from "./approvalStyles.ts";
import { SkillMdView } from "./SkillDetail.tsx";

const PREVIEW_FACTS = cn(FACTS, "preview-facts");
const LIST = "m-0 flex list-none flex-col gap-0.5 p-0";

/** What a "Set up" card is about to set up, drawn from structured fields only (all plain text). */
export function ApprovalPreview({ preview }: { preview: NonNullable<Approval["preview"]> }) {
  if (preview.kind === "plugin")
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <dl className={PREVIEW_FACTS}>
          <Row label="Plugin" value={preview.name} />
          <Row label="Change" value={preview.op === "create" ? "Create" : `Update revision ${preview.fromRevision}`} />
          <Row label="Skills" value={preview.package.skills.map((s) => s.name).join(", ") || "None"} />
          {preview.package.mcp.map((c) => (
            <Row key={c.name} label={c.name} value={`${c.url} (${c.auth}); skills: ${c.skills.join(", ") || "none"}`} />
          ))}
        </dl>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-xl border p-3 text-xs">
          {preview.diff || JSON.stringify(preview.package, null, 2)}
        </pre>
      </div>
    );
  if (preview.kind === "mcp-provider")
    return (
      <div>
        <dl className={PREVIEW_FACTS} aria-label="MCP provider">
          <Row label="Provider" value={preview.connectorName} />
          <Row label="Provider URL" value={preview.url} />
          <Row label="Tool" value={preview.tool} />
          <Row
            label="Claimed effect"
            value={
              preview.claimedReadOnly
                ? "Read-only (provider claim; destructive hints take precedence)"
                : "Not declared read-only"
            }
          />
          {preview.actionClass && <Row label="Effective effect" value={CLASS_LABEL[preview.actionClass]} />}
          <Row
            label="MCP profile"
            value={
              preview.mcpProfile === "read_only"
                ? "Read-only: other actions require approval"
                : preview.mcpProfile === "read_write"
                  ? "Read and write: sends and irreversible actions require approval"
                  : preview.mcpProfile === "yolo"
                    ? "YOLO"
                    : "Always Ask"
            }
          />
        </dl>
      </div>
    );
  return preview.kind === "trigger" ? <TriggerCard preview={preview} /> : <SkillCard preview={preview} />;
}

type Shown = Omit<TriggerPreview, "kind" | "op" | "before">;

const actionLine = (a: TriggerPreview["action"]): string =>
  a.kind === "notify"
    ? `Post the message: ${a.message}`
    : a.kind === "prompt"
      ? `Run this prompt: ${a.prompt}`
      : `Run the skill “${a.skill}”${a.args ? ` with: ${a.args}` : ""}`;

function Row({ label, value, before }: { label: string; value: string; before?: string | undefined }) {
  const changed = before !== undefined && before !== value;
  return (
    <div>
      <dt>{label}</dt>
      <dd className="preview-value flex flex-col">
        {changed && <del className="preview-before text-muted-foreground decoration-1">{before}</del>}
        <span>{value}</span>
      </dd>
    </div>
  );
}

/** A trigger's level on its card; YOLO says what it means, since its runs then act without asking. */
const levelLine = (profile: TriggerPreview["profile"]): string =>
  profile === "yolo" ? "YOLO: built-in actions run without asking" : PROFILE_LABEL[profile];

function TriggerCard({ preview: p }: { preview: TriggerPreview }) {
  const b: Shown | undefined = p.before;
  const kind = p.action.kind;
  if (p.op === "delete") {
    return (
      <dl className={PREVIEW_FACTS} aria-label="Trigger to delete">
        <Row label="Trigger" value={p.name} />
        <Row label="Starts" value={p.startText} />
        <Row label="Agent" value={p.agentName} />
      </dl>
    );
  }
  return (
    <dl className={PREVIEW_FACTS} aria-label="Trigger">
      <Row label="Name" value={p.name} before={b?.name} />
      <Row label="Agent" value={p.agentName} />
      <Row label="Starts" value={p.startText} before={b?.startText} />
      <div>
        <dt>Next runs</dt>
        <dd>
          {p.nextRuns.length === 0 ? (
            "None coming up"
          ) : (
            <ul className={cn("preview-runs", LIST)}>
              {p.nextRuns.map((t) => (
                <li key={t}>{formatNextRun(t)}</li>
              ))}
            </ul>
          )}
        </dd>
      </div>
      <Row label="Does" value={actionLine(p.action)} before={b ? actionLine(b.action) : undefined} />
      {kind !== "notify" && (
        <Row label="Runs in" value={LANDING_LABEL[p.landing]} before={b && LANDING_LABEL[b.landing]} />
      )}
      {kind !== "notify" && (
        <Row
          label="Reports"
          value={REPORT_LABEL[p.report]}
          before={b && b.action.kind !== "notify" ? REPORT_LABEL[b.report] : undefined}
        />
      )}
      {p.startKind === "schedule" && (
        <>
          <Row label="Skipped if late by" value={`${p.latenessMinutes} min`} before={b && `${b.latenessMinutes} min`} />
          <Row label="If a run is missed" value={CATCH_UP_LABEL[p.catchUp]} before={b && CATCH_UP_LABEL[b.catchUp]} />
        </>
      )}
      {kind !== "notify" && p.startKind === "schedule" && (
        <Row
          label="If the last run is still going"
          value={OVERLAP_LABEL[p.overlap]}
          before={b && OVERLAP_LABEL[b.overlap]}
        />
      )}
      {kind !== "notify" && <Row label="Permissions" value={levelLine(p.profile)} before={b && levelLine(b.profile)} />}
      {p.allow.length > 0 && (
        <div>
          <dt>Allowed without asking</dt>
          <dd>
            <ul className={cn("preview-allow", LIST)}>
              {p.allow.map((a) => (
                <li key={`${a.tool}\n${a.destination ?? ""}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span>
                    {a.label.replace(/\.$/, "")}
                    {a.destination && <span className="preview-dest text-muted-foreground"> · {a.destination}</span>}
                  </span>
                  <Badge variant="secondary" className="class-chip bg-attention-soft text-attention-text">
                    {CLASS_LABEL[a.actionClass]}
                  </Badge>
                </li>
              ))}
            </ul>
          </dd>
        </div>
      )}
      {p.skillNeeds && p.skillNeeds.length > 0 && (
        <div>
          <dt>The skill needs</dt>
          <dd>
            {p.skillNeeds.join(", ")}. This grants nothing by itself; each action is still decided by the permission
            level.
          </dd>
        </div>
      )}
    </dl>
  );
}

function SkillCard({ preview: p }: { preview: SkillPreview }) {
  const [diff, setDiff] = useState(false);
  const bodyId = useId();
  return (
    <div className="preview-skill flex min-w-0 flex-col gap-1.5">
      <dl className={PREVIEW_FACTS} aria-label="Skill">
        <Row label="Name" value={p.name} />
        <Row label="Description" value={p.description} />
        <Row
          label="Saves as"
          value={p.op === "update" ? `A new version (changes version ${p.fromVersion ?? "?"})` : "A new skill"}
        />
        {p.files.length > 0 && <Row label="Other files" value={p.files.join(", ")} />}
      </dl>
      <div className="preview-skill-box flex min-w-0 flex-col overflow-hidden rounded-xl border bg-muted">
        <div className="preview-skill-head flex items-center justify-between gap-2 border-b px-3 py-0.5 text-xs text-muted-foreground">
          <span>{diff ? "Changes" : "SKILL.md"}</span>
          {p.diff && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="-mr-2 text-muted-foreground"
              aria-pressed={diff}
              aria-controls={bodyId}
              onClick={() => setDiff((d) => !d)}
            >
              {diff ? "Show SKILL.md" : "Show diff"}
            </Button>
          )}
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: a labelled scroll region, not a form group */}
        <div
          id={bodyId}
          className="preview-scroll max-h-60 overflow-auto px-3 py-2 text-sm"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll this box
          tabIndex={0}
          role="group"
          aria-label={diff ? "Changes to SKILL.md" : "SKILL.md"}
        >
          {diff && p.diff ? <DiffText diff={p.diff} /> : <SkillMdView text={p.skillMd} />}
        </div>
      </div>
    </div>
  );
}

/** A unified diff, one line each, with additions and removals tinted and marked (never by colour alone). */
function DiffText({ diff }: { diff: string }) {
  return (
    <pre className="diff-text m-0 font-mono text-xs leading-relaxed whitespace-pre">
      <code className="font-[inherit]">
        {diff.split("\n").map((line, i) => (
          <span
            key={i}
            className="diff-line -mx-3 block px-3 data-[kind=add]:bg-success/15 data-[kind=del]:bg-destructive/10 data-[kind=meta]:text-muted-foreground"
            data-kind={
              line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")
                ? "meta"
                : line[0] === "+"
                  ? "add"
                  : line[0] === "-"
                    ? "del"
                    : undefined
            }
          >
            {line}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}
