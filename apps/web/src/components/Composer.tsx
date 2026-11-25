import type {
  Agent,
  Attachment,
  Connector,
  ConversationLive,
  KnowledgeTreeNode,
  Message,
  MessageContext,
  MessageMention,
  SendWhenBusy,
  Session,
  SessionSkillOption,
} from "@rei/protocol";
import { COMPACT_INSTRUCTIONS_MAX, SELECTED_SKILLS_MAX } from "@rei/protocol";
import type { KeyboardEvent, ReactNode, Ref } from "react";
import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { cn } from "@/lib/utils.ts";
import type { Api } from "../api/client.ts";
import { describeCompactError, describeError } from "../api/client.ts";
import {
  attachmentLimit,
  bestChoice,
  COMPACT_COMMAND,
  changedDraft,
  isLargePaste,
  mentionQuery,
  parseSlashAction,
  pastedFileName,
  replaceDraft,
  slashQuery,
} from "../lib/composer.ts";
import { type DraftFile, type DraftSkill, loadComposerDraft, saveComposerDraft } from "../lib/composerDraft.ts";
import { useDismiss } from "../lib/useDismiss.ts";
import { ContextUsage } from "./ContextUsage.tsx";
import { DraftAttachments } from "./DraftAttachments.tsx";
import { FilePreview } from "./FilePreview.tsx";
import { Icon } from "./Icon.tsx";
import { LibraryPicker } from "./LibraryPicker.tsx";
import { Tip } from "./Tip.tsx";

/** What the session's Compaction is doing now (the server's word for it), shown above the composer. */
const COMPACTION_TEXT: Record<string, string> = {
  accepted: "Compaction requested…",
  running: "Compacting the conversation…",
  pending_placement: "The summary is ready and is being placed in the conversation…",
};

export interface ComposerHandle {
  restoreDraft(message: Message): void;
}

interface Props {
  /**
   * Sends a message. A message with skill chips resolves once the server accepted it (and rejects with the reason, so
   * the draft is kept); `requestId` is the same for an unchanged draft, so a resend after a lost reply is safe.
   */
  onSend: (
    text: string,
    context?: MessageContext,
    requestId?: string,
    options?: { whenBusy?: SendWhenBusy },
  ) => void | Promise<void>;
  /** What a message sent while a reply runs does by default (Settings > Behavior); Alt+Enter does the other. */
  whenBusy?: SendWhenBusy;
  /** Runs `/compact`: resolves once the server accepted it, rejects with the reason (the draft is kept then). */
  onCompact?: (instructions: string | undefined, requestId: string) => Promise<void>;
  compaction?: ConversationLive["manualCompaction"] | undefined;
  onStop: () => void;
  hasQueuedMessages?: boolean;
  draftRef?: Ref<ComposerHandle>;
  running: boolean;
  stopping?: boolean;
  contextRevision?: string;
  settings?: ReactNode;
  placeholder?: string;
  api?: Api;
  sessionId?: string;
  sessions?: Session[] | undefined;
  agents?: Agent[];
  allowedConnectorIds?: string[] | null;
}
interface Choice {
  kind: "upload" | "library" | "connector" | "chat" | "page" | "command" | "skill";
  /** A skill choice carries the option it adds. */
  skill?: SessionSkillOption;
  id: string;
  label: string;
  detail: string;
  disabled?: boolean;
}

