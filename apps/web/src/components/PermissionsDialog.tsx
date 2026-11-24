import type { ProfileName, SessionOrigin } from "@rei/protocol";
import { type RefObject, useId, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/primitives/dialog.tsx";
import { PROFILE_HELP, PROFILE_LABEL, PROFILES } from "../lib/policy.ts";
import { DialogError, DialogWarning, NATIVE_CHECK, OPTION_CARD } from "./dialogParts.tsx";

interface Props {
  current: ProfileName;
  origin: SessionOrigin;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (profile: ProfileName) => void;
  fallbackFocus?: RefObject<HTMLElement | null>;
}

/** Choose how freely this chat's agent may act. Only you can change it; the agent can't. */
export function PermissionsDialog({ current, origin, busy, error, onCancel, onSave, fallbackFocus }: Props) {
  const selectedRadio = useRef<HTMLInputElement>(null);
  const [choice, setChoice] = useState<ProfileName>(current);
  const name = useId();

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent
        size="lg"
        fallbackFocus={fallbackFocus}
        showCloseButton={false}
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          selectedRadio.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Permissions</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-col gap-1 [&_p]:m-0">
              <p>This chat only.</p>
              {origin === "spawned" && <p>This chat runs without you.</p>}
            </div>
          </DialogDescription>
        </DialogHeader>
        <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" disabled={busy}>
          <legend className="sr-only">Permission level</legend>
          {PROFILES.map((p) => (
            <label key={p} className={OPTION_CARD}>
              <input
                ref={p === current ? selectedRadio : undefined}
                type="radio"
                className={`${NATIVE_CHECK} mt-0.5`}
                name={name}
                value={p}
                checked={choice === p}
                onChange={() => setChoice(p)}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium">
                  {PROFILE_LABEL[p]}
                  {p === current && <span className="font-normal text-muted-foreground"> (current)</span>}
                </span>
                <span className="text-sm text-muted-foreground">{PROFILE_HELP[p]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {choice === "yolo" && (
          <DialogWarning>
            YOLO skips most approvals. Content the agent reads on the web could talk it into things you wouldn't choose.
            Use it only for chats you trust.
          </DialogWarning>
        )}
        {error && <DialogError>{error}</DialogError>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" disabled={busy || choice === current} onClick={() => onSave(choice)}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
