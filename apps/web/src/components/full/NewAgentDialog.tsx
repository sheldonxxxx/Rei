import type { CreateAgentResponse } from "@rei/protocol";
import { AGENT_DESCRIPTION_MAX_CHARS } from "@rei/protocol";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/primitives/dialog.tsx";
import { Field } from "@/components/primitives/field.tsx";
import { Label } from "@/components/primitives/label.tsx";
import { Textarea } from "@/components/primitives/textarea.tsx";
import type { Api } from "../../api/client.ts";
import { describeAgentError } from "../../api/client.ts";
import { DialogError } from "../dialogParts.tsx";

interface Props {
  api: Api;
  onClose: () => void;
  /** The agent and its home chat; the caller opens the chat. */
  onCreated: (created: CreateAgentResponse) => void;
}

/** Make an agent from one sentence. A model writes its name, look and instructions, which can take a few seconds. */
export function NewAgentDialog({ api, onClose, onCreated }: Props) {
  const box = useRef<HTMLTextAreaElement>(null);
  const descId = useId();
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = description.trim();

  async function create() {
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createAgent(trimmed));
    } catch (e) {
      setError(describeAgentError(e));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        size="lg"
        showCloseButton={false}
        className="new-agent"
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          box.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>{busy ? "Setting up your agent…" : "One sentence is enough."}</DialogDescription>
        </DialogHeader>
        <Field className="gap-2">
          <Label htmlFor={descId}>What kind of agent do you want?</Label>
          <Textarea
            ref={box}
            id={descId}
            rows={3}
            value={description}
            maxLength={AGENT_DESCRIPTION_MAX_CHARS}
            placeholder="A social media manager"
            disabled={busy}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        {error && <DialogError>{error}</DialogError>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={busy || trimmed.length === 0} aria-busy={busy} onClick={() => void create()}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
