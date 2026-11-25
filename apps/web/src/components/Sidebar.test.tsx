import type { Agent } from "@rei/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { APP_VERSION } from "../lib/brand.ts";
import type { GlobalState } from "../state/global.ts";
import { initialGlobalState } from "../state/global.ts";
import { agent as agentFixture, approval, session, takeover } from "../test/fixtures.ts";
import { openMenu } from "../test/menu.ts";
import { Sidebar } from "./Sidebar.tsx";

const agent: Agent = {
  id: "a1",
  name: "Dot",
  avatar: "D",
  model: null,
  thinkingLevel: "off",
  networkMode: "block",
  defaultProfile: "standard",
  homeSessionId: "home",
};

const renderSidebar = (over: Partial<GlobalState> = {}) =>
  render(
    <Sidebar
      global={{
        ...initialGlobalState,
        ready: true,
        agents: [agent],
        defaultAgentId: "a1",
        sessions: [session({ id: "s1", title: "Pay the bill" })],
        ...over,
      }}
      selectedId={null}
      creating={false}
      onNewChat={() => {}}
    />,
  );

it("shows the Rei wordmark and makes the release version available", () => {
  renderSidebar();
  expect(screen.getByText("Rei")).toBeTruthy();
  expect(screen.getByText(`v${APP_VERSION}`).textContent).toBe(`Version v${APP_VERSION}`);
});

describe("Sidebar: waiting for you", () => {
  it("is absent when nothing waits", () => {
    renderSidebar();
    expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull();
  });

  it("shows one link for the reads awaiting a decision in one tool round", () => {
    renderSidebar({
      approvals: ["ap1", "ap2", "ap3"].map((id) => approval({ id, groupId: "read-group" })),
    });
    const waiting = within(screen.getByRole("region", { name: "Waiting for you" }));
    expect(waiting.getByText("1")).toBeTruthy();
    const link = waiting.getByRole("link");
    expect(link.getAttribute("href")).toBe("/s/s1");
    expect(link.textContent).toContain("3 connector reads");
  });

  it("lists a pending browser takeover with its chat and reason, linking to the chat, and counts it", () => {
    renderSidebar({ takeovers: [takeover()] });
    const group = screen.getByRole("region", { name: "Waiting for you" });
    expect(within(group).getByText("1")).toBeTruthy();
    const link = within(group).getByRole("link");
    expect(link.getAttribute("href")).toBe("/s/s1");
    expect(link.textContent).toContain("Pay the bill");
    expect(link.textContent).toContain("Needs you in the browser: Sign in to the bank");
  });

  it("does not list an active takeover (you are already there), and counts approvals and takeovers together", () => {
    renderSidebar({ takeovers: [takeover({ id: "t2", status: "active" })] });
    expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull();
    renderSidebar({ approvals: [approval()], takeovers: [takeover()] });
    const groups = screen.getAllByRole("region", { name: "Waiting for you" });
    expect(within(groups[0]!).getByText("2")).toBeTruthy();
  });
});

describe("Sidebar: minimize button", () => {
  it("is offered only when the page can minimize the sidebar, and calls back", async () => {
    const { rerender } = renderSidebar();
    expect(screen.queryByRole("button", { name: "Minimize sidebar" })).toBeNull();
    const onCollapse = vi.fn();
    rerender(
      <Sidebar
        global={{ ...initialGlobalState, ready: true, agents: [agent] }}
        selectedId={null}
        creating={false}
        onNewChat={() => {}}
        onCollapse={onCollapse}
      />,
    );
    const btn = screen.getByRole("button", { name: "Minimize sidebar" });
    expect(btn.getAttribute("aria-keyshortcuts")).toBe("Control+\\ Meta+\\");
    await userEvent.setup().hover(btn);
    expect((await screen.findByRole("tooltip")).textContent).toBe("Minimize sidebarCtrl+\\");
    fireEvent.click(btn);
    expect(onCollapse).toHaveBeenCalled();
  });
});

