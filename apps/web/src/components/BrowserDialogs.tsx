// Native page UI that isn't in the live picture, drawn by the app: a <select>'s list and JavaScript dialogs.
import type { LiveServerMessage } from "@rei/protocol";
import { useId, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/primitives/alert-dialog.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/primitives/dialog.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { NATIVE_CHECK, OPTION_CARD } from "./dialogParts.tsx";

type SelectMsg = Extract<LiveServerMessage, { type: "select" }>;
type DialogMsg = Extract<LiveServerMessage, { type: "dialog" }>;

/** Pick from the focused <select>. One choice answers at once; several wait for Done. Cancel sends nothing. */
export function SelectPicker({
  select,
  onChoose,
  onCancel,
}: {
  select: SelectMsg;
  onChoose: (values: string[]) => void;
  onCancel: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const name = useId();
  const [chosen, setChosen] = useState<string[]>(() => select.options.filter((o) => o.selected).map((o) => o.value));

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        ref={root}
        size="lg"
        showCloseButton={false}
        aria-describedby={undefined}
        className="select-picker"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          root.current?.querySelector<HTMLInputElement>("input:checked, input")?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{select.multiple ? "Choose options" : "Choose one"}</DialogTitle>
        </DialogHeader>
        <fieldset className="select-options m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
          <legend className="sr-only">{select.multiple ? "Options (several can be chosen)" : "Options"}</legend>
          {select.options.map((o, i) => (
            <label key={`${i}:${o.value}`} className={OPTION_CARD}>
              <input
                type={select.multiple ? "checkbox" : "radio"}
                className={`${NATIVE_CHECK} mt-0.5`}
                name={name}
                value={o.value}
                checked={chosen.includes(o.value)}
                // A click, not a change, answers a single choice, so tapping the option already chosen still closes the picker.
                onClick={select.multiple ? undefined : () => onChoose([o.value])}
                onChange={(e) =>
                  select.multiple &&
                  setChosen((c) => (e.target.checked ? [...c, o.value] : c.filter((v) => v !== o.value)))
                }
              />
              <span className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">{o.label || o.value}</span>
            </label>
          ))}
        </fieldset>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          {select.multiple && (
            <Button type="button" onClick={() => onChoose(chosen)}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const TITLE: Record<DialogMsg["kind"], string> = {
  alert: "The page says",
  confirm: "The page asks",
  prompt: "The page asks",
  beforeunload: "Leave this page?",
};

/** A JavaScript dialog from the page. The message is the page's own text, shown as plain text. */
export function PageDialog({
  dialog,
  onAnswer,
}: {
  dialog: DialogMsg;
  onAnswer: (accept: boolean, text?: string) => void;
}) {
  const promptId = useId();
  const [text, setText] = useState(dialog.defaultPrompt ?? "");
  const input = useRef<HTMLInputElement>(null);
  const okBtn = useRef<HTMLButtonElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  const two = dialog.kind !== "alert";

  return (
    // Escape is the safe answer: OK for an alert (it has no other), otherwise the refusal. Clicking outside answers nothing.
    <AlertDialog open onOpenChange={(open) => !open && onAnswer(dialog.kind === "alert")}>
      <AlertDialogContent
        size="default"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (input.current ?? cancelBtn.current ?? okBtn.current)?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{TITLE[dialog.kind]}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="page-dialog-text [overflow-wrap:anywhere] [&_p]:m-0">
              {dialog.kind === "beforeunload" ? (
                <p>The page wants to keep you here: changes may not be saved.</p>
              ) : (
                <p>{dialog.message}</p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {dialog.kind === "prompt" && (
          <label htmlFor={promptId}>
            <span className="sr-only">Your answer</span>
            <Input
              ref={input}
              id={promptId}
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onAnswer(true, text)}
            />
          </label>
        )}
        <AlertDialogFooter>
          {two && (
            <Button ref={cancelBtn} type="button" variant="outline" onClick={() => onAnswer(false)}>
              {dialog.kind === "beforeunload" ? "Stay" : "Cancel"}
            </Button>
          )}
          <Button ref={okBtn} type="button" onClick={() => onAnswer(true, dialog.kind === "prompt" ? text : undefined)}>
            {dialog.kind === "beforeunload" ? "Leave" : "OK"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
