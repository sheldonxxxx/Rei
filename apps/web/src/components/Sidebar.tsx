import type { Agent, Session } from "@rei/protocol";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/primitives/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/primitives/dropdown-menu.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { cn } from "@/lib/utils.ts";
import { describeError } from "../api/client.ts";
import { approvalGroups } from "../lib/approvals.ts";
import { APP_VERSION } from "../lib/brand.ts";
import { effectiveStatus } from "../lib/policy.ts";
import { SETTINGS_PATH } from "../lib/route.ts";
import { dateGroup } from "../lib/time.ts";
import { useNow } from "../lib/useNow.ts";
import type { GlobalState } from "../state/global.ts";
import { selectActiveAgentId, selectPendingTakeovers, selectSessions } from "../state/global.ts";
import { Avatar } from "./Avatar.tsx";
import { ConfirmDialog, DialogError } from "./dialogParts.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { ReiWordmark } from "./ReiWordmark.tsx";
import { StatusDot } from "./StatusDot.tsx";
import { Tip } from "./Tip.tsx";

interface Props {
  global: GlobalState;
  pagination?: { loading: boolean; more: boolean; error: string; load: () => void };
  selectedId: string | null;
  /** The agent whose chats are listed. Defaults to the open chat's agent, else the default agent. */
  activeAgentId?: string | null;
  /** The Settings window is open. */
  settingsOpen?: boolean;
  libraryOpen?: boolean;
  knowledgeOpen?: boolean;
  backgroundOpen?: boolean;
  creating: boolean;
  /** Starts a chat with the listed agent (the active one). */
  onNewChat: () => void;
  /** The "Hidden trigger sessions" filter: also list trigger runs configured to hide from the chat list. */
  showTriggers?: boolean;
  onShowTriggersChange?: (show: boolean) => void;
  onRenameSession?: (sessionId: string, title: string) => Promise<void>;
  onDeleteSession?: (sessionId: string) => Promise<void>;
  onPinSession?: (sessionId: string, pinned: boolean) => Promise<void>;
  onSearch?: () => void;
  /** Open the dialog that makes a new agent. */
  onNewAgent?: () => void;
  /** Wide screens: the sidebar is folded away (the main area takes its width). Ignored on a phone, where the sidebar is its own screen. */
  collapsed?: boolean;
  onCollapse?: () => void;
}

export const SIDEBAR_SHORTCUT = "Ctrl+\\";

/** A row in a sidebar-style list (the current one is `aria-current="page"`). Phones get the taller touch target. */
export const ROW_CLASS =
  "flex h-9 w-full min-w-0 items-center gap-2.5 rounded-xl px-3 text-start text-sm text-sidebar-foreground no-underline outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-sidebar-ring/40 aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground max-md:min-h-11 max-md:text-base";
const SECTION_LABEL = "px-2.5 pb-1.5 pt-6 text-xs font-medium text-muted-foreground";

