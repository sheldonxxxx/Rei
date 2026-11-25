import type { Agent, GlobalEvent, Session } from "@rei/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Main } from "./App.tsx";
import type { Api } from "./api/client.ts";
import { currentRoute, navigate } from "./lib/route.ts";
import { ThemeProvider } from "./lib/theme.tsx";
import { approval, indexStatus, message, session, takeover, trigger } from "./test/fixtures.ts";
import { openMenu } from "./test/menu.ts";
import { type ViewChange, ViewFrames } from "./test/viewFrames.ts";

class FakeEventSource {
  static all: FakeEventSource[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (ev: MessageEvent) => void>();
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.all.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  addEventListener(t: string, l: (ev: MessageEvent) => void) {
    this.listeners.set(t, l);
  }
  close() {}
  frames = new ViewFrames();
  emit(event: { type: string; [key: string]: unknown }, id = "") {
    // The session stream speaks snapshot/patch frames: tests describe the change, ViewFrames makes the frames.
    const events = this.url.includes("/api/sessions/")
      ? this.frames.translate(event as ViewChange).map((e) => ({ event: e as { type: string }, id: "" }))
      : [{ event, id }];
    for (const { event: e, id: lastEventId } of events) {
      const { type, ...rest } = e;
      this.listeners.get(type)?.({ data: JSON.stringify(rest), lastEventId } as MessageEvent);
    }
  }
}
const stream = (suffix: string) => FakeEventSource.all.findLast((e) => e.url.split("?")[0]!.endsWith(suffix))!;

const agent: Agent = {
  id: "a1",
  name: "Dot",
  avatar: "D",
  model: null,
  thinkingLevel: "off",
  networkMode: "block",
  defaultProfile: "standard",
  homeSessionId: "home1",
};
const sessions: Session[] = [
  session({ id: "home1", origin: "home", title: "Dot" }),
  session({ id: "s2", title: "Budget", updatedAt: 5 }),
];

const media = (wide: boolean) =>
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q.includes("min-width: 768px") ? wide : false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }));
const goTo = (hash: string) =>
  act(() => {
    navigate(hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

beforeEach(() => {
  FakeEventSource.all = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  navigate("/s/s2");
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Main loads connector names on start; most tests don't care. */
const withConnectors = (api: object): Api =>
  ({
    getConnectors: vi.fn().mockResolvedValue({ connectors: [] }),
    getSessions: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
    getRelatedSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    getTimeZone: vi.fn().mockResolvedValue({ timeZone: "Asia/Macau" }),
    updateTimeZone: vi.fn().mockResolvedValue({ timeZone: "Asia/Macau" }),
    ...api,
  }) as unknown as Api;

function setup(api: Partial<Record<keyof Api, unknown>> = {}, home = false) {
  const selected = home ? sessions[0]! : sessions[1]!;
  if (home) navigate("/s/home1");
  render(<Main api={withConnectors(api)} onUnauthorized={() => {}} onLoggedOut={() => {}} />);
  act(() => {
    stream("/api/stream").emit(
      {
        type: "snapshot",
        cursor: "1",
        agents: home ? [agent] : [],
        defaultAgentId: "a1",
        companion: { agentId: "a1", homeSessionId: home ? selected.id : "" },
        sessions,
        approvals: [],
        takeovers: [],
      } satisfies GlobalEvent,
      "1",
    );
    stream(`/api/sessions/${selected.id}/stream`)?.emit(
      { type: "snapshot", cursor: "1", session: selected, messages: [], runs: [] },
      "1",
    ); // none on a page
  });
}

describe("Main: the open chat is removed", () => {
  it("goes back to the list and says so, when the server deletes it", async () => {
    setup();
    expect(screen.getByRole("heading", { name: "Budget" })).toBeTruthy();
    act(() => stream("/api/stream").emit({ type: "session.removed", sessionId: "s2" }, "2"));
    await waitFor(() => expect(currentRoute()).toBe("/"));
    expect(screen.getByText("Chat deleted")).toBeTruthy();
  });

  it("acts once when both streams report it, and ignores other chats being removed", async () => {
    setup();
    act(() => stream("/api/stream").emit({ type: "session.removed", sessionId: "other" }, "2"));
    expect(currentRoute()).toBe("/s/s2");
    expect(screen.queryByText("Chat deleted")).toBeNull();
    act(() => {
      stream("/api/stream").emit({ type: "session.removed", sessionId: "s2" }, "3");
      stream("/api/sessions/s2/stream").emit({ type: "session.removed", sessionId: "s2" }, "2");
    });
    await waitFor(() => expect(currentRoute()).toBe("/"));
    expect(screen.getAllByText("Chat deleted")).toHaveLength(1);
  });

  it("just navigates, with no status, when this client deleted it", async () => {
    const deleteSession = vi.fn(async () => {
      // the removal event can beat the response
      stream("/api/stream").emit({ type: "session.removed", sessionId: "s2" }, "2");
      return { ok: true };
    });
    setup({ deleteSession });
    openMenu(screen.getByRole("button", { name: "Chat options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete chat" }));
    const confirmation = await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));
    });
    await waitFor(() => expect(currentRoute()).toBe("/"));
    expect(screen.queryByText("Chat deleted")).toBeNull();
    expect(deleteSession).toHaveBeenCalledWith("s2", { withForks: false });
  });

  it("opens the default agent's fresh Home chat even when removal arrives before the response", async () => {
    media(false);
    const result = Promise.withResolvers<{ ok: true; homeSessionId: string }>();
    const deleteSession = vi.fn(() => result.promise);
    setup({ deleteSession }, true);
    const options = screen.getByRole("button", { name: "Chat options" });
    const openClear = async () => {
      openMenu(options);
      expect(screen.queryByRole("menuitem", { name: "Delete agent" })).toBeNull();
      fireEvent.click(screen.getByRole("menuitem", { name: "Clear Home chat" }));
      return screen.findByRole("alertdialog", { name: "Clear Home chat?" });
    };
    const first = await openClear();
    fireEvent.click(within(first).getByRole("button", { name: "Cancel" }));
    expect(deleteSession).not.toHaveBeenCalled();

    const confirmation = await openClear();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Clear Home chat" }));
    expect(deleteSession).toHaveBeenCalledWith("home1", { withForks: false, clearHome: true });
    act(() => stream("/api/stream").emit({ type: "session.removed", sessionId: "home1" }, "2"));
    expect(currentRoute()).toBe("/s/home1");
    expect(screen.getByRole("button", { name: "Clearing…" }).hasAttribute("disabled")).toBe(true);

    result.resolve({ ok: true, homeSessionId: "fresh-home" });
    await waitFor(() => expect(currentRoute()).toBe("/s/fresh-home"));
    expect(screen.queryByText("Chat deleted")).toBeNull();
  });
});

describe("Sidebar rows", () => {
  it("marks spawned and branched chats without title tooltips", async () => {
    navigate("/");
    render(<Main api={withConnectors({})} onUnauthorized={() => {}} onLoggedOut={() => {}} />);
    act(() => {
      stream("/api/stream").emit(
        {
          type: "snapshot",
          cursor: "1",
          agents: [agent],
          defaultAgentId: "a1",
          companion: { agentId: "a1", homeSessionId: "" },
          approvals: [],
          takeovers: [],
          sessions: [
            session({ id: "home1", origin: "home", title: "Dot" }),
            session({ id: "p", title: "Plan the trip", updatedAt: 1 }),
            session({ id: "c", title: "Flights", origin: "spawned", parentSessionId: "p", depth: 1, updatedAt: 3 }),
            session({
              id: "f",
              title: "Plan B",
              origin: "fork",
              forkedFrom: { sessionId: "p", messageId: "m" },
              updatedAt: 2,
            }),
          ],
        } satisfies GlobalEvent,
        "1",
      );
    });
    const rows = (name: string) => screen.getByRole("link", { name });
    expect(rows("Flights").querySelector(".row-kind")).not.toBeNull();
    const user = userEvent.setup();
    await user.hover(rows("Flights"));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(rows("Flights").hasAttribute("data-state")).toBe(false);
    await user.unhover(rows("Flights"));
    expect(rows("Plan B").querySelector(".row-kind")).not.toBeNull();
    await user.hover(rows("Plan B"));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(rows("Plan B").hasAttribute("data-state")).toBe(false);
    expect(rows("Plan the trip").querySelector(".row-kind")).toBeNull();
    act(() => stream("/api/stream").emit({ type: "session.removed", sessionId: "c" }, "2"));
    expect(screen.queryByRole("link", { name: "Flights" })).toBeNull();
  });
});

describe("Waiting for you", () => {
  const ap = (id: string, sessionId: string, summary: string) =>
    approval({ id, sessionId, sessionTitle: sessionId === "p" ? "Plan the trip" : "Flights", summary });
  const snap = (approvals: unknown[]) => ({
    type: "snapshot",
    cursor: "1",
    agents: [agent],
    defaultAgentId: "a1",
    approvals,
    sessions: [
      session({ id: "home1", origin: "home", title: "Dot" }),
      session({ id: "p", title: "Plan the trip", updatedAt: 1 }),
      session({
        id: "c",
        title: "Flights",
        origin: "spawned",
        parentSessionId: "p",
        depth: 1,
        updatedAt: 3,
        status: "waiting_for_user",
        pendingApprovals: 1,
      }),
    ],
  });

  beforeEach(() => {
    document.title = "Rei";
    navigate("/");
  });

  it("lists pending approvals at the top, linking to their session, and prefixes the tab title with the count", () => {
    render(<Main api={withConnectors({})} onUnauthorized={() => {}} onLoggedOut={() => {}} />);
    act(() =>
      stream("/api/stream").emit(
        snap([ap("a1", "c", "Book the 9am flight"), ap("a2", "p", "Send the itinerary")]),
        "1",
      ),
    );
    const section = screen.getByRole("region", { name: "Waiting for you" });
    const links = within(section).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/s/c", "/s/p"]);
    expect(links[0]?.textContent).toContain("Flights");
    expect(links[0]?.textContent).toContain("Book the 9am flight");
    expect(document.title).toBe("(2) Rei");
    expect(
      section.compareDocumentPosition(document.querySelector(".agents") as Element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    act(() =>
      stream("/api/stream").emit(
        { type: "approval.upserted", approval: { ...ap("a1", "c", "x"), status: "approved" } },
        "2",
      ),
    );
    expect(document.title).toBe("(1) Rei");
    act(() =>
      stream("/api/stream").emit(
        { type: "approval.upserted", approval: { ...ap("a2", "p", "x"), status: "denied" } },
        "3",
      ),
    );
    expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull();
    expect(document.title).toBe("Rei");
  });

  it("marks a session that waits for you with the attention indicator", () => {
    render(<Main api={withConnectors({})} onUnauthorized={() => {}} onLoggedOut={() => {}} />);
    act(() => stream("/api/stream").emit(snap([]), "1"));
    expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull();
    const row = screen.getByRole("link", { name: /Flights/ });
    expect(row.querySelector(".status-waiting_for_user")?.getAttribute("aria-label")).toBe("Waiting for you");
    expect(document.title).toBe("Rei");
  });
});

describe("Settings window", () => {
  const settingsApi = () => ({
    listGrants: vi.fn().mockResolvedValue({ grants: [] }),
    logout: vi.fn().mockResolvedValue(undefined),
    getMemory: vi
      .fn()
      .mockResolvedValue({ profile: [], agents: [], usedTokens: 0, userUsedTokens: 0, userTokenBudget: 3000 }),
    getIndexStatus: vi.fn().mockResolvedValue({ index: indexStatus() }),
    getSkills: vi.fn().mockResolvedValue({ skills: [] }),
    getConnectors: vi.fn().mockResolvedValue({ connectors: [] }),
    getTrace: vi.fn().mockResolvedValue({ session: sessions[1], runs: [], next: null }),
  });
  const dialog = () => screen.getByRole("dialog", { name: "Settings" });
  beforeEach(() => media(true));

  it("opens from the one Settings row in the sidebar, over the chat that was open, with General showing", () => {
    setup(settingsApi());
    const row = screen.getByRole("link", { name: "Settings" });
    expect(row.getAttribute("href")).toBe("/settings");
    goTo("/settings");
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(within(dialog()).getByRole("heading", { name: "Settings" })).toBeTruthy();
    const nav = within(dialog()).getByRole("navigation", { name: "Settings sections" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual([
      "General",
      "Notifications",
      "Providers",
      "Models",
      "Runtime",
      "Memory",
      "Capabilities",
      "Triggers",
      "Permissions",
      "Backups",
      "Usage",
    ]);
    expect(within(nav).getByRole("link", { name: "General" }).getAttribute("aria-current")).toBe("page");
    expect(within(dialog()).getByRole("switch", { name: "Show details" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings", hidden: true }).getAttribute("aria-current")).toBe("page");
    // the chat stays rendered behind it
    expect(screen.getByRole("heading", { name: "Budget", hidden: true })).toBeTruthy();
    expect(document.querySelector(".app")?.getAttribute("data-view")).toBe("chat");
  });

  it("holds the first-time setup dialog until Settings closes, so two modals never stack and blur it", async () => {
    sessionStorage.clear();
    localStorage.clear();
    navigate("/settings");
    render(
      <Main
        api={withConnectors({
          ...settingsApi(),
          getProviders: vi.fn().mockResolvedValue({ connections: [] }),
          getWebSearchStatus: vi.fn().mockResolvedValue({ providers: [] }),
          // The dialog's step pages only need to mount here; their loads stay pending.
          getModelSettings: vi.fn(() => new Promise(() => {})),
          getEmbeddingSetup: vi.fn(() => new Promise(() => {})),
          getSearchSetup: vi.fn(() => new Promise(() => {})),
          getModels: vi.fn(() => new Promise(() => {})),
        })}
        onUnauthorized={() => {}}
        onLoggedOut={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "Settings" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog", { name: "Welcome to Rei" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(await screen.findByRole("dialog", { name: "Welcome to Rei" })).toBeTruthy();
    sessionStorage.clear();
    localStorage.clear();
  });

  it("groups chat, embedding and search providers and supports old links", async () => {
    const user = userEvent.setup();
    setup({
      ...settingsApi(),
      getProviders: vi.fn().mockResolvedValue({ connections: [] }),
      getOpenAiOAuthStatus: vi.fn().mockResolvedValue({ pending: false }),
      getEmbeddingSetup: vi.fn().mockResolvedValue(null),
      getSearchSetup: vi.fn().mockResolvedValue({ providers: ["exa"], exaAuth: "keyless", searxngUrl: "" }),
    });
    goTo("/settings/providers");
    await within(dialog()).findByText("No providers connected yet.");
    expect(within(dialog()).getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");
    const nav = within(dialog()).getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).queryByRole("link", { name: "Embeddings" })).toBeNull();
    expect(within(nav).queryByRole("link", { name: "Web search" })).toBeNull();
    await user.click(within(dialog()).getByRole("tab", { name: "Embeddings" }));
    await within(dialog()).findByLabelText("Embedding provider");
    expect(currentRoute()).toBe("/settings/providers/embedding");
    await user.click(within(dialog()).getByRole("tab", { name: "Web search" }));
    await within(dialog()).findByRole("list", { name: "Search providers in priority order" });
    expect(currentRoute()).toBe("/settings/providers/search");
    goTo("/settings/embedding");
    await within(dialog()).findByLabelText("Embedding provider");
    expect(within(nav).getByRole("link", { name: "Providers" }).getAttribute("aria-current")).toBe("page");
    goTo("/settings/search");
    await within(dialog()).findByRole("list", { name: "Search providers in priority order" });
  });

  it("closes with the button, Escape or a click outside, back to the chat it came from", async () => {
    setup(settingsApi());
    for (const close of [
      () => fireEvent.click(screen.getByRole("button", { name: "Close settings" })),
      () => fireEvent.keyDown(document, { key: "Escape" }),
      () => userEvent.click(document.querySelector('[data-slot="dialog-overlay"]')!),
    ]) {
      goTo("/settings/permissions");
      expect(dialog()).toBeTruthy();
      await close();
      expect(currentRoute()).toBe("/s/s2");
      goTo("/s/s2");
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    }
    // a click inside the window does not close it
    goTo("/settings");
    fireEvent.mouseDown(dialog());
    expect(currentRoute()).toBe("/settings");
  });

  it("remembers the chat across sections, and closes to the list when there was none", () => {
    setup(settingsApi());
    goTo("/settings/memory");
    goTo("/settings/skills");
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(currentRoute()).toBe("/s/s2");

    navigate("/settings/general");
    FakeEventSource.all = [];
    cleanupAndMount();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(currentRoute()).toBe("/");

    function cleanupAndMount() {
      cleanup();
      render(<Main api={withConnectors(settingsApi())} onUnauthorized={() => {}} onLoggedOut={() => {}} />);
      act(() =>
        stream("/api/stream").emit(
          {
            type: "snapshot",
            cursor: "1",
            agents: [],
            defaultAgentId: "a1",
            companion: { agentId: "a1", homeSessionId: "" },
            sessions,
            approvals: [],
            takeovers: [],
          } satisfies GlobalEvent,
          "1",
        ),
      );
    }
  });

  it("does not let the wide-screen home chat take over while Settings is open with no chat behind it", () => {
    navigate("/settings");
    render(<Main api={withConnectors(settingsApi())} onUnauthorized={() => {}} onLoggedOut={() => {}} />);
    act(() =>
      stream("/api/stream").emit(
        {
          type: "snapshot",
          cursor: "1",
          agents: [agent],
          defaultAgentId: "a1",
          companion: { agentId: "a1", homeSessionId: "" },
          sessions,
          approvals: [],
          takeovers: [],
        } satisfies GlobalEvent,
        "1",
      ),
    );
    expect(currentRoute()).toBe("/settings");
    expect(dialog()).toBeTruthy();
    expect(screen.getByText("Pick a chat, or start a new one.")).toBeTruthy();
    // Closed, nothing is behind it, so the wide screen opens the home chat.
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(currentRoute()).toBe("/s/home1");
  });

  it("shows Permissions in the window, reached from its nav entry", async () => {
    const api = settingsApi();
    setup(api);
    goTo("/settings");
    fireEvent.click(within(dialog()).getByRole("link", { name: "Permissions" }));
    expect(currentRoute()).toBe("/settings/permissions");
    expect(await within(dialog()).findByRole("heading", { name: "Permissions" })).toBeTruthy();
    expect(within(dialog()).getByRole("link", { name: "Permissions" }).getAttribute("aria-current")).toBe("page");
    expect(api.listGrants).toHaveBeenCalled();
  });

  it.each([true, false])(
    "Escape closes only the nested dialog and returns focus inside Settings (wide=%s)",
    async (wide) => {
      media(wide);
      setup(settingsApi());
      goTo("/settings/memory");
      const rebuild = await screen.findByRole("button", { name: "Rebuild" });
      await userEvent.click(rebuild);
      expect(await screen.findByRole("alertdialog", { name: "Rebuild the search index?" })).toBeTruthy();
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Rebuild the search index?" })).toBeNull());
      expect(currentRoute()).toBe("/settings/memory");
      expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
      await waitFor(() => expect(document.activeElement).toBe(rebuild));
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
      expect(currentRoute()).toBe("/s/s2");
    },
  );

  it.each([true, false])("opens Usage from Settings (wide=%s)", async (wide) => {
    media(wide);
    const getUsage = vi.fn(() => new Promise(() => {}));
    setup({ ...settingsApi(), getUsage });
    goTo("/settings");
    fireEvent.click(within(dialog()).getByRole("link", { name: "Usage" }));
    expect(currentRoute()).toBe("/settings/usage");
    expect(await within(dialog()).findByRole("heading", { name: "Usage" })).toBeTruthy();
    expect(getUsage).toHaveBeenCalledWith("30d");
    if (wide) expect(within(dialog()).getByRole("link", { name: "Usage" }).getAttribute("aria-current")).toBe("page");
    else
      expect(within(dialog()).getByRole("link", { name: "Back to Settings" }).getAttribute("href")).toBe("/settings");
  });

  it("opens settings sections using their current routes", async () => {
    const api = { ...settingsApi(), getTriggers: vi.fn().mockResolvedValue({ triggers: [] }) };
    setup(api);
    goTo("/settings/memory");
    expect(await within(dialog()).findByRole("heading", { name: "Memory" })).toBeTruthy();
    expect(within(dialog()).getByRole("link", { name: "Memory" }).getAttribute("aria-current")).toBe("page");
    goTo("/settings/triggers");
    expect(await within(dialog()).findByRole("heading", { name: "Triggers" })).toBeTruthy();
    goTo("/settings/plugins");
    expect(await within(dialog()).findByRole("heading", { name: "Plugins" })).toBeTruthy();
    // Skills and Connectors are views of Capabilities: its row stays current.
    const capabilities = () =>
      within(within(dialog()).getByRole("navigation", { name: "Settings sections" })).getByRole("link", {
        name: "Capabilities",
      });
    expect(capabilities().getAttribute("aria-current")).toBe("page");
    goTo("/settings/skills");
    expect(await within(dialog()).findByRole("heading", { name: "Skills" })).toBeTruthy();
    expect(capabilities().getAttribute("aria-current")).toBe("page");
    goTo("/settings/connectors");
    expect(await within(dialog()).findByRole("heading", { name: "Connectors" })).toBeTruthy();
    expect(capabilities().getAttribute("aria-current")).toBe("page");
  });

  it("General has the Mode control: it applies at once and is kept on this device", () => {
    const api = settingsApi();
    render(
      <ThemeProvider>
        <Main api={withConnectors(api)} onUnauthorized={() => {}} onLoggedOut={() => {}} />
      </ThemeProvider>,
    );
    act(() =>
      stream("/api/stream").emit(
        {
          type: "snapshot",
          cursor: "1",
          agents: [],
          defaultAgentId: "a1",
          companion: { agentId: "a1", homeSessionId: "" },
          sessions,
          approvals: [],
          takeovers: [],
        } satisfies GlobalEvent,
        "1",
      ),
    );
    goTo("/settings/general");
    const modes = within(within(dialog()).getByRole("radiogroup", { name: "Mode" }));
    expect(modes.getByRole("radio", { name: "Auto" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(modes.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.scheme).toBe("dark");
    expect(localStorage.getItem("rei:mode")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    fireEvent.click(modes.getByRole("radio", { name: "Light" }));
    expect(document.documentElement.dataset.scheme).toBe("light");
  });

  it("Show details in General is the Full mode switch, kept on this device, and Log out is there too", async () => {
    const api = settingsApi();
    const onLoggedOut = vi.fn();
    render(<Main api={withConnectors(api)} onUnauthorized={() => {}} onLoggedOut={onLoggedOut} />);
    act(() =>
      stream("/api/stream").emit(
        {
          type: "snapshot",
          cursor: "1",
          agents: [],
          defaultAgentId: "a1",
          companion: { agentId: "a1", homeSessionId: "" },
          sessions,
          approvals: [],
          takeovers: [],
        } satisfies GlobalEvent,
        "1",
      ),
    );
    goTo("/settings/general");
    const sw = within(dialog()).getByRole("switch", { name: "Show details" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.getAttribute("aria-describedby")).toBeTruthy();
    expect(within(dialog()).getByText("Steps, Inspect and Fork")).toBeTruthy();
    fireEvent.click(sw);
    expect(within(dialog()).getByRole("switch", { name: "Show details" }).getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("rei:full-mode")).toBe("1");
    // General holds only the Full mode switch; notification settings live on their own page.
    expect(
      screen
        .getAllByRole("switch")
        .map(
          (s) =>
            s.getAttribute("aria-labelledby") &&
            document.getElementById(s.getAttribute("aria-labelledby")!)?.textContent?.trim(),
        ),
    ).toEqual(["Show details"]);
    fireEvent.click(within(dialog()).getByRole("link", { name: "Notifications" }));
    expect(currentRoute()).toBe("/settings/notifications");
    goTo("/settings/notifications");
    await waitFor(() => expect(within(dialog()).getByRole("switch", { name: "Show previews" })).toBeTruthy());
    goTo("/settings/general");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Log out" }));
    await waitFor(() => expect(onLoggedOut).toHaveBeenCalled());
    expect(api.logout).toHaveBeenCalled();
    expect(currentRoute()).toBe("/");
  });

  describe("on a phone", () => {
    beforeEach(() => media(false));

    it("/settings is the list of sections; a section has Back to the list, a detail has Back to its section", async () => {
      const api = {
        ...settingsApi(),
        getTriggers: vi.fn().mockResolvedValue({ triggers: [trigger()] }),
        getTrigger: vi.fn().mockResolvedValue({ trigger: trigger(), runs: [], next: null }),
        getMemory: vi.fn(),
        getIndexStatus: vi.fn(),
      };
      setup(api);
      goTo("/settings");
      expect(dialog().className).toContain("sheet");
      expect(within(dialog()).queryByRole("switch")).toBeNull();
      expect(
        within(dialog())
          .getAllByRole("link")
          .map((l) => l.textContent),
      ).toEqual([
        "General",
        "Notifications",
        "Providers",
        "Models",
        "Runtime",
        "Memory",
        "Capabilities",
        "Triggers",
        "Permissions",
        "Backups",
        "Usage",
      ]);
      expect(within(dialog()).queryByRole("link", { name: "Back to Settings" })).toBeNull();
      fireEvent.click(within(dialog()).getByRole("link", { name: "Triggers" }));
      expect(currentRoute()).toBe("/settings/triggers");
      fireEvent.click(await within(dialog()).findByRole("link", { name: /Morning check/ }));
      goTo("/settings/triggers/trg1");
      expect(await within(dialog()).findByRole("heading", { name: "Morning check" })).toBeTruthy();
      expect(within(dialog()).queryByRole("link", { name: "Back to Settings" })).toBeNull();
      fireEvent.click(within(dialog()).getByRole("button", { name: "Back to Triggers" }));
      expect(currentRoute()).toBe("/settings/triggers");
      goTo("/settings/triggers");
      fireEvent.click(await within(dialog()).findByRole("link", { name: "Back to Settings" }));
      expect(currentRoute()).toBe("/settings");
      goTo("/settings/general");
      expect(within(dialog()).getByRole("switch", { name: "Show details" })).toBeTruthy();
    });
  });
});

describe("Sidebar: fold away (wide screens)", () => {
  const app = () => document.querySelector(".app") as HTMLElement;
  const KEY = "rei:sidebar-folded";
  const media = (wide: boolean) =>
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("min-width: 768px") ? wide : false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }));
  beforeEach(() => media(true));

  it("minimizes to an icon rail, brings back with the rail's expand button, and remembers it", () => {
    const first = render(<Main api={withConnectors({})} onUnauthorized={() => {}} onLoggedOut={() => {}} />);
    act(() => {
      stream("/api/stream").emit(
        {
          type: "snapshot",
          cursor: "1",
          agents: [],
          defaultAgentId: "a1",
          companion: { agentId: "a1", homeSessionId: "" },
          sessions,
          approvals: [],
          takeovers: [],
        } satisfies GlobalEvent,
        "1",
      );
      stream("/api/sessions/s2/stream").emit(
        { type: "snapshot", cursor: "1", session: sessions[1], messages: [], runs: [] },
        "1",
      );
    });
    expect(app().dataset.sidebar).toBe("open");
    expect(screen.queryByRole("button", { name: "Expand sidebar" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Minimize sidebar" }));
    expect(app().dataset.sidebar).toBe("collapsed");
    expect(localStorage.getItem(KEY)).toBe("1");
    // the rail's expand button is the only way back: no page carries a second Show sidebar button
    expect(screen.queryByRole("button", { name: "Show sidebar" })).toBeNull();
    // the full sidebar is gone; the rail stands in its place with the expand button first
    expect(document.querySelector(".sidebar-rail")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Minimize sidebar" })).toBeNull();
    const expand = screen.getByRole("button", { name: "Expand sidebar" });
    expect(document.activeElement).toBe(expand);
    expect(screen.getByRole("link", { name: "Library" }).getAttribute("href")).toBe("/library");
    expect(screen.getByRole("link", { name: "Knowledge" }).getAttribute("href")).toBe("/knowledge");
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings");

    // a new visit keeps it minimized
    first.unmount();
    FakeEventSource.all = [];
    render(<Main api={withConnectors({})} onUnauthorized={() => {}} onLoggedOut={() => {}} />);
    expect(app().dataset.sidebar).toBe("collapsed");

    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(app().dataset.sidebar).toBe("open");
    expect(localStorage.getItem(KEY)).toBe("0");
    expect(document.querySelector(".sidebar-rail")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Minimize sidebar" }));
  });

  it("moves focus to the sidebar's toggle without scrolling the clipped sidebar sideways", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(<Main api={withConnectors({})} onUnauthorized={() => {}} onLoggedOut={() => {}} />);
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    expect(app().dataset.sidebar).toBe("open");
    expect(focus.mock.instances.some((el) => (el as HTMLElement).dataset.sidebarHide !== undefined)).toBe(true);
    expect(focus.mock.calls.every((args) => (args[0] as FocusOptions | undefined)?.preventScroll === true)).toBe(true);
    focus.mockRestore();
  });

  it("toggles with Ctrl+\\ and Cmd+\\, but not for a key typed into the live browser frame", () => {
    render(<Main api={withConnectors({})} onUnauthorized={() => {}} onLoggedOut={() => {}} />);
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    expect(app().dataset.sidebar).toBe("collapsed");
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    expect(app().dataset.sidebar).toBe("open");
    fireEvent.keyDown(window, { key: "\\" });
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true, shiftKey: true });
    expect(app().dataset.sidebar).toBe("open");

    const keys = document.createElement("textarea");
    keys.className = "live-keys";
    document.body.append(keys);
    fireEvent.keyDown(keys, { key: "\\", ctrlKey: true });
    expect(app().dataset.sidebar).toBe("open");
    keys.remove();
  });

  it("is unchanged on a phone: no fold buttons take effect and the shortcut does nothing", () => {
    localStorage.setItem(KEY, "1");
    media(false);
    render(<Main api={withConnectors({})} onUnauthorized={() => {}} onLoggedOut={() => {}} />);
    expect(app().dataset.sidebar).toBe("open");
    expect(screen.queryByRole("button", { name: "Show sidebar" })).toBeNull();
    expect(document.querySelector(".sidebar")?.hasAttribute("inert")).toBe(false);
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    expect(app().dataset.sidebar).toBe("open");
    expect(localStorage.getItem(KEY)).toBe("1");
  });

  it("works without storage (private mode): it still folds, just isn't remembered", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<Main api={withConnectors({})} onUnauthorized={() => {}} onLoggedOut={() => {}} />);
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    expect(app().dataset.sidebar).toBe("collapsed");
    spy.mockRestore();
  });
});

describe("agent.upserted", () => {
  it("changes the agent's look everywhere it is drawn", () => {
    navigate("/s/s2");
    render(<Main api={withConnectors({})} onUnauthorized={() => {}} onLoggedOut={() => {}} />);
    act(() => {
      stream("/api/stream").emit(
        {
          type: "snapshot",
          cursor: "1",
          agents: [{ ...agent, avatar: "bot:sprout" }],
          defaultAgentId: "a1",
          companion: { agentId: "a1", homeSessionId: "" },
          sessions: [...sessions, session({ id: "x", agentId: "a1" })],
          approvals: [],
          takeovers: [],
        } satisfies GlobalEvent,
        "1",
      );
      stream("/api/sessions/s2/stream").emit(
        { type: "snapshot", cursor: "1", session: { ...sessions[1]!, agentId: "a1" }, messages: [], runs: [] },
        "1",
      );
    });
    const bots = () => [...document.querySelectorAll("svg.bot")].map((b) => b.getAttribute("data-bot"));
    expect(bots().length).toBeGreaterThanOrEqual(2); // sidebar row, chat header, hero
    expect(new Set(bots())).toEqual(new Set(["sprout"]));
    act(() => stream("/api/stream").emit({ type: "agent.upserted", agent: { ...agent, avatar: "bot:ghost" } }, "2"));
    expect(new Set(bots())).toEqual(new Set(["ghost"]));
    act(() => stream("/api/stream").emit({ type: "agent.upserted", agent: { ...agent, avatar: "🦊" } }, "3"));
    expect(bots()).toEqual([]);
    expect(screen.getAllByText("🦊").length).toBeGreaterThanOrEqual(2);
  });
});

describe("Main: memory", () => {
  const memoryApi = () => ({
    getMemory: vi
      .fn()
      .mockResolvedValue({ profile: [], agents: [], usedTokens: 0, userUsedTokens: 0, userTokenBudget: 3000 }),
    getIndexStatus: vi.fn().mockResolvedValue({ index: indexStatus() }),
  });

  beforeEach(() => media(true));

  it("opens as a section of the Settings window", async () => {
    const api = memoryApi();
    setup(api);
    goTo("/settings/memory");
    expect(
      await within(screen.getByRole("dialog", { name: "Settings" })).findByRole("heading", { name: "Memory" }),
    ).toBeTruthy();
    await waitFor(() => expect(api.getMemory).toHaveBeenCalledTimes(1));
  });

  it("refetches on memory.changed, by what changed", async () => {
    navigate("/settings/memory");
    const api = memoryApi();
    setup(api);
    await waitFor(() => expect(api.getMemory).toHaveBeenCalled());
    const base = api.getMemory.mock.calls.length;
    const baseIndex = api.getIndexStatus.mock.calls.length;
    act(() => stream("/api/stream").emit({ type: "memory.changed", what: "lines" }));
    await waitFor(() => expect(api.getMemory).toHaveBeenCalledTimes(base + 1));
    expect(api.getIndexStatus).toHaveBeenCalledTimes(baseIndex);
    act(() => stream("/api/stream").emit({ type: "memory.changed", what: "index" }));
    await waitFor(() => expect(api.getIndexStatus).toHaveBeenCalledTimes(baseIndex + 1));
    expect(api.getMemory).toHaveBeenCalledTimes(base + 1);
  });

  it("a link to a message opens that chat and highlights the message", async () => {
    navigate("/s/s2?m=m5");
    setup();
    act(() => {
      stream("/api/sessions/s2/stream").emit(
        {
          type: "snapshot",
          cursor: "2",
          session: sessions[1],
          messages: [
            message({ id: "m4", role: "user", status: "complete", text: "before" }),
            message({ id: "m5", status: "complete", text: "the one" }),
          ],
          runs: [],
        },
        "2",
      );
    });
    expect(screen.getByRole("heading", { name: "Budget" })).toBeTruthy();
    expect(document.querySelectorAll("[data-flash]")).toHaveLength(1);
    expect(document.querySelector("[data-flash]")?.textContent).toContain("the one");
  });
});

describe("Main: Full mode", () => {
  afterEach(() => localStorage.removeItem("rei:full-mode"));

  it("is off by default, has no control outside Settings, and shows no badge in the chat", () => {
    setup();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText("Full")).toBeNull();
  });

  it("starts on when the device remembered it, and Settings shows it on", () => {
    media(true);
    localStorage.setItem("rei:full-mode", "1");
    setup({ getTrace: vi.fn().mockResolvedValue({ session: sessions[1], runs: [], next: null }) });
    goTo("/settings/general");
    expect(screen.getByRole("switch", { name: "Show details" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("Main: triggers and skills pages", () => {
  beforeEach(() => media(true));
  const api = () => ({
    getTriggers: vi.fn().mockResolvedValue({ triggers: [] }),
    getSkills: vi.fn().mockResolvedValue({ skills: [] }),
    getPlugins: vi.fn().mockResolvedValue({ plugins: [] }),
    getPlugin: vi.fn(),
    getTrigger: vi.fn(),
    getSkill: vi.fn(),
  });

  it("opens the Triggers section from its hash, and refetches when the stream reports a change", async () => {
    navigate("/settings/triggers");
    const a = api();
    setup(a);
    expect(await screen.findByRole("region", { name: "Triggers" })).toBeTruthy();
    await waitFor(() => expect(a.getTriggers).toHaveBeenCalled());
    const before = a.getTriggers.mock.calls.length;
    act(() => stream("/api/stream").emit({ type: "triggers.changed", triggerId: null }));
    await waitFor(() => expect(a.getTriggers.mock.calls.length).toBe(before + 1));
  });

  it("refetches the Triggers page when a trigger session or an approval changes, since a run starting to wait fires no triggers.changed", async () => {
    navigate("/settings/triggers");
    const a = api();
    setup(a);
    await waitFor(() => expect(a.getTriggers).toHaveBeenCalled());
    const count = () => a.getTriggers.mock.calls.length;
    let before = count();
    act(() => stream("/api/stream").emit({ type: "session.upserted", session: session({ triggerId: "trg1" }) }));
    await waitFor(() => expect(count()).toBe(before + 1));
    before = count();
    act(() => stream("/api/stream").emit({ type: "session.upserted", session: session({ triggerId: null }) }));
    act(() => stream("/api/stream").emit({ type: "approval.upserted", approval: approval() }));
    await waitFor(() => expect(count()).toBe(before + 1));
    before = count();
    act(() => stream("/api/stream").emit({ type: "takeover.upserted", takeover: takeover() }));
    await waitFor(() => expect(count()).toBe(before + 1));
  });

  // Plugins are a view of Settings → Capabilities; a skill or plugin change bumps the same revision.
  it("opens the Plugins section, and refetches on skills.changed", async () => {
    navigate("/settings/plugins");
    const a = api();
    setup(a);
    expect(await screen.findByRole("list", { name: "Plugins" })).toBeTruthy();
    await waitFor(() => expect(a.getPlugins).toHaveBeenCalled());
    const before = a.getPlugins.mock.calls.length;
    act(() => stream("/api/stream").emit({ type: "skills.changed" }));
    await waitFor(() => expect(a.getPlugins.mock.calls.length).toBe(before + 1));
  });

  it("opens one trigger from #/settings/triggers/<id>", async () => {
    navigate("/settings/triggers/trg1");
    const a = { ...api(), getTrigger: vi.fn().mockResolvedValue({ trigger: trigger(), runs: [], next: null }) };
    setup(a);
    expect(await screen.findByRole("heading", { name: "Morning check" })).toBeTruthy();
    expect(a.getTrigger).toHaveBeenCalledWith("trg1");
  });
});

describe("Main: paged history deep links", () => {
  it("opens an unloaded chat, follows its agent, and selects its sidebar row", async () => {
    media(true);
    navigate("/s/older");
    const older = session({
      id: "older",
      agentId: "a2",
      title: "Older run",
      origin: "trigger",
      status: "completed",
      hideInList: true,
    });
    const getSessions = vi.fn().mockResolvedValue({ sessions: [], nextCursor: null });
    const getRelatedSessions = vi.fn().mockResolvedValue({ sessions: [older] });
    render(
      <Main
        api={withConnectors({ getSessions, getRelatedSessions })}
        onUnauthorized={() => {}}
        onLoggedOut={() => {}}
      />,
    );
    act(() => {
      stream("/api/stream").emit(
        {
          type: "snapshot",
          cursor: "1",
          agents: [agent, { ...agent, id: "a2", name: "Rex", homeSessionId: "home2" }],
          defaultAgentId: "a1",
          sessions: [sessions[0]!],
          approvals: [],
          takeovers: [],
        },
        "1",
      );
      stream("/api/sessions/older/stream").emit(
        { type: "snapshot", cursor: "1", session: older, messages: [], runs: [] },
        "1",
      );
    });
    const row = await screen.findByRole("link", { name: /Older run/ });
    expect(row.getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(getSessions).toHaveBeenCalledWith({ agent: "a2" }));
    expect(screen.queryByText("This chat doesn't exist or was removed.")).toBeNull();
    expect(currentRoute()).toBe("/s/older");
  });
});

describe("Background Activity view", () => {
  it("stays open on a wide screen instead of giving way to the home chat", async () => {
    media(true);
    navigate("/background");
    const api = withConnectors({
      getBackground: vi.fn().mockResolvedValue({ jobs: [], next: null }),
    });
    render(<Main api={api} onUnauthorized={() => {}} onLoggedOut={() => {}} />);
    act(() =>
      stream("/api/stream").emit(
        {
          type: "snapshot",
          cursor: "1",
          agents: [agent],
          defaultAgentId: "a1",
          companion: { agentId: "a1", homeSessionId: "" },
          sessions,
          approvals: [],
          takeovers: [],
        } satisfies GlobalEvent,
        "1",
      ),
    );
    await screen.findByRole("heading", { name: "Background Activity" });
    expect(currentRoute()).toBe("/background");
  });
});

describe("Knowledge view", () => {
  it("stays open on a wide screen instead of giving way to the home chat", async () => {
    media(true);
    navigate("/knowledge");
    const api = withConnectors({
      knowledgeTags: vi.fn().mockResolvedValue({ tags: [] }),
      knowledgeTree: vi.fn().mockResolvedValue({ pages: [] }),
      knowledgeOverview: vi.fn().mockResolvedValue({
        pinned: [],
        recent: [],
        week: [],
        inbox: { id: "inbox", count: 0, newest: [] },
        external: [],
        locked: [],
        trashCount: 0,
        pageCount: 1,
        meaning: { state: "off", sections: 0, embedded: 0, lastError: null },
      }),
    });
    render(<Main api={api} onUnauthorized={() => {}} onLoggedOut={() => {}} />);
    act(() =>
      stream("/api/stream").emit(
        {
          type: "snapshot",
          cursor: "1",
          agents: [agent],
          defaultAgentId: "a1",
          companion: { agentId: "a1", homeSessionId: "" },
          sessions,
          approvals: [],
          takeovers: [],
        } satisfies GlobalEvent,
        "1",
      ),
    );
    await screen.findByRole("region", { name: "Recently updated" });
    expect(currentRoute()).toBe("/knowledge");
  });
});
