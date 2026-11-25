import type { Attachment } from "@rei/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Api } from "./api/client.ts";
import { ApiError, createApi, describeError } from "./api/client.ts";
import { BackgroundActivity } from "./components/BackgroundActivity.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { FirstTimeSetupDialog } from "./components/FirstTimeSetupDialog.tsx";
import { NewAgentDialog } from "./components/full/NewAgentDialog.tsx";
import { HistorySearchDialog } from "./components/HistorySearch.tsx";
import { KnowledgePage } from "./components/KnowledgePage.tsx";
import { LibraryContext } from "./components/LibraryContext.tsx";
import { LibraryPage } from "./components/LibraryPage.tsx";
import { LoginForm } from "./components/LoginForm.tsx";
import { SettingsWindow } from "./components/SettingsWindow.tsx";
import { AuthCard, SetupFlow } from "./components/SetupFlow.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { saveBrowserTimeZoneIfUnset } from "./components/TimeZoneSetting.tsx";
import { APP_TITLE } from "./lib/brand.ts";
import { saveComposerDraft } from "./lib/composerDraft.ts";
import { ConnectorNamesContext } from "./lib/connectors.tsx";
import { FULL_MODE_KEY, FullModeContext } from "./lib/fullMode.tsx";
import { startPresence } from "./lib/presence.ts";
import { useMediaQuery, useRoute } from "./lib/route.ts";
import { clearSessionFlag, FIRST_TIME_SETUP_SESSION_KEY, useStoredFlag } from "./lib/storage.ts";
import { useSessionPages } from "./lib/useSessionPages.ts";
import { selectActiveAgentId, selectSessions } from "./state/global.ts";
import { useGlobalStream } from "./stream/hooks.ts";

const SIDEBAR_KEY = "rei:sidebar-folded";

type Phase = "loading" | "setup" | "login" | "ready" | "unreachable";