export function Composer({
  onSend,
  onCompact,
  compaction,
  onStop,
  hasQueuedMessages = false,
  draftRef,
  whenBusy = "steer",
  running,
  stopping,
  contextRevision,
  settings,
  placeholder = "Message",
  api,
  sessionId,
  sessions = [],
  agents = [],
  allowedConnectorIds,
}: Props) {
  const [restored, setRestored] = useState(!sessionId || typeof indexedDB === "undefined");
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<MessageMention[]>([]);
  const [files, setFiles] = useState<DraftFile[]>([]);
  const filesRef = useRef(files);
  filesRef.current = files;
  const apiRef = useRef(api);
  apiRef.current = api;
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [libraryPicker, setLibraryPicker] = useState(false);
  const [notice, setNotice] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<DraftSkill[]>([]);
  const [skillOptions, setSkillOptions] = useState<SessionSkillOption[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState("");
  const [sending, setSending] = useState(false);
  /** One request id per unchanged draft: a resend after a lost reply is de-duplicated by the server. */
  const requestRef = useRef<{ key: string; id: string } | null>(null);
  const [picker, setPicker] = useState<{
    start: number;
    end: number;
    query: string;
    source: "plus" | "at" | "slash";
  } | null>(null);
  /** The row moved to with the arrows or the pointer; until then (`null`) the best match is highlighted. */
  const [moved, setActive] = useState<number | null>(null);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [pages, setPages] = useState<KnowledgeTreeNode[]>([]);
  const [connectorError, setConnectorError] = useState("");
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const menuId = useId();
  const savedSelection = useRef({ start: 0, end: 0 });
  const restoreCursor = useRef<number | null>(null);
  useImperativeHandle(
    draftRef,
    () => ({
      restoreDraft(message) {
        ref.current?.focus();
        if (!restored || sending || text || files.length || mentions.length || selectedSkills.length) {
          setNotice("Finish or clear your current draft first.");
          return;
        }
        requestRef.current = null;
        restoreCursor.current = message.text.length;
        setText(message.text);
        setMentions(message.mentions ?? []);
        setSelectedSkills(message.selectedSkills ?? []);
        setFiles(
          (message.attachments ?? []).map((attachment) => ({
            key: attachment.id,
            file: new File([], attachment.name),
            status: "ready",
            attachment,
          })),
        );
        setPicker(null);
        setNotice("");
      },
    }),
    [restored, sending, text, files.length, mentions.length, selectedSkills.length],
  );
  const close = useCallback(() => {
    setPicker(null);
    ref.current?.focus();
  }, []);
  useDismiss(formRef, picker !== null, close);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!sessionId || typeof indexedDB === "undefined") return;
    let cancelled = false;
    loadComposerDraft(sessionId)
      .then(
        (draft) => {
          if (!cancelled && draft) {
            setText(draft.text);
            setMentions(draft.mentions);
            const chips = draft.selectedSkills ?? [];
            setSelectedSkills(chips);
            // The chips were pinned when the draft was last open: check them against what the agent can use now.
            if (chips.length && apiRef.current)
              apiRef.current.getSessionSkills(sessionId).then(
                (r) => {
                  if (cancelled) return;
                  setSelectedSkills((items) =>
                    items.map((c) => {
                      const now = r.skills.find((s) => s.id === c.id);
                      return now ? { id: now.id, name: now.name, version: now.version } : { ...c, unavailable: true };
                    }),
                  );
                },
                () => {},
              );
            const restored = draft.files.map((f) =>
              f.status === "uploading"
                ? { ...f, status: "failed" as const, error: "Upload interrupted. Retry upload." }
                : f,
            );
            filesRef.current = restored;
            setFiles(restored);
          }
        },
        () => {
          if (!cancelled) setNotice("Draft recovery is unavailable in this browser.");
        },
      )
      .finally(() => {
        if (!cancelled) setRestored(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  useEffect(() => {
    if (sessionId && restored)
      void saveComposerDraft(sessionId, { text, mentions, files, selectedSkills }).catch(() =>
        setNotice("Could not save this draft on this device. Keep this chat open until it is sent."),
      );
  }, [sessionId, restored, text, mentions, files, selectedSkills]);

  const open = picker !== null;
  const slashOpen = picker?.source === "slash";
  // The `/` list is the session's own agent's skills, fetched each time it opens.
  useEffect(() => {
    if (!slashOpen || !api || !sessionId) return;
    let cancelled = false;
    setSkillsLoading(true);
    setSkillsError("");
    api
      .getSessionSkills(sessionId)
      .then(
        (r) => {
          if (!cancelled) setSkillOptions(r.skills);
        },
        (e) => {
          if (!cancelled) setSkillsError(describeError(e));
        },
      )
      .finally(() => {
        if (!cancelled) setSkillsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, slashOpen]);
  useEffect(() => {
    if (!open || slashOpen || !api) return;
    let cancelled = false;
    setLoading(true);
    setConnectorError("");
    setConnectors([]);
    api
      .getConnectors()
      .then(
        (r) => {
          if (!cancelled) setConnectors(r.connectors);
        },
        (e) => {
          if (!cancelled) setConnectorError(describeError(e));
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // Knowledge pages to mention; a failure only leaves them out of the list.
    api.knowledgeTree?.().then(
      (r) => !cancelled && setPages(r.pages),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [api, open, slashOpen]);
  useEffect(() => {
    if (picker?.source === "plus") searchRef.current?.focus();
  }, [picker?.source]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) {
      // Measure content independently of the animated minimum height, so sending
      // from an expanded composer cannot pin the empty editor at its old size.
      el.style.minHeight = "0";
      el.style.height = "0";
      const height = el.scrollHeight;
      el.style.removeProperty("min-height");
      el.style.height = `${height}px`;
    }
  }, [text]);

  const blocked = !restored || files.some((f) => f.status !== "ready");
  const empty = text.trim() === "" && !files.some((f) => f.status === "ready");
  const compacting = compaction !== undefined;
  // Why Send is off, in words (chips alone are not a message; a skill that is gone must be removed).
  const sendReason = compacting
    ? "The conversation is being compacted. You can send when it finishes."
    : selectedSkills.some((s) => s.unavailable)
      ? "Selected skill unavailable. Remove it to send."
      : selectedSkills.length > 0 && empty
        ? "Add a message to send with the selected skills."
        : "";
  const stopDescriptionId = hasQueuedMessages ? `${menuId}-stop` : undefined;
  const sendDescriptionId = sendReason ? `${menuId}-reason` : undefined;
  const query = picker?.query.toLocaleLowerCase() ?? "";
  const slashChoices: Choice[] =
    picker?.source === "slash"
      ? [
          ...(onCompact
            ? [
                {
                  kind: "command" as const,
                  id: COMPACT_COMMAND,
                  label: `/${COMPACT_COMMAND}`,
                  detail: "Summarize older messages to free up context. Add guidance after it.",
                },
              ]
            : []),
          ...skillOptions.map((s): Choice => {
            const chosen = selectedSkills.some((c) => c.id === s.id);
            const full = selectedSkills.length >= SELECTED_SKILLS_MAX;
            const size =
              s.bodyChars >= 1000 ? `${(s.bodyChars / 1000).toFixed(1)}k characters` : `${s.bodyChars} characters`;
            return {
              kind: "skill",
              id: s.id,
              skill: s,
              label: s.name,
              detail: chosen
                ? "Already added to this message"
                : full
                  ? `Up to ${SELECTED_SKILLS_MAX} skills per message`
                  : `${s.description ? `${s.description} · ` : ""}${size}`,
              disabled: chosen || full,
            };
          }),
        ].filter((c) => !query || `${c.label} ${c.skill?.description ?? c.detail}`.toLocaleLowerCase().includes(query))
      : [];
  const contextChoices: Choice[] = [
    {
      kind: "upload" as const,
      id: "upload",
      label: "Upload attachment",
      detail: "Photos and files from your computer",
      disabled: !api || !sessionId,
    },
    ...(api && sessionId && picker?.source === "plus"
      ? [
          {
            kind: "library" as const,
            id: "library",
            label: "Choose from Library",
            detail: "Files saved in your Library",
          },
        ]
      : []),
    ...connectors
      .filter((c) => allowedConnectorIds == null || allowedConnectorIds.includes(c.id))
      .map(
        (c): Choice => ({
          kind: "connector",
          id: c.id,
          label: c.name,
          detail:
            c.status === "connected" ? "MCP connector" : c.status === "needs_auth" ? "Sign in required" : "Unavailable",
          disabled: c.status !== "connected",
        }),
      ),
    ...sessions
      .filter((s) => s.id !== sessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5)
      .map(
        (s): Choice => ({
          kind: "chat",
          id: s.id,
          label: s.title,
          detail: `${agents.find((a) => a.id === s.agentId)?.name ?? "Agent"} · ${s.origin === "spawned" ? "Worker" : s.origin === "home" ? "Home chat" : s.origin === "fork" ? "Fork" : "Chat"}`,
        }),
      ),
    // Pages: the most recently active five, or every match while typing (up to eight).
    ...pages
      .filter((p) => !query || `${p.title} ${p.description}`.toLocaleLowerCase().includes(query))
      .slice(0, query ? 8 : 5)
      .map(
        (p): Choice => ({
          kind: "page",
          id: p.id,
          label: p.title,
          detail: p.description ? `Knowledge page · ${p.description}` : "Knowledge page",
        }),
      ),
  ].filter((c) => !query || `${c.label} ${c.detail}`.toLocaleLowerCase().includes(query));
  const choices = picker?.source === "slash" ? slashChoices : contextChoices;
  const active = moved ?? bestChoice(choices, picker?.query ?? "");

  useEffect(() => {
    if (picker) document.getElementById(`${menuId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, picker?.query, menuId]);

  useLayoutEffect(() => {
    if (restoreCursor.current === null) return;
    const cursor = restoreCursor.current;
    restoreCursor.current = null;
    ref.current?.focus();
    ref.current?.setSelectionRange(cursor, cursor);
  }, [text, mentions]);

  function apply(next: ReturnType<typeof replaceDraft>) {
    restoreCursor.current = next.cursor;
    setText(next.text);
    setMentions(next.mentions);
    savedSelection.current = { start: next.cursor, end: next.cursor };
  }
  function insertText(value: string) {
    const { start, end } = savedSelection.current;
    apply(replaceDraft(text, mentions, start, end, value.replace(/\r\n?/g, "\n")));
    setPicker(null);
  }
  /** `complete`: picked with Tab, which only fills the draft in and never runs or sends anything. */
  function choose(choice: Choice, complete = false) {
    if (choice.disabled || !picker) return;
    if (choice.kind === "command") {
      // `/compact` typed in full runs now; picked from the list it waits for optional guidance.
      if (!complete && parseSlashAction(text)) {
        setPicker(null);
        void send();
        return;
      }
      const next = replaceDraft(text, mentions, picker.start, picker.end, `/${COMPACT_COMMAND} `);
      apply(next);
      setPicker(null);
      return;
    }
    if (choice.kind === "skill") {
      if (!choice.skill) return;
      const { id, name, version } = choice.skill;
      // The command text is consumed; the rest of the draft stays as it was.
      apply(replaceDraft(text, mentions, picker.start, picker.end, ""));
      setSelectedSkills((items) =>
        items.length >= SELECTED_SKILLS_MAX || items.some((s) => s.id === id)
          ? items
          : [...items, { id, name, version }],
      );
      setPicker(null);
      return;
    }
    if (choice.kind === "upload") {
      if (picker.source === "at") apply(replaceDraft(text, mentions, picker.start, picker.end, ""));
      setPicker(null);
      uploadRef.current?.click();
      return;
    }
    if (choice.kind === "library") {
      close();
      setLibraryPicker(true);
      return;
    }
    const label = choice.label.slice(0, 240);
    const next = replaceDraft(text, mentions, picker.start, picker.end, `@${label} `);
    next.mentions.push({
      kind: choice.kind,
      id: choice.id,
      label,
      start: next.cursor - label.length - 2,
      end: next.cursor - 1,
    });
    next.mentions.sort((a, b) => a.start - b.start);
    apply(next);
    setPicker(null);
  }
  async function upload(draft: DraftFile) {
    if (!api || !sessionId) return;
    try {
      const attachment = await api.uploadAttachment(sessionId, draft.file);
      if (mounted.current)
        setFiles((items) =>
          items.map((f) => (f.key === draft.key ? { ...f, status: "ready", attachment, error: undefined } : f)),
        );
    } catch (e) {
      if (mounted.current)
        setFiles((items) =>
          items.map((f) => (f.key === draft.key ? { ...f, status: "failed", error: describeError(e) } : f)),
        );
    }
  }
  function addFiles(incoming: File[], pastedText?: string) {
    const next = [...filesRef.current];
    for (const file of incoming) {
      const error =
        !api || !sessionId
          ? "Uploads are unavailable."
          : attachmentLimit(
              file,
              next.filter((f) => f.status !== "rejected").map((f) => ({ size: f.attachment?.size ?? f.file.size })),
            );
      const draft: DraftFile = {
        key: crypto.randomUUID(),
        file,
        status: error ? "rejected" : "uploading",
        error: error ?? undefined,
        pastedText,
      };
      // Rejected normal files need only an error; large pasted text must remain recoverable.
      if (error && pastedText === undefined) {
        setNotice(`${file.name}: ${error}`);
        continue;
      }
      next.push(draft);
      if (!error) void upload(draft);
    }
    filesRef.current = next;
    setFiles(next);
  }
  function removeFile(key: string) {
    filesRef.current = filesRef.current.filter((f) => f.key !== key);
    setFiles(filesRef.current);
    ref.current?.focus();
  }
  function retryFile(file: DraftFile) {
    const error = attachmentLimit(
      file.file,
      filesRef.current
        .filter((f) => f.key !== file.key && f.status !== "rejected")
        .map((f) => ({ size: f.attachment?.size ?? f.file.size })),
    );
    if (error) {
      setFiles((items) => items.map((f) => (f.key === file.key ? { ...f, error } : f)));
      return;
    }
    setFiles((items) => items.map((f) => (f.key === file.key ? { ...f, status: "uploading", error: undefined } : f)));
    void upload(file);
  }
  /** The same id while the draft is unchanged, so a resend after a lost reply is one message. */
  function requestId(key: string): string {
    if (requestRef.current?.key !== key) requestRef.current = { key, id: crypto.randomUUID() };
    return requestRef.current.id;
  }
  async function runCompact(instructions: string | undefined) {
    if (!onCompact) return;
    if (running) {
      setNotice("Session busy. Wait for the reply to finish, then run /compact again.");
      return;
    }
    if (instructions !== undefined && Array.from(instructions).length > COMPACT_INSTRUCTIONS_MAX) {
      setNotice(`Compaction guidance can be at most ${COMPACT_INSTRUCTIONS_MAX} characters.`);
      return;
    }
    setSending(true);
    try {
      await onCompact(instructions, requestId(`compact:${instructions ?? ""}`));
      requestRef.current = null;
      if (!mounted.current) return;
      // Only the command text goes; files and skill chips stay for the next message.
      setText("");
      setMentions([]);
      setNotice("");
      setPicker(null);
      ref.current?.focus();
    } catch (e) {
      if (mounted.current) setNotice(describeCompactError(e));
    } finally {
      if (mounted.current) setSending(false);
    }
  }
  /** `override`: what this one message does if a reply is running, when it is not the setting's default. */
  async function send(override?: SendWhenBusy) {
    if (sending) return;
    if (onCompact && parseSlashAction(text)) {
      await runCompact(parseSlashAction(text)?.instructions);
      return;
    }
    if (empty || blocked || sendReason) return;
    // Preserve offsets in contextual messages; trim text-only messages.
    const context: MessageContext = {
      ...(mentions.length ? { mentions } : {}),
      ...(files.length ? { attachments: files.flatMap((f) => (f.attachment ? [f.attachment] : [])) } : {}),
      ...(selectedSkills.length
        ? { selectedSkills: selectedSkills.map(({ id, version, name }) => ({ id, version, name })) }
        : {}),
    };
    const rich = mentions.length || files.length || selectedSkills.length;
    const key = JSON.stringify([text, mentions, files.map((f) => f.attachment?.id), selectedSkills]);
    if (selectedSkills.length) {
      const id = requestId(key);
      // The server may refuse a chip (a skill gone, too many): keep the draft and say why instead of an optimistic bubble.
      setSending(true);
      try {
        await (override ? onSend(text, context, id, { whenBusy: override }) : onSend(text, context, id));
      } catch (e) {
        if (mounted.current) setNotice(describeError(e));
        return;
      } finally {
        if (mounted.current) setSending(false);
      }
    } else if (override)
      void onSend(rich ? text : text.trim(), rich ? context : undefined, undefined, { whenBusy: override });
    else if (rich) void onSend(text, context);
    else void onSend(text.trim());
    requestRef.current = null;
    if (!mounted.current) return;
    setText("");
    setMentions([]);
    setFiles([]);
    setSelectedSkills([]);
    filesRef.current = [];
    setNotice("");
    setPicker(null);
    ref.current?.focus();
  }
  function pickerKeys(e: KeyboardEvent<HTMLElement>): boolean {
    if (!picker || e.nativeEvent.isComposing || e.keyCode === 229) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return true;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const direction = e.key === "ArrowDown" ? 1 : -1;
      let next = active;
      for (let i = 0; i < choices.length; i++) {
        next = (next + direction + choices.length) % choices.length;
        if (!choices[next]?.disabled) break;
      }
      setActive(next);
      return true;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      const choice = choices[active];
      // Nothing to pick in the `/` list (a path, an unknown command): Enter sends the text as it is.
      // The same holds for an `@` word that matches nothing (`// @options: {}` in code): it was never a mention.
      if (!choice && (picker.source === "slash" || picker.source === "at")) return false;
      e.preventDefault();
      if (choice) choose(choice);
      return true;
    }
    return false;
  }
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (pickerKeys(e) || e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Tab completes the highlighted row of a typed `/` or `@` list. With nothing to complete, with a modifier
    // (Shift+Tab) or in the + menu it moves the focus as usual.
    if (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const choice = picker && picker.source !== "plus" ? choices[active] : undefined;
      if (choice && !choice.disabled) {
        e.preventDefault();
        choose(choice, true);
        return;
      }
    }
    const el = e.currentTarget,
      start = el.selectionStart,
      end = el.selectionEnd;
    if (!e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && start === end) {
      const backward = e.key === "Backspace" || e.key === "ArrowLeft";
      const forward = e.key === "Delete" || e.key === "ArrowRight";
      const token = mentions.find((m) =>
        backward ? start > m.start && start <= m.end : forward && start >= m.start && start < m.end,
      );
      if (token) {
        e.preventDefault();
        if (e.key === "Backspace" || e.key === "Delete")
          apply(replaceDraft(text, mentions, token.start, token.end, ""));
        else el.setSelectionRange(backward ? token.start : token.end, backward ? token.start : token.end);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Alt+Enter while a reply runs: the other of steer and queue, for this message only.
      void send(e.altKey && running ? (whenBusy === "steer" ? "queue" : "steer") : undefined);
    }
  }

  return (
    <form
      ref={formRef}
      className="composer px-4 pb-[calc(1rem+var(--safe-b))] max-md:px-2.5 max-md:pb-[calc(0.625rem+var(--safe-b))]"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          addFiles(Array.from(e.dataTransfer.files));
        }
      }}
    >
      <div className="composer-wrap relative mx-auto max-w-(--col)">
        {picker && (
          <div className="context-picker absolute inset-x-0 bottom-[calc(100%+0.5rem)] z-20 flex max-h-[min(55dvh,480px)] flex-col rounded-3xl bg-popover p-2 text-popover-foreground shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10">
            {picker.source === "plus" && (
              <Input
                ref={searchRef}
                className="mb-1 shrink-0"
                aria-label="Search connectors and chats"
                role="combobox"
                aria-expanded="true"
                aria-controls={menuId}
                aria-activedescendant={choices[active] ? `${menuId}-${active}` : undefined}
                value={picker.query}
                placeholder="Search connectors and chats"
                onChange={(e) => {
                  setPicker({ ...picker, query: e.target.value });
                  setActive(null);
                }}
                onKeyDown={pickerKeys}
              />
            )}
            <div
              id={menuId}
              role="listbox"
              aria-label={picker.source === "slash" ? "Commands and skills" : "Attachments and context"}
              className="context-options overflow-auto overscroll-contain"
            >
              {choices.map((choice, index) => (
                <div key={`${choice.kind}:${choice.id}`}>
                  {(index === 0 || (choices[index - 1]?.kind !== choice.kind && choice.kind !== "library")) && (
                    <div className="context-heading px-3 pb-1 pt-2.5 text-xs font-medium text-muted-foreground">
                      {choice.kind === "upload" || choice.kind === "library"
                        ? "Attachments"
                        : choice.kind === "command"
                          ? "Commands"
                          : choice.kind === "skill"
                            ? "Skills"
                            : choice.kind === "connector"
                              ? "Connectors"
                              : choice.kind === "page"
                                ? "Knowledge pages"
                                : "Chats"}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    id={`${menuId}-${index}`}
                    aria-selected={active === index}
                    tabIndex={active === index ? 0 : -1}
                    aria-disabled={choice.disabled || undefined}
                    className="context-option flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-start text-sm outline-none aria-disabled:cursor-default aria-disabled:opacity-50 aria-selected:bg-accent aria-selected:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => {
                      if (!choice.disabled) setActive(index);
                    }}
                    onClick={() => choose(choice)}
                    onKeyDown={pickerKeys}
                  >
                    <Icon
                      name={
                        choice.kind === "upload"
                          ? "upload"
                          : choice.kind === "library"
                            ? "memory"
                            : choice.kind === "command"
                              ? "collapse"
                              : choice.kind === "skill"
                                ? "sparkle"
                                : choice.kind === "connector"
                                  ? "globe"
                                  : choice.kind === "page"
                                    ? "page"
                                    : "chat"
                      }
                      size={18}
                    />
                    <span className="min-w-0">
                      <strong className="block break-words font-medium">{choice.label}</strong>
                      <small className="mt-0.5 block break-words text-xs text-muted-foreground">{choice.detail}</small>
                    </span>
                  </button>
                </div>
              ))}
              {!choices.length && (
                <p className="px-3 py-3 text-center text-sm text-muted-foreground">
                  {picker.source === "slash" ? "No matching skills." : "No matching connectors, chats or pages."}
                </p>
              )}
            </div>
            {loading && picker.source !== "slash" && (
              <p role="status" className="px-3 py-1.5 text-sm text-muted-foreground">
                Loading connectors…
              </p>
            )}
            {skillsLoading && picker.source === "slash" && (
              <p role="status" className="px-3 py-1.5 text-sm text-muted-foreground">
                Loading skills…
              </p>
            )}
            {skillsError && picker.source === "slash" && (
              <p role="alert" className="px-3 py-1.5 text-sm text-destructive">
                Skills: {skillsError}
              </p>
            )}
            {connectorError && picker.source !== "slash" && (
              <p role="alert" className="px-3 py-1.5 text-sm text-destructive">
                Connectors: {connectorError}{" "}
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="h-auto p-0 text-sm"
                  onClick={() => {
                    close();
                  }}
                >
                  Close
                </Button>
              </p>
            )}
          </div>
        )}
        {selectedSkills.length > 0 && (
          <ul
            className="composer-skills m-0 mb-1.5 flex list-none flex-wrap gap-1.5 p-0 px-1"
            aria-label="Skills for this message"
          >
            {selectedSkills.map((s) => (
              <li
                key={s.id}
                className={cn(
                  "inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-sm",
                  s.unavailable && "border-destructive/50 text-destructive",
                )}
              >
                <Icon name="sparkle" size={14} />
                <span className="min-w-0 truncate" title={`${s.name} · version ${s.version}`}>
                  {s.name}
                </span>
                {s.unavailable && <span className="text-xs">unavailable</span>}
                <button
                  type="button"
                  className="-me-1 inline-grid size-5 place-items-center rounded-full hover:bg-foreground/10"
                  aria-label={`Remove skill ${s.name}`}
                  onClick={() => {
                    setSelectedSkills((items) => items.filter((c) => c.id !== s.id));
                    ref.current?.focus();
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          ref={uploadRef}
          type="file"
          multiple
          hidden
          aria-label="Upload attachments"
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
            ref.current?.focus();
          }}
        />
        {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: Clicking the empty padding focuses the textarea, which keyboard users reach directly. */}
        <div
          className={cn(
            "composer-box grid cursor-text grid-cols-[36px_minmax(0,1fr)_auto] gap-x-2 rounded-3xl border border-control-border bg-card p-2 max-md:grid-cols-[44px_minmax(0,1fr)_auto] transition-[border-color,box-shadow] duration-150 has-[textarea:focus-visible]:border-ring has-[textarea:focus-visible]:ring-3 has-[textarea:focus-visible]:ring-ring/30",
            files.length > 0 && "has-attachments",
          )}
          onClick={(e) => {
            if (e.target === e.currentTarget) ref.current?.focus();
          }}
        >
          <DraftAttachments
            files={files}
            onPreview={setPreview}
            onRemove={removeFile}
            onRetry={retryFile}
            onInsert={(f) => {
              insertText(f.pastedText!);
              removeFile(f.key);
            }}
          />
          <Tip label="Add attachments and context">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="composer-add z-2 col-start-1 row-start-2 self-end text-muted-foreground max-md:size-11"
              aria-label="Add attachments and context"
              aria-expanded={open}
              aria-controls={menuId}
              onClick={() => {
                const el = ref.current;
                const start = el?.selectionStart ?? text.length;
                const end = el?.selectionEnd ?? start;
                savedSelection.current = { start, end };
                if (picker) close();
                else {
                  setPicker({ start, end, query: "", source: "plus" });
                  setActive(null);
                }
              }}
            >
              <Icon name="plus" />
            </Button>
          </Tip>
          <label htmlFor="composer-input" className="sr-only">
            Message
          </label>
          <div
            className={cn(
              "composer-editor relative row-start-2 min-w-0 self-center transition-[margin,padding] duration-[280ms] ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none",
              files.length > 0 ? "col-span-full mx-2 pb-11 max-md:pb-13" : "col-start-2",
            )}
          >
            <div
              className="mention-highlight pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words py-1.5 font-[inherit] text-base leading-6 text-transparent [&_mark]:rounded-sm [&_mark]:bg-foreground/10 [&_mark]:text-transparent"
              ref={highlightRef}
              aria-hidden="true"
            >
              <DraftHighlight text={text} mentions={mentions} />
            </div>
            <textarea
              id="composer-input"
              ref={ref}
              rows={1}
              className={cn(
                "relative z-1 block max-h-[40vh] w-full min-w-0 resize-none border-0 bg-transparent py-1.5 text-base leading-6 outline-none transition-[min-height] duration-[280ms] ease-[cubic-bezier(.22,1,.36,1)] placeholder:text-muted-foreground motion-reduce:transition-none",
                files.length > 0 ? "min-h-12" : "min-h-9",
              )}
              disabled={!restored}
              value={text}
              placeholder={placeholder}
              onChange={(e) => {
                const next = changedDraft(text, mentions, e.target.value);
                setText(next.text);
                setMentions(next.mentions);
                const cursor = next.text === e.target.value ? e.target.selectionStart : next.cursor;
                savedSelection.current = { start: cursor, end: cursor };
                if (next.text !== e.target.value) restoreCursor.current = cursor;
                const composing = (e.nativeEvent as InputEvent).isComposing === true;
                const slash = slashQuery(next.text, cursor, composing);
                const query = mentionQuery(next.text, cursor);
                if (slash && !next.mentions.some((m) => slash.start < m.end && slash.end > m.start)) {
                  setPicker({ ...slash, source: "slash" });
                  setActive(null);
                } else if (query && !next.mentions.some((m) => query.start >= m.start && query.start < m.end)) {
                  setPicker({ ...query, end: cursor, source: "at" });
                  setActive(null);
                } else setPicker(null);
              }}
              onScroll={(e) => {
                if (highlightRef.current) {
                  highlightRef.current.scrollTop = e.currentTarget.scrollTop;
                  highlightRef.current.scrollLeft = e.currentTarget.scrollLeft;
                }
              }}
              onSelect={(e) => {
                const el = e.currentTarget;
                let start = el.selectionStart,
                  end = el.selectionEnd;
                for (const m of mentions) {
                  if (start === end && start > m.start && start < m.end) {
                    start = end = start - m.start < m.end - start ? m.start : m.end;
                    break;
                  }
                  if (start < end) {
                    if (start > m.start && start < m.end) start = m.start;
                    if (end > m.start && end < m.end) end = m.end;
                  }
                }
                if (start !== el.selectionStart || end !== el.selectionEnd) el.setSelectionRange(start, end);
                savedSelection.current = { start, end };
                // Moving the caret out of the slash word closes the `/` list.
                if (picker?.source === "slash" && !slashQuery(text, end)) setPicker(null);
              }}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const clipboardFiles = Array.from(e.clipboardData.files);
                if (clipboardFiles.length) {
                  e.preventDefault();
                  addFiles(clipboardFiles);
                  return;
                }
                const pasted = e.clipboardData.getData("text/plain");
                if (isLargePaste(pasted)) {
                  e.preventDefault();
                  const name = pastedFileName(
                    new Date(),
                    filesRef.current.map((f) => f.file.name),
                  );
                  addFiles([new File([pasted], name, { type: "text/plain" })], pasted);
                  setNotice("Large paste added as text file");
                  setPicker(null);
                } else if (pasted) {
                  e.preventDefault();
                  insertText(pasted);
                }
              }}
              aria-autocomplete="list"
              aria-controls={picker?.source === "at" || picker?.source === "slash" ? menuId : undefined}
              aria-haspopup="listbox"
              aria-activedescendant={
                (picker?.source === "at" || picker?.source === "slash") && choices[active]
                  ? `${menuId}-${active}`
                  : undefined
              }
              enterKeyHint="send"
            />
          </div>
          <div className="composer-actions z-2 col-start-3 row-start-2 self-end">
            <Tip label={running ? "Stop" : "Send"}>
              <Button
                type={running ? "button" : "submit"}
                variant={running ? "outline" : "default"}
                size="icon"
                className="max-md:size-11"
                onClick={running ? onStop : undefined}
                disabled={running ? stopping : empty || blocked || sending || sendReason !== ""}
                aria-label={running ? "Stop" : "Send message"}
                aria-describedby={running ? stopDescriptionId : sendDescriptionId}
              >
                <Icon name={running ? "stop" : "send"} />
              </Button>
            </Tip>
          </div>
        </div>
        <div className="composer-toolbar mt-1 flex min-h-8 flex-wrap items-center justify-end gap-0.5 text-muted-foreground">
          {settings}
          <ContextUsage api={api} sessionId={sessionId} revision={contextRevision} running={running} />
        </div>
        {compaction && (
          <p className="composer-compaction mx-3 mt-1.5 text-xs text-muted-foreground" role="status">
            {COMPACTION_TEXT[compaction.status] ?? "Compacting the conversation…"}
          </p>
        )}
        {sendReason && !compacting && (
          <p id={`${menuId}-reason`} className="composer-reason mx-3 mt-1.5 text-xs text-muted-foreground">
            {sendReason}
          </p>
        )}
        {running && !empty && !sendReason && (
          <p className="composer-busy-hint mx-3 mt-1.5 text-xs text-muted-foreground">
            {whenBusy === "steer"
              ? "Enter steers the reply · Alt+Enter queues it for after"
              : "Enter queues it for after the reply · Alt+Enter steers the reply"}
          </p>
        )}
        {running && hasQueuedMessages && (
          <p id={`${menuId}-stop`} className="mx-3 mt-1.5 text-xs text-muted-foreground">
            Stop also cancels messages still waiting.
          </p>
        )}
        {compacting && (
          <p id={`${menuId}-reason`} className="sr-only">
            {sendReason}
          </p>
        )}
        {notice && (
          <p className="composer-notice mx-3 mt-1.5 text-xs text-muted-foreground" role="status">
            {notice}
          </p>
        )}
      </div>
      {libraryPicker && api && (
        <LibraryPicker
          api={api}
          excluded={files.flatMap((f) => (f.attachment ? [f.attachment.id] : []))}
          onClose={() => setLibraryPicker(false)}
          onChoose={(chosen) => {
            const next = [...filesRef.current];
            for (const a of chosen) {
              const error = attachmentLimit(
                a,
                next.map((f) => ({ size: f.attachment?.size ?? f.file.size })),
              );
              if (error) {
                setNotice(error);
                break;
              }
              next.push({
                key: crypto.randomUUID(),
                library: true,
                file: new File([], a.name, { type: a.mediaType }),
                attachment: a,
                status: "ready",
              });
            }
            filesRef.current = next;
            setFiles(next);
            setLibraryPicker(false);
          }}
        />
      )}
      {preview && sessionId && (
        <FilePreview
          key={`${sessionId}:${preview.id}`}
          sessionId={sessionId}
          file={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </form>
  );
}

function DraftHighlight({ text, mentions }: { text: string; mentions: MessageMention[] }) {
  let cursor = 0;
  const parts = [];
  for (const m of mentions) {
    parts.push(<span key={`t${m.start}`}>{text.slice(cursor, m.start)}</span>);
    parts.push(<mark key={`m${m.start}`}>{text.slice(m.start, m.end)}</mark>);
    cursor = m.end;
  }
  parts.push(
    <span key="tail">
      {text.slice(cursor)}
      {text.endsWith("\n") ? " " : ""}
    </span>,
  );
  return <>{parts}</>;
}
