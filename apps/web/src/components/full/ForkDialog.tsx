import { useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/primitives/dialog.tsx";
import type { Api } from "../../api/client.ts";
import { describeError } from "../../api/client.ts";
import { DialogError } from "../dialogParts.tsx";

export type ForkAt = { messageId: string };

interface Props {
  api: Api;
  sessionId: string;
  at: ForkAt;
  onCancel: () => void;
  /** The new chat was made. */
  onForked: (sessionId: string) => void;
}

/** "Fork from here" in Full mode: a plain confirm, then forks. */
export function ForkDialog({ api, sessionId, at, onCancel, onForked }: Props) {
  const [busy, setBusy] = useState(false);
  const [forkError, setForkError] = useState<string | null>(null);

  async function fork() {
    setBusy(true);
    setForkError(null);
    try {
      const r = await api.forkSession(sessionId, at.messageId);
      onForked(r.session.id);
    } catch (e) {
      setForkError(describeError(e));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent size="lg" showCloseButton={false} onEscapeKeyDown={(e) => busy && e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Fork from here</DialogTitle>
          <DialogDescription>The original stays as it is.</DialogDescription>
        </DialogHeader>
        {forkError && <DialogError>{forkError}</DialogError>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" disabled={busy} aria-busy={busy} onClick={() => void fork()}>
            {busy ? "Forking…" : "Fork into a new chat"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