describe("Sidebar: icon rail", () => {
  function renderRail(props: { onCollapse?: () => void; libraryOpen?: boolean; knowledgeOpen?: boolean } = {}) {
    return render(
      <Sidebar
        global={{ ...initialGlobalState, ready: true, agents: [agent] }}
        selectedId={null}
        creating={false}
        onNewChat={() => {}}
        libraryOpen={props.libraryOpen}
        knowledgeOpen={props.knowledgeOpen}
        collapsed
        onCollapse={props.onCollapse ?? (() => {})}
      />,
    );
  }

  it("replaces the full sidebar with expand, Library, Knowledge, one avatar per agent, and Settings", () => {
    renderRail({ libraryOpen: true });
    expect(document.querySelector(".sidebar-rail")).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    expect(screen.getByRole("link", { name: "Library" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Knowledge" }).getAttribute("aria-current")).toBeNull();
    // the star is gone: the agent's own avatar links to its home chat
    expect(screen.queryByRole("button", { name: "Agents" })).toBeNull();
    const agentLink = screen.getByRole("link", { name: agent.name });
    expect(agentLink.getAttribute("href")).toBe(`/s/${encodeURIComponent(agent.homeSessionId)}`);
    expect(agentLink.querySelector(".avatar")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings");
    expect(screen.getByRole("button", { name: "Expand sidebar" }).hasAttribute("data-sidebar-show")).toBe(true);
  });

  it("expands from the expand button", () => {
    const onCollapse = vi.fn();
    renderRail({ onCollapse });
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });
});

describe("Sidebar: settings", () => {
  it("has one Settings entry at the foot, and no other page links or menus there", () => {
    const { rerender } = renderSidebar();
    const link = screen.getByRole("link", { name: "Settings" });
    expect(link.getAttribute("href")).toBe("/settings");
    expect(link.getAttribute("aria-current")).toBeNull();
    const foot = document.querySelector(".sidebar-foot")!;
    expect(foot.querySelectorAll("a, button")).toHaveLength(1);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Account menu" })).toBeNull();
    for (const name of ["Memory", "Triggers", "Skills"]) expect(screen.queryByRole("link", { name })).toBeNull();
    rerender(
      <Sidebar
        global={{ ...initialGlobalState, ready: true, agents: [agent] }}
        selectedId={null}
        settingsOpen
        creating={false}
        onNewChat={() => {}}
      />,
    );
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
  });
});

describe("Sidebar: triggers", () => {
  it("shows user-facing trigger runs and hides hidden ones unless they wait or failed, with a trigger icon and no title tooltip", async () => {
    renderSidebar({
      sessions: [
        session({ id: "t0", origin: "trigger", title: "Daily report", status: "completed" }),
        session({ id: "t1", origin: "trigger", title: "Morning check", status: "completed", hideInList: true }),
        session({ id: "t2", origin: "trigger", title: "Rent reminder", status: "failed", hideInList: true }),
        session({ id: "t3", origin: "trigger", title: "Inbox sweep", status: "waiting_for_user", hideInList: true }),
        session({ id: "s1", title: "Pay the bill" }),
      ],
    });
    expect(screen.getByRole("link", { name: /Daily report/ }).querySelector(".row-kind")).toBeTruthy();
    expect(screen.queryByText("Morning check")).toBeNull();
    const failed = screen.getByRole("link", { name: /Rent reminder/ });
    await userEvent.setup().hover(failed);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(failed.hasAttribute("data-state")).toBe(false);
    expect(failed.querySelector(".row-kind")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Inbox sweep/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Pay the bill/ }).querySelector(".row-kind")).toBeNull();
  });
});

describe("Sidebar session actions", () => {
  const renderWithActions = (
    sessions: ReturnType<typeof session>[],
    callbacks: {
      onRenameSession?: (id: string, title: string) => Promise<void>;
      onDeleteSession?: (id: string) => Promise<void>;
      onPinSession?: (id: string, pinned: boolean) => Promise<void>;
    },
  ) =>
    render(
      <Sidebar
        global={{ ...initialGlobalState, ready: true, agents: [agent], defaultAgentId: "a1", sessions }}
        selectedId={null}
        creating={false}
        onNewChat={() => {}}
        {...callbacks}
      />,
    );

  it("pins a chat and shows pinned chats in their own section", async () => {
    const onPinSession = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderWithActions([session({ id: "s1", title: "Pay the bill" })], { onPinSession });
    openMenu(screen.getByRole("button", { name: "Actions for Pay the bill" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(onPinSession).toHaveBeenCalledWith("s1", true);
    rerender(
      <Sidebar
        global={{
          ...initialGlobalState,
          ready: true,
          agents: [agent],
          defaultAgentId: "a1",
          sessions: [session({ id: "s1", title: "Pay the bill", pinned: true })],
        }}
        selectedId={null}
        creating={false}
        onNewChat={() => {}}
        onPinSession={onPinSession}
      />,
    );
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(within(pinned).getByRole("link", { name: /Pay the bill/ })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Today" })).toBeNull();
    expect(pinned.querySelector('span[aria-label="Pinned"]')).toBeTruthy();
  });

  it("renames a chat through its context menu", async () => {
    const onRenameSession = vi.fn().mockResolvedValue(undefined);
    renderWithActions([session({ id: "s1", title: "Pay the bill" })], { onRenameSession });
    openMenu(screen.getByRole("button", { name: "Actions for Pay the bill" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Chat name" });
    await userEvent.clear(input);
    await userEvent.type(input, "  Bills and budget  ");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onRenameSession).toHaveBeenCalledWith("s1", "Bills and budget"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks before deleting a chat", async () => {
    const onDeleteSession = vi.fn().mockResolvedValue(undefined);
    renderWithActions([session({ id: "s1", title: "Pay the bill" })], { onDeleteSession });
    openMenu(screen.getByRole("button", { name: "Actions for Pay the bill" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("alertdialog").textContent).toContain("Pay the bill");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onDeleteSession).toHaveBeenCalledWith("s1"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

it("shows the selected hidden trigger run and removes it when another chat opens", () => {
  const global = {
    ...initialGlobalState,
    ready: true,
    agents: [agent],
    defaultAgentId: "a1",
    sessions: [
      session({ id: "t1", origin: "trigger", title: "Morning check", status: "completed", hideInList: true }),
      session({ id: "s1", title: "Pay the bill" }),
    ],
  };
  const { rerender } = render(<Sidebar global={global} selectedId="t1" creating={false} onNewChat={() => {}} />);
  expect(screen.getByRole("link", { name: /Morning check/ }).getAttribute("aria-current")).toBe("page");
  rerender(<Sidebar global={global} selectedId="s1" creating={false} onNewChat={() => {}} />);
  expect(screen.queryByRole("link", { name: /Morning check/ })).toBeNull();
  expect(screen.getByRole("link", { name: /Pay the bill/ }).getAttribute("aria-current")).toBe("page");
});

describe("Sidebar: follows the active agent", () => {
  const rex = agentFixture({ id: "a2", name: "Rex", avatar: "R", homeSessionId: "home2" });
  const two = {
    agents: [agent, rex],
    sessions: [
      session({ id: "s1", title: "Pay the bill" }),
      session({ id: "s2", agentId: "a2", title: "Plan the launch" }),
    ],
  };

  it("lists only the active agent's chats, and the default agent's when none is open", () => {
    renderSidebar({ ...two });
    expect(screen.getByRole("link", { name: /Pay the bill/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Plan the launch/ })).toBeNull();
  });

  it("follows the open chat's agent and marks that agent in the Agents list", () => {
    render(
      <Sidebar
        global={{ ...initialGlobalState, ready: true, defaultAgentId: "a1", ...two }}
        selectedId="s2"
        creating={false}
        onNewChat={() => {}}
      />,
    );
    expect(screen.getByRole("link", { name: /Plan the launch/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Pay the bill/ })).toBeNull();
    const agents = within(screen.getByRole("list", { name: "Agents" }));
    expect(agents.getByRole("link", { name: /Rex/ }).getAttribute("aria-current")).toBe("true");
    expect(agents.getByRole("link", { name: /Dot/ }).getAttribute("aria-current")).toBeNull();
  });

  it("says so when the active agent has no chats yet", () => {
    renderSidebar({ ...two, sessions: [session({ id: "s2", agentId: "a2", title: "Plan the launch" })] });
    expect(screen.getByText("No chats yet. Start a chat to begin.")).toBeTruthy();
  });

  it("keeps Waiting for you across agents", () => {
    renderSidebar({
      ...two,
      approvals: [approval({ sessionId: "s2", sessionTitle: "Plan the launch", agentId: "a2" })],
    });
    const group = screen.getByRole("region", { name: "Waiting for you" });
    expect(within(group).getByRole("link").textContent).toContain("Plan the launch");
  });

  it("starts a new chat with the active agent from the New chat button, with no agent menu", () => {
    const onNewChat = vi.fn();
    render(
      <Sidebar
        global={{ ...initialGlobalState, ready: true, defaultAgentId: "a1", ...two }}
        selectedId="s2"
        creating={false}
        onNewChat={onNewChat}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "New chat with another agent" })).toBeNull();
  });

  it("lists hidden trigger runs only while the Hidden trigger sessions filter is on", () => {
    const onShowTriggersChange = vi.fn();
    const global = {
      ...initialGlobalState,
      ready: true,
      agents: [agent],
      defaultAgentId: "a1",
      sessions: [
        session({ id: "s1", title: "Pay the bill" }),
        session({ id: "t1", title: "Nightly digest", origin: "trigger", status: "completed", hideInList: true }),
      ],
    };
    const { rerender } = render(
      <Sidebar
        global={global}
        selectedId={null}
        creating={false}
        onNewChat={() => {}}
        onShowTriggersChange={onShowTriggersChange}
      />,
    );
    expect(screen.queryByText("Nightly digest")).toBeNull();
    openMenu(screen.getByRole("button", { name: "Filter chats" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Hidden trigger sessions" }));
    expect(onShowTriggersChange).toHaveBeenLastCalledWith(true);
    rerender(
      <Sidebar
        global={global}
        selectedId={null}
        creating={false}
        onNewChat={() => {}}
        showTriggers
        onShowTriggersChange={onShowTriggersChange}
      />,
    );
    expect(screen.getByText("Nightly digest")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filter chats" }).getAttribute("data-active")).toBe("true");
  });

  it("offers a New agent button only when the page can make one", () => {
    const { rerender } = renderSidebar();
    expect(screen.queryByRole("button", { name: "New agent" })).toBeNull();
    const onNewAgent = vi.fn();
    rerender(
      <Sidebar
        global={{ ...initialGlobalState, ready: true, agents: [agent], defaultAgentId: "a1" }}
        selectedId={null}
        creating={false}
        onNewChat={() => {}}
        onNewAgent={onNewAgent}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    expect(onNewAgent).toHaveBeenCalled();
  });
});

describe("Sidebar: progressive history", () => {
  it("loads near the end of the scroll area and animates loading without a load-more button", () => {
    let intersect!: IntersectionObserverCallback;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
          intersect = callback;
          expect(options.root).toBe(document.querySelector(".sidebar-scroll"));
          expect(options.rootMargin).toBe("240px");
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    try {
      const load = vi.fn();
      const global = { ...initialGlobalState, ready: true, agents: [agent] };
      const { rerender } = render(
        <Sidebar
          global={global}
          selectedId={null}
          creating={false}
          onNewChat={() => {}}
          pagination={{ loading: false, more: true, error: "", load }}
        />,
      );
      intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      expect(load).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
      rerender(
        <Sidebar
          global={global}
          selectedId={null}
          creating={false}
          onNewChat={() => {}}
          pagination={{ loading: true, more: true, error: "", load }}
        />,
      );
      expect(screen.getByRole("status").textContent).toBe("Loading chats…");
      expect(document.querySelector(".sidebar-page-loading")?.hasAttribute("data-loading")).toBe(true);
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
