import type { Agent, Session } from "@rei/protocol";
import { type RefObject, useEffect, useState } from "react";
import type { Api } from "../api/client.ts";
import { PROFILE_LABEL } from "../lib/policy.ts";
import { useLocation } from "../lib/route.ts";
import { AgentSettingsDialog } from "./full/AgentSettingsDialog.tsx";
import { Button } from "./primitives/button.tsx";
import { Tip } from "./Tip.tsx";

export function ComposerSettings({
  api,
  agent,
  session,
  onPermissions,
  permissionRef,
}: {
  api: Api;
  agent?: Agent | undefined;
  session: Session;
  onPermissions: () => void;
  permissionRef?: RefObject<HTMLButtonElement | null>;
}) {
  // Coming back from Settings (any route change) may have changed the default model.
  const route = useLocation();
  const [modelOpen, setModelOpen] = useState(false);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [modelLabels, setModelLabels] = useState<Record<string, string>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: `route` is the trigger: any route change refetches the default model.
  useEffect(() => {
    let live = true;
    const refresh = () => {
      if (api.getModels)
        void api.getModels().then(
          (catalog) => {
            if (live) {
              setModelLabels(catalog.labels ?? {});
              setDefaultModel(
                catalog.models.includes(catalog.default)
                  ? catalog.default
                  : catalog.models.length
                    ? "Default unavailable"
                    : "No models available",
              );
            }
          },
          () => {},
        );
    };
    refresh();
    return () => {
      live = false;
    };
  }, [api, route]);
  const effort = agent?.thinkingLevel ?? "off";
  const effortLabel =
    effort === "off" ? "Default" : effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1);
  const profile = session.profile ?? "standard";
  return (
    <>
      {agent && (
        <Tip label="Model and thinking effort">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 max-w-[min(65vw,22rem)] gap-2 px-2 text-sm font-normal"
            aria-label="Model and thinking effort"
            onClick={() => setModelOpen(true)}
          >
            <span className="truncate">
              {modelLabels[agent.model ?? defaultModel ?? ""] ?? agent.model ?? defaultModel ?? "Default model"}
            </span>
            <span className="shrink-0 text-muted-foreground">{effortLabel}</span>
          </Button>
        </Tip>
      )}
      <Tip label="Permissions for this chat">
        <Button
          ref={permissionRef}
          type="button"
          variant="ghost"
          size="sm"
          className={`h-8 px-2 text-sm font-normal ${profile === "yolo" ? "yolo text-attention-text" : ""}`}
          aria-label={`Permissions: ${PROFILE_LABEL[profile]}. Change`}
          onClick={onPermissions}
        >
          {PROFILE_LABEL[profile]}
        </Button>
      </Tip>
      {modelOpen && agent && (
        <AgentSettingsDialog
          mode="model"
          agent={agent}
          api={api}
          onClose={() => setModelOpen(false)}
          onChangeLook={() => {}}
        />
      )}
    </>
  );
}
