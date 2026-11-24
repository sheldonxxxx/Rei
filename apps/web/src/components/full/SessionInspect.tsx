import type { Agent, Session } from "@rei/protocol";
import { branchesOf, childrenOf } from "../../lib/family.ts";
import { PROFILE_LABEL } from "../../lib/policy.ts";
import { sessionHref } from "../../lib/route.ts";
import { formatWhen } from "../../lib/time.ts";
import { FACTS } from "./factStyles.ts";

/** What this chat is: ids, agent, profile, taint, depth, where it was forked from, the sessions around it. */
export function SessionInspect({
  session,
  agent,
  sessions,
  runCount,
  moreRuns,
}: {
  session: Session;
  agent: Agent | undefined;
  sessions: Session[] | undefined;
  runCount: number;
  moreRuns: boolean;
}) {
  const title = (id: string) => sessions?.find((s) => s.id === id)?.title;
  const from = session.forkedFrom;
  const parent = session.parentSessionId;
  const branches = sessions ? branchesOf(sessions, session.id) : [];
  const spawned = sessions ? childrenOf(sessions, session.id) : [];
  return (
    <dl className={FACTS}>
      <div>
        <dt>Session</dt>
        <dd className="font-mono">{session.id}</dd>
      </div>
      <div>
        <dt>Agent</dt>
        <dd>{agent ? `${agent.name} (${agent.id})` : session.agentId}</dd>
      </div>
      <div>
        <dt>Origin</dt>
        <dd>{session.origin}</dd>
      </div>
      <div>
        <dt>Profile</dt>
        <dd>{PROFILE_LABEL[session.profile]}</dd>
      </div>
      <div>
        <dt>Taint</dt>
        <dd>{session.taint.length ? session.taint.join(", ") : "none"}</dd>
      </div>
      <div>
        <dt>Depth</dt>
        <dd>{session.depth}</dd>
      </div>
      <div>
        <dt>Created</dt>
        <dd>{formatWhen(session.createdAt)}</dd>
      </div>
      <div>
        <dt>Runs</dt>
        <dd>
          {runCount}
          {moreRuns ? "+" : ""}
        </dd>
      </div>
      {from && (
        <div>
          <dt>Forked from</dt>
          <dd>
            <a href={sessionHref(from.sessionId, from.onAnotherVersion ? undefined : from.messageId)}>
              {title(from.sessionId) ?? "another chat"}
            </a>
            {from.onAnotherVersion && " (on another version of this chat)"}
            {from.stepId && <span className="font-mono"> · step {from.stepId}</span>}
            {from.edited && " · edited or retried"}
          </dd>
        </div>
      )}
      {parent && (
        <div>
          <dt>Started by</dt>
          <dd>
            <a href={sessionHref(parent)}>{title(parent) ?? "another chat"}</a>
          </dd>
        </div>
      )}
      {(branches.length > 0 || spawned.length > 0) && (
        <div>
          <dt>Tree</dt>
          <dd>
            <ul className="tree-list m-0 list-none p-0">
              {branches.map((s) => (
                <li key={s.id}>
                  Fork: <a href={sessionHref(s.id)}>{s.title}</a>
                </li>
              ))}
              {spawned.map((s) => (
                <li key={s.id}>
                  Spawned: <a href={sessionHref(s.id)}>{s.title}</a>
                </li>
              ))}
            </ul>
          </dd>
        </div>
      )}
    </dl>
  );
}
