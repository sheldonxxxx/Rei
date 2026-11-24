import type { Agent } from "@rei/protocol";
import { AGENT_BOT_AVATARS } from "@rei/protocol";
import { type ReactNode, useId, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/primitives/dialog.tsx";
import { Field } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Label } from "@/components/primitives/label.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import { resizeAvatar } from "../lib/avatarImage.ts";
import { Avatar } from "./Avatar.tsx";
import { BOT_NAMES, botIdOf } from "./BotAvatar.tsx";
import { DialogError } from "./dialogParts.tsx";
import { Icon } from "./Icon.tsx";

const TEXT_MAX = 8;
const isBot = (v: string) => v.startsWith("bot:");
const isPicture = (v: string) => v.startsWith("data:");

interface Props {
  agent: Agent;
  api: Api;
  /** Closes the dialog (saved or not). The new look reaches the app through the agent.upserted event. */
  onClose: () => void;
}

/** Choose how an agent looks: one of the built-in bots, an emoji or a few letters, or your own picture. */
export function AvatarPicker({ agent, api, onClose }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [choice, setChoice] = useState(agent.avatar);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = choice !== agent.avatar && choice.trim() !== "";

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    setReading(true);
    try {
      setChoice(await resizeAvatar(file));
    } catch {
      setError("That file isn't a picture this browser can read. Try a PNG, JPEG or WebP.");
    } finally {
      setReading(false);
      if (fileInput.current) fileInput.current.value = ""; // choosing the same file again should still fire
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(agent.id, { avatar: choice.trim() });
      onClose();
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        ref={root}
        size="lg"
        showCloseButton={false}
        aria-describedby={undefined}
        className="avatar-picker"
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          const selected = root.current?.querySelector<HTMLInputElement>("input[type=radio]:checked");
          (selected ?? root.current?.querySelector<HTMLInputElement>("input[type=radio]"))?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Change {agent.name}'s look</DialogTitle>
        </DialogHeader>
        <div className="flex justify-center">
          <Avatar value={choice.trim() || agent.avatar} size={72} label={`${agent.name}'s new look`} />
        </div>

        <AvatarChoices choice={choice} disabled={busy} onChange={setChoice}>
          <div>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              hidden
              aria-label="Picture file"
              onChange={(e) => void pick(e.target.files?.[0])}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={busy || reading}
              aria-busy={reading}
              onClick={() => fileInput.current?.click()}
            >
              <Icon name="upload" size={16} />
              {reading ? "Reading…" : "Upload a picture"}
            </Button>
          </div>
        </AvatarChoices>

        {error && <DialogError>{error}</DialogError>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={busy || reading || !changed} aria-busy={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface AvatarChoicesProps {
  choice: string;
  disabled: boolean;
  onChange: (choice: string) => void;
  children?: ReactNode;
}

/** The same built-in icons and text field for creating an agent and changing its look. */
export function AvatarChoices({ choice, disabled, onChange, children }: AvatarChoicesProps) {
  const radios = useId();
  const textId = useId();
  const selectedBot = isBot(choice) ? `bot:${botIdOf(choice)}` : null;
  const text = isBot(choice) || isPicture(choice) ? "" : choice;

  return (
    <>
      <fieldset className="m-0 grid min-w-0 grid-cols-3 gap-2 border-0 p-0" disabled={disabled}>
        <legend className="col-span-3 mb-2 p-0 text-xs font-medium text-muted-foreground">Pick a bot</legend>
        {AGENT_BOT_AVATARS.map((value) => {
          const id = value.slice(4) as keyof typeof BOT_NAMES;
          return (
            <label
              key={value}
              className="bot-option relative flex cursor-pointer flex-col items-center gap-1.5 rounded-2xl border px-1.5 pt-2.5 pb-2 text-center text-xs text-muted-foreground transition-colors hover:bg-muted has-checked:border-ring has-checked:bg-accent has-checked:font-medium has-checked:text-accent-foreground has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring has-disabled:cursor-not-allowed has-disabled:opacity-60"
            >
              <input
                type="radio"
                className="peer sr-only"
                name={radios}
                value={value}
                checked={selectedBot === value}
                onChange={() => onChange(value)}
              />
              <Icon
                name="check"
                size={14}
                className="absolute top-1.5 right-1.5 hidden text-accent-foreground peer-checked:block"
              />
              <Avatar value={value} size={52} />
              <span>{BOT_NAMES[id]}</span>
            </label>
          );
        })}
      </fieldset>

      <div className="flex flex-wrap items-end gap-3">
        <Field className="min-w-44 flex-1 gap-2">
          <Label htmlFor={textId}>Or an emoji or a few letters</Label>
          <Input
            id={textId}
            type="text"
            value={text}
            maxLength={TEXT_MAX}
            placeholder="🙂"
            autoComplete="off"
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        </Field>
        {children}
      </div>
    </>
  );
}
