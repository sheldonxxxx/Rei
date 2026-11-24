import { AGENT_NAME_MAX_CHARS, type CreateAgentResponse } from "@rei/protocol";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/primitives/dialog.tsx";
import { Field } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Label } from "@/components/primitives/label.tsx";
import type { Api } from "../../api/client.ts";
import { describeAgentError } from "../../api/client.ts";
import { AvatarChoices } from "../AvatarPicker.tsx";
import { DialogError } from "../dialogParts.tsx";

interface Props {
  api: Api;
  onClose: () => void;
  /** The agent and its home chat; the caller opens the chat. */
  onCreated: (created: CreateAgentResponse) => void;
}

export function NewAgentDialog({ api, onClose, onCreated }: Props) {
  const box = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = name.trim().length > 0 && name.trim().length <= AGENT_NAME_MAX_CHARS && avatar.trim().length > 0;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createAgent({ name: name.trim(), avatar: avatar.trim() }));
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
        aria-describedby={undefined}
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          box.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !busy) void create();
          }}
        >
          <Field className="gap-2">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              ref={box}
              id={nameId}
              value={name}
              maxLength={AGENT_NAME_MAX_CHARS}
              autoComplete="off"
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <AvatarChoices choice={avatar} disabled={busy} onChange={setAvatar} />
          {error && <DialogError>{error}</DialogError>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !ready} aria-busy={busy}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