export function App() {
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [passkeys, setPasskeys] = useState(false);
  const [phase, setPhase] = useState<Phase>("loading");
  const [generation, setGeneration] = useState(0);

  // Any 401 from the API drops back to the login screen.
  const onUnauthorized = useCallback(() => {
    clearSessionFlag(FIRST_TIME_SETUP_SESSION_KEY);
    setPhase("loading");
    setGeneration((g) => g + 1);
  }, []);
  const api = useMemo(() => createApi({ onUnauthorized }), [onUnauthorized]);

  const refresh = useCallback(async () => {
    try {
      const s = await api.getAuthState();
      if (!s.signedIn) clearSessionFlag(FIRST_TIME_SETUP_SESSION_KEY);
      setTotpEnabled(s.totpEnabled);
      setPasskeys(s.passkeys === true);
      setPhase(s.setupRequired ? "setup" : s.signedIn ? "ready" : "login");
    } catch {
      setPhase("unreachable");
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh, generation]);

  if (phase === "loading") {
    return (
      <main className="auth">
        <span className="spinner" role="status" aria-label="Loading" />
      </main>
    );
  }
  if (phase === "unreachable") {
    return (
      <AuthCard title="Can't reach the server" subtitle="Check your connection and try again.">
        <button type="button" className="btn primary" onClick={() => void refresh()}>
          Retry
        </button>
      </AuthCard>
    );
  }
  if (phase === "setup")
    return <SetupFlow api={api} onDone={() => void refresh()} onAlreadySetUp={() => void refresh()} />;
  if (phase === "login")
    return <LoginForm api={api} totpEnabled={totpEnabled} passkeys={passkeys} onSignedIn={() => void refresh()} />;

  return (
    <Main
      key={generation}
      api={api}
      onUnauthorized={onUnauthorized}
      onLoggedOut={() => {
        clearSessionFlag(FIRST_TIME_SETUP_SESSION_KEY);
        setGeneration((g) => g + 1);
        setPhase("loading");
      }}
    />
  );
}

export function Main({
  api,
  onUnauthorized,
  onLoggedOut,
}: {
  api: Api;
  onUnauthorized: () => void;
  onLoggedOut: () => void;
}) {
  const { state: global, memoryRev, pageRev, hydrateSessions } = useGlobalStream(api, onUnauthorized);
  useEffect(() => startPresence((report) => api.postPresence(report)), [api]);
  // The first open saves this browser's time zone, until the user chooses another in Settings > General.
  useEffect(() => {
    void saveBrowserTimeZoneIfUnset(api);
  }, [api]);
  const {
    sessionId,
    messageId,
    settings,
    library,
    libraryFileId,
    knowledge,
    knowledgePageId,
    background,
    backgroundRoute,
    go,
  } = useRoute();
  const wide = useMediaQuery("(min-width: 768px)");
  const [sidebarFolded, setSidebarFolded] = useStoredFlag(SIDEBAR_KEY);
  // On a phone the sidebar is a screen of its own, so folding it away only means something on wide screens.
  const sidebarCollapsed = wide && sidebarFolded;
  const focusSidebarToggle = useRef(false);
  const toggleSidebar = useCallback(() => {
    focusSidebarToggle.current = true;
    setSidebarFolded((c) => !c);
  }, [setSidebarFolded]);
  const [full, setFull] = useStoredFlag(FULL_MODE_KEY);
  const fullMode = useMemo(() => ({ full, setFull: (next: boolean) => setFull(next) }), [full, setFull]);
  // Reloaded when Settings closes, where connectors are added, renamed and removed.
  const [connectorNames, setConnectorNames] = useState<ReadonlyMap<string, string>>(new Map());
  const settingsOpen = settings !== null;
  useEffect(() => {
    if (settingsOpen) return;
    let cancelled = false;
    api.getConnectors().then(
      (r) => !cancelled && setConnectorNames(new Map(r.connectors.map((c) => [c.id, c.name]))),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [api, settingsOpen]);
  const [creating, setCreating] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const localDeletes = useRef(new Set<string>());
  const removalHandled = useRef(new Set<string>());
  const [missingId, setMissingId] = useState<string | null>(null);

  // Settings is a window over the chat that was open before it; closing it goes back there.
  const lastChat = useRef<string | null>(null);
  if (sessionId) lastChat.current = sessionId;
  const behindId =
    sessionId ??
    (settings && lastChat.current && !global.removedSessionIds?.includes(lastChat.current) ? lastChat.current : null);
  const closeSettings = useCallback(() => go(behindId), [go, behindId]);
  // The sidebar's chat list follows this agent.
  const activeAgentId = selectActiveAgentId(global, behindId);

  // The sidebar's "Hidden trigger sessions" filter: off, hidden trigger runs stay out unless they need you or failed.
  const [showTriggers, setShowTriggers] = useState(false);
  const sessionPages = useSessionPages(
    api,
    global.ready ? activeAgentId : null,
    global.snapshotVersion,
    hydrateSessions,
    showTriggers,
  );
  // Deep links and related-chat views must work before their history page has loaded.
  useEffect(() => {
    if (!behindId || !global.ready) return;
    let cancelled = false;
    setMissingId(null);
    api.getRelatedSessions(behindId).then(
      (result) => {
        if (!cancelled) hydrateSessions(result.sessions, global.snapshotVersion, false);
      },
      (error) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) setMissingId(behindId);
        else setError(describeError(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, behindId, global.ready, global.snapshotVersion, hydrateSessions]);

  // On wide screens open the default agent's home chat when nothing is selected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the route empties, not whenever agents change.
  useEffect(() => {
    if (!wide || sessionId || settings || library || knowledge || background || !global.ready) return;
    const agent = global.agents.find((a) => a.id === global.defaultAgentId) ?? global.agents[0];
    if (agent) go(agent.homeSessionId);
  }, [wide, sessionId, settings, library, knowledge, background, global.ready]);

  // Ctrl/Cmd+\ folds the sidebar. The live browser frame owns the keyboard during a takeover, so a key typed there is left alone.
  useEffect(() => {
    if (!wide) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "\\" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest(".live-keys")) return;
      e.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wide, toggleSidebar]);

  // Ctrl/Cmd+K opens the history search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.defaultPrevented)
        return;
      if (e.target instanceof Element && e.target.closest(".live-keys")) return;
      e.preventDefault();
      setSearchOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The button that was pressed goes away with the fold (or comes back with the unfold): keep focus on its counterpart.
  useEffect(() => {
    if (!focusSidebarToggle.current) return;
    focusSidebarToggle.current = false;
    // preventScroll: the sidebar is still sliding open, and focusing its button would scroll the clipped nav sideways.
    document
      .querySelector<HTMLElement>(sidebarCollapsed ? "[data-sidebar-show]" : "[data-sidebar-hide]")
      ?.focus({ preventScroll: true });
  }, [sidebarCollapsed]);

  /** "Ask about this page": a new chat whose first message mentions the page; the agent reads its latest version. */
  async function askAboutPage(page: { id: string; title: string }, question: string, agentId: string) {
    const target = (await api.createSession({ agentId: agentId || global.defaultAgentId || undefined })).session.id;
    const label = page.title.slice(0, 240);
    const text = `@${label} ${question}`;
    await api.sendMessage(target, crypto.randomUUID(), text, {
      mentions: [{ kind: "page", id: page.id, label, start: 0, end: label.length + 1 }],
    });
    go(target);
  }
  // A new chat always belongs to the agent whose chats the sidebar lists.
  async function newChat() {
    setCreating(true);
    setError(null);
    try {
      const r = await api.createSession(activeAgentId ? { agentId: activeAgentId } : {});
      go(r.session.id);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setCreating(false);
    }
  }

  // Both streams report removals. Local actions handle navigation when the request completes.
  const handleRemoved = useCallback(
    (id: string) => {
      if (id !== sessionId || removalHandled.current.has(id) || localDeletes.current.has(id)) return;
      removalHandled.current.add(id);
      go(null);
      setNotice("Chat deleted");
    },
    [sessionId, go],
  );
  const onLocalDelete = useCallback((id: string, deleting: boolean) => {
    if (deleting) localDeletes.current.add(id);
    else localDeletes.current.delete(id);
  }, []);

  const renameSession = useCallback(
    async (id: string, title: string) => {
      await api.updateSession(id, { title });
    },
    [api],
  );
  const pinSession = useCallback(
    async (id: string, pinned: boolean) => {
      await api.updateSession(id, { pinned });
    },
    [api],
  );
  const deleteSessionFromSidebar = useCallback(
    async (id: string) => {
      const wasOpen = id === sessionId;
      if (wasOpen) onLocalDelete(id, true);
      try {
        await api.deleteSession(id);
        if (wasOpen) go(null);
      } catch (e) {
        if (wasOpen) onLocalDelete(id, false);
        throw e;
      }
    },
    [api, go, onLocalDelete, sessionId],
  );

  useEffect(() => {
    if (sessionId && global.removedSessionIds?.includes(sessionId)) handleRemoved(sessionId);
  }, [global.removedSessionIds, sessionId, handleRemoved]);

  // Keep pending approvals and takeovers visible in the browser tab.
  const waiting = global.approvals.length + global.takeovers.filter((t) => t.status === "pending").length;
  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) ${APP_TITLE}` : APP_TITLE;
  }, [waiting]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  async function logout() {
    try {
      await api.logout();
    } catch {
      // the cookie may already be gone
    }
    // The next sign-in starts at the chat list, not back in Settings or wherever this session was.
    go(null);
    onLoggedOut();
  }

  const missing = behindId !== null && missingId === behindId;

  return (
    <FullModeContext.Provider value={fullMode}>
      <ConnectorNamesContext.Provider value={connectorNames}>
        <LibraryContext.Provider
          value={{
            api,
            agents: global.agents,
            defaultAgentId: global.defaultAgentId ?? global.agents[0]?.id ?? "",
            reuse: async (file: Attachment, agentId?: string) => {
              const target = (await api.createSession({ agentId: agentId || global.defaultAgentId || undefined }))
                .session.id;
              await saveComposerDraft(target, {
                text: "",
                mentions: [],
                files: [
                  {
                    key: crypto.randomUUID(),
                    library: true,
                    file: new File([], file.name, { type: file.mediaType }),
                    attachment: file,
                    status: "ready",
                  },
                ],
              });
              go(target);
            },
            ask: async (file: Attachment, question: string, sourceSession?: string, agentId?: string) => {
              const target =
                sourceSession ??
                (await api.createSession({ agentId: agentId || global.defaultAgentId || undefined })).session.id;
              await api.sendMessage(target, crypto.randomUUID(), question, { attachments: [file] });
              if (!sourceSession) go(target);
            },
          }}
        >
          <div
            className="app grid h-dvh grid-cols-[minmax(0,1fr)] transition-[grid-template-columns] duration-[240ms] ease-in-out max-md:data-[view=chat]:[&>.sidebar]:hidden max-md:data-[view=list]:[&>.main]:hidden md:grid-cols-[var(--navigation-width)_minmax(0,1fr)] md:data-[sidebar=collapsed]:grid-cols-[56px_minmax(0,1fr)]"
            data-view={library || knowledge || background || behindId ? "chat" : "list"}
            data-sidebar={sidebarCollapsed ? "collapsed" : "open"}
          >
            <div
              className="toast-host pointer-events-none fixed inset-x-0 top-[calc(0.75rem+var(--safe-t))] z-60 flex justify-center px-4"
              role="status"
              aria-live="polite"
            >
              {notice && (
                <p
                  className="toast max-w-full rounded-full border bg-popover px-4 py-2 text-sm text-popover-foreground shadow-md"
                  data-enter="fade"
                >
                  {notice}
                </p>
              )}
            </div>
            <Sidebar
              pagination={sessionPages}
              global={global}
              selectedId={sessionId}
              activeAgentId={activeAgentId}
              settingsOpen={settings !== null}
              libraryOpen={library}
              knowledgeOpen={knowledge}
              backgroundOpen={background}
              creating={creating}
              onNewChat={() => void newChat()}
              showTriggers={showTriggers}
              onShowTriggersChange={setShowTriggers}
              onRenameSession={renameSession}
              onDeleteSession={deleteSessionFromSidebar}
              onPinSession={pinSession}
              onSearch={() => setSearchOpen(true)}
              onNewAgent={() => setNewAgentOpen(true)}
              collapsed={sidebarCollapsed}
              onCollapse={toggleSidebar}
            />
            <div className="main relative flex min-h-0 min-w-0 flex-col bg-background">
              {error && (
                <p role="alert" className="form-error banner">
                  {error}
                </p>
              )}
              {background ? (
                <BackgroundActivity
                  api={api}
                  route={backgroundRoute}
                  rev={pageRev.background}
                  onBack={() => go(null)}
                />
              ) : library ? (
                <LibraryPage api={api} initialFileId={libraryFileId} onBack={!wide ? () => go(null) : undefined} />
              ) : knowledge ? (
                <KnowledgePage
                  api={api}
                  pageId={knowledgePageId}
                  rev={pageRev.knowledge}
                  changedPageId={pageRev.knowledgePage}
                  agents={global.agents}
                  defaultAgentId={global.defaultAgentId ?? global.agents[0]?.id ?? ""}
                  onAsk={askAboutPage}
                  onBack={() => go(null)}
                />
              ) : behindId ? (
                <ChatView
                  key={behindId}
                  api={api}
                  sessionId={behindId}
                  agents={global.agents}
                  defaultAgentId={global.defaultAgentId ?? global.agents[0]?.id}
                  missing={missing}
                  sessions={global.ready ? global.sessions : undefined}
                  onNavigate={go}
                  onRemoved={handleRemoved}
                  onLocalDelete={onLocalDelete}
                  onBack={() => go(null)}
                  onNewChat={creating ? undefined : () => void newChat()}
                  onBrowserStarted={() => setSidebarFolded(true)}
                  onUnauthorized={onUnauthorized}
                  focusMessageId={messageId}
                />
              ) : (
                <div className="grid flex-1 place-content-center justify-items-center gap-2 p-6 text-center">
                  <img src="/rei-icon-192.png" width={48} height={48} alt="" className="mb-3 rounded-[20%]" />
                  <h1 className="text-3xl font-semibold tracking-tight">Chats</h1>
                  <p className="text-muted-foreground">Pick a chat, or start a new one.</p>
                </div>
              )}
            </div>
            {searchOpen && (
              <HistorySearchDialog
                api={api}
                agents={global.agents}
                sessions={selectSessions(global)}
                onClose={() => setSearchOpen(false)}
              />
            )}
            {newAgentOpen && (
              <NewAgentDialog
                api={api}
                onClose={() => setNewAgentOpen(false)}
                onCreated={(r) => {
                  setNewAgentOpen(false);
                  go(r.session.id);
                }}
              />
            )}
            {settings && (
              <SettingsWindow
                api={api}
                agents={global.agents}
                companion={global.companion}
                sessions={global.sessions}
                route={settings}
                wide={wide}
                memoryRev={memoryRev}
                pageRev={pageRev}
                onClose={closeSettings}
                onLogout={() => void logout()}
              />
            )}
            {/* Two modal dialogs share a layer, and the later one's blurred overlay would cover the first: wait for Settings. */}
            {!settings && <FirstTimeSetupDialog api={api} />}
          </div>
        </LibraryContext.Provider>
      </ConnectorNamesContext.Provider>
    </FullModeContext.Provider>
  );
}