export function Sidebar({
  pagination,
  global,
  selectedId,
  activeAgentId: activeProp,
  settingsOpen = false,
  libraryOpen = false,
  knowledgeOpen = false,
  backgroundOpen = false,
  creating,
  onNewChat,
  showTriggers = false,
  onShowTriggersChange,
  onRenameSession,
  onDeleteSession,
  onPinSession,
  onSearch,
  onNewAgent,
  collapsed = false,
  onCollapse,
}: Props) {
  const activeAgentId = activeProp === undefined ? selectActiveAgentId(global, selectedId) : activeProp;
  const _activeAgent = global.agents.find((a) => a.id === activeAgentId);
  // Only the active agent's chats; what waits for you (below) stays across every agent.
  const sessions = selectSessions(global, activeAgentId, selectedId, showTriggers).filter(
    (s) => !global.sidebarSessionIds || global.sidebarSessionIds.includes(s.id) || s.id === selectedId,
  );
  const [dialog, setDialog] = useState<{ kind: "rename" | "delete"; session: Session } | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const renameInput = useRef<HTMLInputElement>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pinningId, setPinningId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pagination?.more || pagination.loading || pagination.error || !sentinelRef.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) pagination.load();
      },
      { root: scrollRef.current, rootMargin: "240px" },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [pagination?.more, pagination?.loading, pagination?.error, pagination?.load]);
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 });
  }, [activeAgentId]);
  const now = useNow();
  const takeovers = selectPendingTakeovers(global);
  const readGroups = approvalGroups(global.approvals);
  const requests = global.approvals.filter((a) => !a.groupId || readGroups.get(a.groupId)?.[0]?.id === a.id);
  const waitingCount = requests.length + takeovers.length;
  const homeOf = (a: Agent): Session | undefined => global.sessions.find((s) => s.id === a.homeSessionId);

  const pinned = sessions.filter((s) => s.pinned);
  const regularSessions = sessions.filter((s) => !s.pinned);
  // Sessions arrive newest first; cut them into Today / Yesterday / ... runs.
  const groups: { label: string; sessions: Session[] }[] = [];
  for (const s of regularSessions) {
    const label = dateGroup(s.updatedAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.sessions.push(s);
    else groups.push({ label, sessions: [s] });
  }

  async function saveRename(title: string) {
    if (!dialog || dialog.kind !== "rename" || !onRenameSession) return;
    setDialogBusy(true);
    setDialogError(null);
    try {
      await onRenameSession(dialog.session.id, title);
      setDialog(null);
    } catch (e) {
      setDialogError(describeError(e));
    } finally {
      setDialogBusy(false);
    }
  }

  async function confirmDelete() {
    if (!dialog || dialog.kind !== "delete" || !onDeleteSession) return;
    setDialogBusy(true);
    setDialogError(null);
    try {
      await onDeleteSession(dialog.session.id);
      setDialog(null);
    } catch (e) {
      setDialogError(describeError(e));
    } finally {
      setDialogBusy(false);
    }
  }

  function togglePin(session: Session) {
    if (!onPinSession) return;
    setPinningId(session.id);
    setActionError(null);
    void onPinSession(session.id, !session.pinned)
      .catch((e) => setActionError(describeError(e)))
      .finally(() => setPinningId(null));
  }

  function sessionRow(s: Session) {
    return (
      <li key={s.id} className="group/session relative" data-enter="rise">
        <a
          href={`/s/${encodeURIComponent(s.id)}`}
          className={cn(ROW_CLASS, "pr-16")}
          aria-current={selectedId === s.id ? "page" : undefined}
        >
          {s.origin === "spawned" && (
            <span className="row-kind inline-grid shrink-0 place-items-center text-muted-foreground" aria-hidden="true">
              <Icon name="spawned" size={14} />
            </span>
          )}
          {s.origin === "trigger" && (
            <span className="row-kind inline-grid shrink-0 place-items-center text-muted-foreground" aria-hidden="true">
              <Icon name="clock" size={14} />
            </span>
          )}
          {s.origin === "fork" && (
            <span className="row-kind inline-grid shrink-0 place-items-center text-muted-foreground" aria-hidden="true">
              <Icon name="branch" size={14} />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate">{s.title}</span>
          {s.unread > 0 && s.id !== selectedId && <UnreadDot count={s.unread} />}
          <StatusDot status={effectiveStatus(s)} tip={false} />
        </a>
        <div className="absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground opacity-0 group-hover/session:opacity-100 group-focus-within/session:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
                aria-label={`Actions for ${s.title}`}
                disabled={pinningId === s.id}
              >
                <Icon name="more" size={18} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48" aria-label={`Actions for ${s.title}`}>
              <DropdownMenuItem
                onSelect={() => {
                  setDialogError(null);
                  setRenameTitle(s.title);
                  setDialog({ kind: "rename", session: s });
                }}
              >
                <Icon name="edit" size={16} /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => togglePin(s)}>
                <Icon name="pin" size={16} /> {s.pinned ? "Unpin" : "Pin"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  setDialogError(null);
                  setDialog({ kind: "delete", session: s });
                }}
              >
                <Icon name="trash" size={16} /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {s.pinned && (
            <span
              className="inline-grid size-8 place-items-center text-muted-foreground"
              aria-label="Pinned"
              title="Pinned"
            >
              <Icon name="pin" size={15} />
            </span>
          )}
        </div>
      </li>
    );
  }

  if (collapsed && onCollapse) {
    return (
      <SidebarRail
        onExpand={onCollapse}
        libraryOpen={libraryOpen}
        knowledgeOpen={knowledgeOpen}
        backgroundOpen={backgroundOpen}
        settingsOpen={settingsOpen}
        agents={global.agents}
        selectedId={selectedId}
      />
    );
  }

  return (
    <nav
      className="sidebar flex min-h-0 flex-col border-r border-sidebar-border bg-sidebar pt-[var(--safe-t)] text-sidebar-foreground max-md:border-r-0 md:min-w-0 md:overflow-hidden md:[&>*:not(a)]:min-w-[calc(var(--navigation-width)-1px)]"
      aria-label="Chats"
    >
      <div className="sidebar-head flex min-h-16 items-center gap-1 px-3.5 py-3">
        <div className="mr-auto">
          <ReiWordmark />
        </div>
        {onSearch && (
          <Tip label="Search" shortcut="Ctrl+K">
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground max-md:size-11"
              aria-label="Search"
              aria-keyshortcuts="Control+K Meta+K"
              onClick={onSearch}
            >
              <Icon name="search" />
            </Button>
          </Tip>
        )}
        {onCollapse && (
          <Tip label="Minimize sidebar" shortcut={SIDEBAR_SHORTCUT}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="sidebar-collapse text-muted-foreground max-md:hidden"
              aria-label="Minimize sidebar"
              aria-keyshortcuts="Control+\ Meta+\"
              data-sidebar-hide
              onClick={onCollapse}
            >
              <Icon name="sidebar" />
            </Button>
          </Tip>
        )}
      </div>

      <div className="px-3.5 pb-4 pt-1">
        <Button
          type="button"
          className="w-full justify-start gap-2.5 px-3 max-md:h-11"
          disabled={creating || !global.ready}
          onClick={onNewChat}
        >
          <Icon name="compose" />
          New chat
        </Button>
      </div>
      <a
        className={cn("sidebar-library", ROW_CLASS, "mx-2.5 mb-1 w-auto")}
        href="/library"
        aria-current={libraryOpen ? "page" : undefined}
      >
        <Icon name="library" size={18} />
        Library
      </a>
      <a
        className={cn("sidebar-knowledge", ROW_CLASS, "mx-2.5 mb-1 w-auto")}
        href="/knowledge"
        aria-current={knowledgeOpen ? "page" : undefined}
      >
        <Icon name="knowledge" size={18} />
        Knowledge
      </a>
      <a
        className={cn(ROW_CLASS, "mx-2.5 mb-1 w-auto")}
        href="/background"
        aria-current={backgroundOpen ? "page" : undefined}
      >
        <Icon name="activity" size={18} />
        Background Activity
      </a>
      <div ref={scrollRef} className="sidebar-scroll flex-1 overflow-y-auto px-2.5 pb-4 pt-2 [scrollbar-width:thin]">
        {waitingCount > 0 && (
          <section className="waiting mb-1 border-b border-sidebar-border pb-1.5" aria-label="Waiting for you">
            <h2 className={cn(SECTION_LABEL, "flex items-center gap-1.5 pt-2 text-attention-text")}>
              Waiting for you{" "}
              <Badge className="h-[18px] min-w-[18px] bg-attention-text px-1.5 text-[0.6875rem] font-bold text-background">
                {waitingCount}
              </Badge>
            </h2>
            <ul className="flex flex-col gap-0.5">
              {requests.map((a) => {
                const title = global.sessions.find((x) => x.id === a.sessionId)?.title ?? a.sessionTitle;
                const group = a.groupId ? readGroups.get(a.groupId) : undefined;
                return (
                  <li key={a.groupId ?? a.id}>
                    <a
                      href={`/s/${encodeURIComponent(a.sessionId)}`}
                      className={WAIT_ROW}
                      aria-current={selectedId === a.sessionId ? "page" : undefined}
                    >
                      <span className="mt-0.5 inline-grid shrink-0 text-attention-text" aria-hidden="true">
                        <Icon name="shield" size={16} />
                      </span>
                      <WaitText
                        title={title}
                        summary={group && group.length > 1 ? `${group.length} connector reads` : a.summary}
                      />
                    </a>
                  </li>
                );
              })}
              {takeovers.map((t) => {
                const title = global.sessions.find((x) => x.id === t.sessionId)?.title ?? "A chat";
                return (
                  <li key={t.id}>
                    <a
                      href={`/s/${encodeURIComponent(t.sessionId)}`}
                      className={WAIT_ROW}
                      aria-current={selectedId === t.sessionId ? "page" : undefined}
                    >
                      <span className="mt-0.5 inline-grid shrink-0 text-attention-text" aria-hidden="true">
                        <Icon name="pointer" size={16} />
                      </span>
                      <WaitText
                        title={title}
                        summary={t.reason ? `Needs you in the browser: ${t.reason}` : "Needs you in the browser"}
                      />
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {onNewAgent && global.agents.length > 0 && (
          <div className="agents-head flex items-center justify-between pr-1">
            <h2 className={cn(SECTION_LABEL, "pb-0.5 pt-2")}>Agents</h2>
            <Tip label="New agent">
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                aria-label="New agent"
                onClick={onNewAgent}
              >
                <Icon name="plus" />
              </Button>
            </Tip>
          </div>
        )}
        {global.agents.length > 0 && (
          <ul className="agents mb-2 flex flex-col gap-0.5 border-b border-sidebar-border pb-3" aria-label="Agents">
            {global.agents.map((a) => {
              const s = homeOf(a);
              // "page" when its home chat is open; "true" when it is the agent whose chats are listed below.
              const current =
                knowledgeOpen || backgroundOpen
                  ? undefined
                  : selectedId === a.homeSessionId
                    ? "page"
                    : a.id === activeAgentId
                      ? "true"
                      : undefined;
              return (
                <li key={a.id}>
                  <a
                    href={`/s/${encodeURIComponent(a.homeSessionId)}`}
                    className={cn(
                      "agent-row",
                      ROW_CLASS,
                      "h-10 pl-2 font-medium aria-[current=true]:bg-sidebar-accent",
                    )}
                    aria-current={current}
                  >
                    <Avatar value={a.avatar} size={28} />
                    <span className="min-w-0 flex-1 truncate">{a.name}</span>
                    {s && s.unread > 0 && s.id !== selectedId && <UnreadDot count={s.unread} />}
                    {s && <StatusDot status={effectiveStatus(s)} />}
                  </a>
                </li>
              );
            })}
          </ul>
        )}

        <div className="chats-head flex items-center justify-between pr-1">
          <h2 className={cn(SECTION_LABEL, "pb-0.5 pt-2")}>Chats</h2>
          <div className="flex items-center">
            <DropdownMenu>
              <Tip label="Filter chats">
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className={cn("chats-filter text-muted-foreground", showTriggers && "text-foreground")}
                    aria-label="Filter chats"
                    data-active={showTriggers || undefined}
                  >
                    <Icon name="filter" />
                  </Button>
                </DropdownMenuTrigger>
              </Tip>
              <DropdownMenuContent align="end" className="w-56" aria-label="Filter chats">
                <DropdownMenuCheckboxItem
                  checked={showTriggers}
                  onCheckedChange={(checked) => onShowTriggersChange?.(checked === true)}
                >
                  Hidden trigger sessions
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {actionError && (
          <p role="alert" className="mx-2.5 my-2 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
            {actionError}
          </p>
        )}
        {global.ready && sessions.length === 0 && !pagination?.loading && !pagination?.more ? (
          <p className="empty-hint px-2.5 py-6 text-sm text-muted-foreground">No chats yet. Start a chat to begin.</p>
        ) : (
          <>
            {pinned.length > 0 && (
              <section aria-label="Pinned">
                <h2 className={SECTION_LABEL}>Pinned</h2>
                <ul className="flex flex-col gap-0.5">{pinned.map(sessionRow)}</ul>
              </section>
            )}
            {groups.map((g) => (
              <section key={g.label} aria-label={g.label}>
                <h2 className={SECTION_LABEL}>{g.label}</h2>
                <ul className="flex flex-col gap-0.5">{g.sessions.map(sessionRow)}</ul>
              </section>
            ))}
          </>
        )}
        {pagination && (
          <div ref={sentinelRef} className="sidebar-page-tail" aria-busy={pagination.loading}>
            <div
              className="sidebar-page-loading"
              data-loading={pagination.loading || undefined}
              aria-hidden={!pagination.loading}
            >
              <span className="sr-only" role="status">
                Loading chats…
              </span>
              {[0, 1, 2].map((n) => (
                <div key={n} className="sidebar-chat-skeleton" style={{ width: `${86 - n * 14}%` }} />
              ))}
            </div>
            {pagination.error && (
              <div className="px-2 py-3 text-sm text-muted-foreground" role="alert">
                <p>{pagination.error}</p>
                <Button variant="ghost" size="sm" onClick={pagination.load}>
                  Retry
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="sidebar-foot flex items-center gap-2 border-t border-sidebar-border px-2.5 pb-[calc(0.75rem+var(--safe-b))] pt-2.5">
        <a
          href={SETTINGS_PATH}
          className={cn("settings-row", ROW_CLASS)}
          aria-current={settingsOpen ? "page" : undefined}
        >
          <Icon name="settings" size={18} />
          <span className="min-w-0 flex-1 truncate">Settings</span>
        </a>
        <span className="shrink-0 pr-2 text-xs tabular-nums text-muted-foreground">
          <span className="sr-only">Version </span>v{APP_VERSION}
        </span>
      </div>
      {dialog?.kind === "rename" && (
        <Dialog open onOpenChange={(open) => !open && !dialogBusy && setDialog(null)}>
          <DialogContent
            showCloseButton={false}
            aria-describedby={undefined}
            onEscapeKeyDown={(e) => dialogBusy && e.preventDefault()}
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              renameInput.current?.focus();
              renameInput.current?.select();
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename chat</DialogTitle>
            </DialogHeader>
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void saveRename(renameTitle.replace(/\s+/g, " ").trim());
              }}
            >
              <Input
                ref={renameInput}
                aria-label="Chat name"
                value={renameTitle}
                maxLength={80}
                autoComplete="off"
                disabled={dialogBusy}
                onChange={(e) => setRenameTitle(e.target.value)}
              />
              {dialogError && <DialogError>{dialogError}</DialogError>}
              <DialogFooter>
                <Button type="button" variant="outline" disabled={dialogBusy} onClick={() => setDialog(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={dialogBusy || !renameTitle.trim()}>
                  {dialogBusy ? "Saving…" : "Save"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title="Delete this chat?"
          description={<p>“{dialog.session.title}” and its messages will be removed. This can't be undone.</p>}
          error={dialogError}
          busy={dialogBusy}
          confirmLabel="Delete"
          busyLabel="Deleting…"
          onCancel={() => setDialog(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </nav>
  );
}

/** Wide screens, minimized: a narrow strip down the left edge with the expand button and the four icons that matter most. */
function SidebarRail({
  onExpand,
  libraryOpen,
  knowledgeOpen,
  backgroundOpen,
  settingsOpen,
  agents,
  selectedId,
}: {
  onExpand: () => void;
  libraryOpen: boolean;
  knowledgeOpen: boolean;
  backgroundOpen: boolean;
  settingsOpen: boolean;
  agents: Agent[];
  selectedId: string | null;
}) {
  return (
    <nav
      className="sidebar sidebar-rail flex min-h-0 flex-col items-center gap-1 border-r border-sidebar-border bg-sidebar px-2 pb-[calc(0.75rem+var(--safe-b))] pt-[calc(0.75rem+var(--safe-t))] text-sidebar-foreground"
      aria-label="Chats"
    >
      <Tip side="right" label="Expand sidebar" shortcut={SIDEBAR_SHORTCUT}>
        <Button
          variant="ghost"
          size="icon-sm"
          className="sidebar-expand text-muted-foreground"
          aria-label="Expand sidebar"
          aria-keyshortcuts="Control+\ Meta+\"
          data-sidebar-show
          onClick={onExpand}
        >
          <Icon name="sidebar" />
        </Button>
      </Tip>
      <div className="mt-3 flex flex-col items-center gap-1">
        <RailLink href="/library" label="Library" icon="library" current={libraryOpen} />
        <RailLink href="/knowledge" label="Knowledge" icon="knowledge" current={knowledgeOpen} />
        <RailLink href="/background" label="Background Activity" icon="activity" current={backgroundOpen} />
        {agents.map((a) => (
          <Tip key={a.id} side="right" label={a.name}>
            <a
              href={`/s/${encodeURIComponent(a.homeSessionId)}`}
              aria-label={a.name}
              aria-current={selectedId === a.homeSessionId ? "page" : undefined}
              className="sidebar-rail-agent grid size-8 place-items-center rounded-lg outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-sidebar-ring/40 aria-[current=page]:bg-sidebar-accent"
            >
              <Avatar value={a.avatar} size={24} />
            </a>
          </Tip>
        ))}
      </div>
      <div className="mt-auto">
        <RailLink href={SETTINGS_PATH} label="Settings" icon="settings" current={settingsOpen} />
      </div>
    </nav>
  );
}

function RailLink({ href, label, icon, current }: { href: string; label: string; icon: IconName; current: boolean }) {
  return (
    <Tip side="right" label={label}>
      <a
        href={href}
        aria-label={label}
        aria-current={current ? "page" : undefined}
        className="grid size-8 place-items-center rounded-lg text-sidebar-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-sidebar-ring/40 aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground"
      >
        <Icon name={icon} size={18} />
      </a>
    </Tip>
  );
}

const WAIT_ROW = cn(
  "wait-row",
  ROW_CLASS,
  "h-auto items-start bg-attention-soft py-2 hover:bg-attention-soft hover:underline",
);

function WaitText({ title, summary }: { title: string; summary: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate font-medium">{title}</span>
      <span className="truncate text-[0.8125rem] font-normal text-muted-foreground">{summary}</span>
    </span>
  );
}

const unreadLabel = (n: number) => (n === 1 ? "1 unread message" : `${n} unread messages`);

/** New agent messages since the read marker every device shares; it clears live when any device reads them. */
function UnreadDot({ count }: { count: number }) {
  return (
    <span
      className="unread-dot inline-block size-2 shrink-0 rounded-full bg-primary"
      role="img"
      aria-label={unreadLabel(count)}
    />
  );
}
