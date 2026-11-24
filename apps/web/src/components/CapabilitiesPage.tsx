import type { Agent } from "@rei/protocol";
import type { Api } from "../api/client.ts";
import { CAPABILITY_VIEWS, type CapabilityView, settingsHref } from "../lib/route.ts";
import { ConnectorsPage } from "./ConnectorsPage.tsx";
import { PluginsPage } from "./PluginsPage.tsx";
import { SkillsPage } from "./SkillsPage.tsx";

const LABEL: Record<CapabilityView, string> = { plugins: "Plugins", skills: "Skills", connectors: "Connectors" };

interface Props {
  api: Api;
  agents: Agent[];
  view: CapabilityView;
  /** The open plugin, skill or connector; null shows the view's list. */
  id: string | null;
  /** From the global stream: rises when a skill or plugin changed. */
  rev: number;
}

/**
 * Settings → Capabilities: what the assistants can use, in three views. Plugins are optional packages; Skills and
 * Connectors list everything, standalone or from a plugin, with its owner. Skills also show which agents may use each.
 */
export function CapabilitiesPage({ api, agents, view, id, rev }: Props) {
  const body =
    view === "plugins" ? (
      <PluginsPage api={api} agents={agents} id={id} rev={rev} />
    ) : view === "skills" ? (
      <SkillsPage api={api} agents={agents} id={id} rev={rev} />
    ) : (
      <ConnectorsPage api={api} id={id} />
    );
  if (id) return body;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <nav aria-label="Capabilities" className="flex w-fit gap-1 rounded-xl bg-muted p-1">
        {CAPABILITY_VIEWS.map((v) => (
          <a
            key={v}
            href={settingsHref(v)}
            aria-current={v === view ? "page" : undefined}
            className="nav-selection rounded-lg px-3 py-1.5 text-sm text-muted-foreground no-underline outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground"
          >
            {LABEL[v]}
          </a>
        ))}
      </nav>
      {body}
    </div>
  );
}
