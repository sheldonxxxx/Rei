import type { Connector, ConnectorTool } from "@rei/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.ts";
import { currentRoute, navigate } from "../lib/route.ts";
import { ConnectorsPage, nameFromUrl } from "./ConnectorsPage.tsx";

const conn = (over: Partial<Connector> = {}): Connector => ({
  id: "con_1",
  name: "Notes",
  url: "https://notes.example/mcp",
  auth: "oauth",
  status: "connected",
  error: null,
  toolCount: 2,
  createdAt: 1,
  holdsPrivate: true,
  mcpProfile: "always_ask",
  mcpProfileRevision: "fixture-revision",
  providerIdentity: "fixture-identity",
  ...over,
});
const tool = (name: string, over: Partial<ConnectorTool> = {}): ConnectorTool => ({
  name,
  title: null,
  description: `${name} does a thing`,
  inputSchema: {},
  annotations: {},
  defaultClass: "write_external",
  override: null,
  definitionFingerprint: "a".repeat(64),
  ...over,
});

function makeApi(over: Record<string, unknown> = {}) {
  return {
    getConnectors: vi.fn().mockResolvedValue({
      connectors: [
        conn(),
        conn({ id: "con_2", name: "Mail", url: "https://mail.example/mcp", status: "needs_auth", toolCount: null }),
        conn({ id: "con_3", name: "Cal", status: "error", error: "It broke" }),
      ],
    }),
    createConnector: vi.fn().mockResolvedValue({ connector: conn({ id: "con_9", status: "needs_auth" }) }),
    updateConnector: vi.fn().mockImplementation(async (_id, req) => ({ connector: conn(req) })),
    deleteConnector: vi.fn().mockResolvedValue(undefined),
    getConnectorTools: vi
      .fn()
      .mockResolvedValue({ tools: [tool("search", { override: "read_external" }), tool("add")], fetchedAt: 1 }),
    setToolClass: vi.fn().mockResolvedValue({ ok: true }),
    setMcpProfile: vi.fn().mockImplementation(async (_id, profile) => ({ connector: conn({ mcpProfile: profile }) })),
    startConnectorSignIn: vi.fn().mockResolvedValue({ authorizationUrl: "https://auth.example/go" }),
    finishConnectorSignIn: vi.fn().mockResolvedValue({ connector: conn() }),
    ...over,
  };
}
const renderPage = (api: ReturnType<typeof makeApi>, id: string | null = null, navigate = vi.fn()) => {
  render(<ConnectorsPage api={api as never} id={id} navigate={navigate} />);
  return navigate;
};

beforeEach(() => {
  navigate("/settings/connectors");
});
afterEach(cleanup);

describe("Connectors list", () => {
  it("creates a connector with a custom token header and no OAuth sign-in", async () => {
    const api = makeApi({
      createConnector: vi.fn().mockResolvedValue({ connector: conn({ auth: "token", status: "needs_auth" }) }),
    });
    renderPage(api);
    fireEvent.change(await screen.findByLabelText("Address"), { target: { value: "https://notes.example/mcp" } });
    fireEvent.click(screen.getByText("Use a token instead"));
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "fixture-key" } });
    fireEvent.change(screen.getByLabelText("Token header name"), { target: { value: "X-Api-Key" } });
    fireEvent.click(screen.getByRole("button", { name: "Add connector" }));
    await waitFor(() =>
      expect(api.createConnector).toHaveBeenCalledWith({
        name: "Notes",
        url: "https://notes.example/mcp",
        token: "fixture-key",
        tokenHeader: "X-Api-Key",
      }),
    );
    expect(api.startConnectorSignIn).not.toHaveBeenCalled();
  });

  it("edits a token header without exposing or replacing the saved token", async () => {
    const api = makeApi({
      getConnectors: vi.fn().mockResolvedValue({ connectors: [conn({ auth: "token", tokenHeader: "X-Old-Key" })] }),
      updateConnector: vi.fn().mockResolvedValue({ connector: conn({ auth: "token", tokenHeader: "X-Api-Key" }) }),
    });
    renderPage(api, "con_1");
    const header = await screen.findByLabelText<HTMLInputElement>("Token header name");
    expect(header.value).toBe("X-Old-Key");
    expect(screen.getByLabelText<HTMLInputElement>("Token").value).toBe("");
    fireEvent.change(header, { target: { value: "X-Api-Key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save authentication" }));
    await waitFor(() => expect(api.updateConnector).toHaveBeenCalledWith("con_1", { tokenHeader: "X-Api-Key" }));
  });

  it("shows each connector's owner and its plugin's state, leaving agent access to agent settings", async () => {
    const api = makeApi({
      getConnectors: vi.fn().mockResolvedValue({
        connectors: [
          conn({ plugin: null }),
          conn({ id: "con_2", name: "Mail", plugin: { id: "p1", name: "mail-kit", enabled: false } }),
        ],
      }),
    });
    render(<ConnectorsPage api={api as never} id={null} />);
    const rows = within(await screen.findByRole("list", { name: "Connectors" })).getAllByRole("link");
    expect(rows[0]!.textContent).toContain("Standalone");
    expect(rows[1]!.textContent).toContain("Plugin: mail-kit");
    expect(rows[1]!.textContent).toContain("Plugin disabled");
    expect(screen.getByText(/Choose which agents may use each one in the agent's settings/)).toBeTruthy();
  });

  it("says in a connector's detail whether a plugin owns it", async () => {
    const api = makeApi({
      getConnectors: vi
        .fn()
        .mockResolvedValue({ connectors: [conn({ plugin: { id: "p1", name: "notes-kit", enabled: true } })] }),
    });
    renderPage(api, "con_1");
    const link = await screen.findByRole("link", { name: "notes-kit" });
    expect(link.getAttribute("href")).toBe("/settings/plugins/p1");
    cleanup();
    renderPage(
      makeApi({ getConnectors: vi.fn().mockResolvedValue({ connectors: [conn({ plugin: null })] }) }),
      "con_1",
    );
    expect(await screen.findByText("Standalone: no plugin owns it")).toBeTruthy();
  });

  it("sets up Notion straight into the curated endpoint's OAuth flow, with no separate add step", async () => {
    const api = makeApi();
    const navigate = renderPage(api);
    fireEvent.click(await screen.findByRole("button", { name: "Set up Notion" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://auth.example/go"));
    expect(api.createConnector).toHaveBeenCalledWith({ name: "Notion", url: "https://mcp.notion.com/mcp" });
    expect(api.startConnectorSignIn).toHaveBeenCalledWith("con_9", {});
    expect(screen.queryByRole("button", { name: "Add connector" })).toBeNull();
  });

  it("explains Gmail prerequisites, then asks for OAuth credentials only when the server needs them", async () => {
    const api = makeApi({
      startConnectorSignIn: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(400, "client_id_required", "x"))
        .mockResolvedValue({ authorizationUrl: "https://auth.example/google" }),
    });
    const navigate = renderPage(api);
    fireEvent.click(await screen.findByRole("button", { name: "Set up Gmail" }));
    expect(screen.getByText(/Requires Google Workspace Developer Preview access/).textContent).toContain(
      "/api/mcp/oauth/callback",
    );
    expect(api.createConnector).toHaveBeenCalledWith({ name: "Gmail", url: "https://gmailmcp.googleapis.com/mcp/v1" });
    fireEvent.change(await screen.findByLabelText("Client ID"), { target: { value: "google-client" } });
    fireEvent.change(screen.getByLabelText(/Client secret/), { target: { value: "fixture-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to sign in" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://auth.example/google"));
    expect(api.createConnector).toHaveBeenCalledTimes(1);
    expect(api.startConnectorSignIn).toHaveBeenLastCalledWith("con_9", {
      clientId: "google-client",
      clientSecret: "fixture-secret",
    });
  });

  it("opens an existing catalog connector even when it is renamed or needs sign-in", async () => {
    const api = makeApi({
      getConnectors: vi.fn().mockResolvedValue({
        connectors: [conn({ name: "Work wiki", url: "https://mcp.notion.com/mcp/", status: "needs_auth" })],
      }),
    });
    renderPage(api);
    expect((await screen.findByRole("link", { name: "Manage Notion" })).getAttribute("href")).toBe(
      "/settings/connectors/con_1",
    );
    expect(screen.queryByRole("button", { name: "Set up Notion" })).toBeNull();
    expect(api.createConnector).not.toHaveBeenCalled();
  });

  it("clears a catalog pick's values when switching to a custom connector", async () => {
    renderPage(
      makeApi({ startConnectorSignIn: vi.fn().mockRejectedValue(new ApiError(400, "client_id_required", "x")) }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Set up Gmail" }));
    await screen.findByLabelText("Client ID");
    fireEvent.click(screen.getByRole("button", { name: "Use a custom connector" }));
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("");
    expect(screen.queryByText(/Requires Google Workspace Developer Preview access/)).toBeNull();
  });

  it("retries failed sign-in without creating the connector twice", async () => {
    const api = makeApi({
      startConnectorSignIn: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(502, "oauth_failed", "x"))
        .mockResolvedValue({ authorizationUrl: "https://auth.example/retry" }),
    });
    const navigate = renderPage(api);
    fireEvent.click(await screen.findByRole("button", { name: "Set up Notion" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try sign-in again" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://auth.example/retry"));
    expect(api.createConnector).toHaveBeenCalledTimes(1);
  });

  it("shows name, host, status and tool count", async () => {
    renderPage(makeApi());
    const list = await screen.findByRole("list", { name: "Connectors" });
    const items = within(list).getAllByRole("link");
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain("Notes");
    expect(items[0]!.textContent).toContain("notes.example");
    expect(items[0]!.textContent).toContain("Connected");
    expect(items[0]!.textContent).toContain("2 tools");
    expect(items[0]!.getAttribute("href")).toBe("/settings/connectors/con_1");
    expect(items[1]!.textContent).toContain("Needs sign-in");
    expect(items[2]!.textContent).toContain("Error");
    expect(items[2]!.textContent).toContain("It broke");
  });

  it("adds by address with the name filled from the host, then goes straight to sign-in when it needs one", async () => {
    const api = makeApi();
    const navigate = renderPage(api);
    fireEvent.change(await screen.findByLabelText("Address"), { target: { value: "https://tasks.example.com/mcp" } });
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Example");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Tasks" } });
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "https://tasks.example.com/other" } });
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Tasks"); // edited names stay
    fireEvent.click(screen.getByRole("button", { name: "Add connector" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://auth.example/go"));
    expect(api.createConnector).toHaveBeenCalledWith({ url: "https://tasks.example.com/other", name: "Tasks" });
    expect(api.startConnectorSignIn).toHaveBeenCalledWith("con_9", {});
  });

  it("sends a token when one is given and does not sign in a connected one", async () => {
    const api = makeApi({
      createConnector: vi
        .fn()
        .mockResolvedValue({ connector: conn({ id: "con_8", auth: "token", status: "connected" }) }),
    });
    const navigate = renderPage(api);
    fireEvent.change(await screen.findByLabelText("Address"), { target: { value: "https://t.example/mcp" } });
    fireEvent.click(screen.getByText("Use a token instead"));
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "sekret" } });
    fireEvent.click(screen.getByRole("button", { name: "Add connector" }));
    await waitFor(() =>
      expect(api.createConnector).toHaveBeenCalledWith({ url: "https://t.example/mcp", name: "T", token: "sekret" }),
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(api.startConnectorSignIn).not.toHaveBeenCalled();
  });

  it("asks for a client ID when the server can't register one, and continues with it", async () => {
    const start = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(400, "client_id_required", "x"))
      .mockResolvedValue({ authorizationUrl: "https://auth.example/go2" });
    const api = makeApi({ startConnectorSignIn: start });
    const navigate = renderPage(api);
    fireEvent.change(await screen.findByLabelText("Address"), { target: { value: "https://t.example/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Add connector" }));
    expect(await screen.findByText(/can't set up sign-in by itself/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "abc" } });
    fireEvent.change(screen.getByLabelText(/Client secret/), { target: { value: "shh" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to sign in" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://auth.example/go2"));
    expect(start).toHaveBeenLastCalledWith("con_9", { clientId: "abc", clientSecret: "shh" });
  });

  it("shows an add error as a sentence", async () => {
    const api = makeApi({ createConnector: vi.fn().mockRejectedValue(new ApiError(400, "bad_url", "x")) });
    renderPage(api);
    fireEvent.change(await screen.findByLabelText("Address"), { target: { value: "http://x" } });
    fireEvent.click(screen.getByRole("button", { name: "Add connector" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/isn't an address/);
  });
});

describe("coming back from sign-in", () => {
  it("finishes with what the hash carries, removes it from the address at once, and says it worked", async () => {
    navigate("/settings/connectors?state=ST&code=CO&iss=https%3A%2F%2Fa.example");
    const api = makeApi();
    renderPage(api);
    expect(currentRoute()).toBe("/settings/connectors");
    expect(window.location.href).not.toContain("code=");
    await waitFor(() =>
      expect(api.finishConnectorSignIn).toHaveBeenCalledWith({ state: "ST", code: "CO", iss: "https://a.example" }),
    );
    expect((await screen.findByRole("status", { name: "" })).textContent ?? "").toBeDefined();
    expect(await screen.findByText("Signed in to Notes.")).toBeTruthy();
  });

  it("shows the error when the finish fails, and when the provider said no", async () => {
    navigate("/settings/connectors?state=ST&code=CO");
    renderPage(makeApi({ finishConnectorSignIn: vi.fn().mockRejectedValue(new ApiError(400, "state_expired", "x")) }));
    expect(await screen.findByText(/took too long/)).toBeTruthy();
    cleanup();
    navigate("/settings/connectors?oauth_error=access%20denied");
    const api = makeApi();
    renderPage(api);
    expect(await screen.findByText(/Sign-in didn't complete: access denied/)).toBeTruthy();
    expect(api.finishConnectorSignIn).not.toHaveBeenCalled();
    expect(currentRoute()).toBe("/settings/connectors");
  });
});

describe("Connector detail", () => {
  it("selects Read-only separately from Holds my data and confirms YOLO explicitly", async () => {
    const api = makeApi();
    renderPage(api, "con_1");
    const select = await screen.findByRole("combobox", { name: "MCP permission profile" });
    expect(screen.getByText(/asks before every other action/)).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Holds my data" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.change(select, { target: { value: "read_only" } });
    await waitFor(() =>
      expect(api.setMcpProfile).toHaveBeenCalledWith(
        "con_1",
        "read_only",
        "fixture-identity",
        "fixture-revision",
        false,
      ),
    );
    api.setMcpProfile.mockClear();
    fireEvent.change(select, { target: { value: "yolo" } });
    const dialog = await screen.findByRole("alertdialog", { name: "Enable YOLO for this connector?" });
    expect(api.setMcpProfile).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/permanently lost/)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.setMcpProfile).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: "yolo" } });
    fireEvent.click(await screen.findByRole("button", { name: "Enable YOLO, including irreversible actions" }));
    await waitFor(() =>
      expect(api.setMcpProfile).toHaveBeenCalledWith("con_1", "yolo", "fixture-identity", "fixture-revision", true),
    );
    expect(api.updateConnector).not.toHaveBeenCalled();
  });

  it.each(["always_ask", "read_only", "read_write", "yolo"] as const)(
    "explains the destructive classification floor without promising approval in %s",
    async (mcpProfile) => {
      const api = makeApi({
        getConnectors: vi.fn().mockResolvedValue({ connectors: [conn({ mcpProfile })] }),
        getConnectorTools: vi.fn().mockResolvedValue({
          tools: [
            tool("danger", {
              defaultClass: "irreversible",
              override: "read_external",
              effectiveClass: "irreversible",
            }),
          ],
          fetchedAt: 1,
        }),
      });
      renderPage(api, "con_1");
      const select = (await screen.findByLabelText("Class of danger")) as HTMLSelectElement;
      expect(select.value).toBe("irreversible");
      expect(select.disabled).toBe(true);
      await userEvent.hover(screen.getByRole("button", { name: "Why danger cannot be changed" }));
      expect((await screen.findByRole("tooltip")).textContent).toContain(
        "This tool is classified as irreversible and cannot be downgraded. Whether approval is required depends on the connector MCP permission profile.",
      );
    },
  );

  it("shows status, tools with their default marked, and lets a class be changed and reset", async () => {
    const api = makeApi({
      getConnectorTools: vi.fn().mockResolvedValue({
        tools: [
          tool("search", { override: "read_external", effectiveClass: "read_external" }),
          tool("add", { override: "send" }),
        ],
        fetchedAt: 1,
      }),
    });
    renderPage(api, "con_1");
    const select = (await screen.findByLabelText("Class of search")) as HTMLSelectElement;
    expect(select.value).toBe("read_external");
    expect(within(select).getByRole("option", { name: "Write (default)" })).toBeTruthy();
    expect((screen.getByLabelText("Class of add") as HTMLSelectElement).value).toBe("send");
    fireEvent.change(select, { target: { value: "irreversible" } });
    await waitFor(() =>
      expect(api.setToolClass).toHaveBeenCalledWith("con_1", "search", "irreversible", "a".repeat(64)),
    );
    // Only a tool with an override has Reset.
    const resets = await screen.findAllByRole("button", { name: "Reset" });
    expect(resets).toHaveLength(2);
    fireEvent.click(resets[1]!);
    await waitFor(() => expect(api.setToolClass).toHaveBeenCalledWith("con_1", "add", null, "a".repeat(64)));
    // Choosing the default again clears the override.
    fireEvent.change(screen.getByLabelText("Class of search"), { target: { value: "write_external" } });
    await waitFor(() => expect(api.setToolClass).toHaveBeenCalledWith("con_1", "search", null, "a".repeat(64)));
  });

  it("toggles Holds my data, renames, and refreshes the tools", async () => {
    const api = makeApi();
    renderPage(api, "con_1");
    const sw = await screen.findByRole("switch", { name: "Holds my data" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await userEvent.hover(screen.getByRole("button", { name: "About private data" }));
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "marks the chat as having read your private data",
    );
    await userEvent.unhover(screen.getByRole("button", { name: "About private data" }));
    fireEvent.click(sw);
    await waitFor(() => expect(api.updateConnector).toHaveBeenCalledWith("con_1", { holdsPrivate: false }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Holds my data" }).getAttribute("aria-checked")).toBe("false"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit connector name" }));
    fireEvent.change(screen.getByLabelText("Connector name"), { target: { value: "My notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateConnector).toHaveBeenCalledWith("con_1", { name: "My notes" }));
    expect(screen.queryByLabelText("Connector name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh tools" }));
    await waitFor(() => expect(api.getConnectorTools).toHaveBeenCalledWith("con_1", true));
  });

  it("lets a connector in error retry, and shows it connected after the tools load", async () => {
    const broken = conn({ id: "con_3", name: "Cal", status: "error", error: "It broke" });
    const api = makeApi({
      getConnectors: vi
        .fn()
        .mockResolvedValueOnce({ connectors: [broken] })
        .mockResolvedValue({ connectors: [conn({ id: "con_3", name: "Cal" })] }),
    });
    renderPage(api, "con_3");
    // Opening the page tries the tools again, and the refresh button stays usable.
    await waitFor(() => expect(api.getConnectorTools).toHaveBeenCalledWith("con_3", false));
    await waitFor(() => expect(screen.getByText(/Connected/i)).toBeTruthy());
    const refresh = screen.getByRole("button", { name: "Refresh tools" }) as HTMLButtonElement;
    expect(refresh.disabled).toBe(false);
  });

  it("keeps Refresh tools enabled while a connector is in error and still failing", async () => {
    const api = makeApi({
      getConnectors: vi.fn().mockResolvedValue({
        connectors: [conn({ id: "con_3", name: "Cal", status: "error", error: "It broke" })],
      }),
      getConnectorTools: vi.fn().mockRejectedValue(new ApiError(502, "mcp_error", "It broke")),
    });
    renderPage(api, "con_3");
    const refresh = (await screen.findByRole("button", { name: "Refresh tools" })) as HTMLButtonElement;
    await waitFor(() => expect(api.getConnectorTools).toHaveBeenCalledWith("con_3", false));
    await waitFor(() => expect(refresh.disabled).toBe(false));
    fireEvent.click(refresh);
    await waitFor(() => expect(api.getConnectorTools).toHaveBeenCalledWith("con_3", true));
  });

  it("offers Sign in again when it needs sign-in, and goes to the provider", async () => {
    const api = makeApi();
    const navigate = renderPage(api, "con_2");
    fireEvent.click(await screen.findByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://auth.example/go"));
    expect(api.startConnectorSignIn).toHaveBeenCalledWith("con_2", {});
    expect(api.getConnectorTools).not.toHaveBeenCalled();
    expect(screen.getByText("Sign in to see this connector's tools.")).toBeTruthy();
  });

  it("removes only after a confirmation, then goes back to the list", async () => {
    const api = makeApi();
    renderPage(api, "con_1");
    fireEvent.click(await screen.findByRole("button", { name: /Remove connector/ }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.deleteConnector).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Remove connector/ }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.deleteConnector).toHaveBeenCalledWith("con_1"));
    await waitFor(() => expect(currentRoute()).toBe("/settings/connectors"));
  });

  it("says so for an unknown connector", async () => {
    renderPage(makeApi(), "con_zzz");
    expect(await screen.findByText("That connector no longer exists.")).toBeTruthy();
  });
});

describe("nameFromUrl", () => {
  it("names a connector after the service, not the host", () => {
    expect(nameFromUrl("https://mcp.notion.com/mcp")).toBe("Notion");
    expect(nameFromUrl("https://www.linear.app/sse")).toBe("Linear");
    expect(nameFromUrl("mcp.example.com:8443/mcp")).toBe("Example");
    expect(nameFromUrl("https://localhost:3000/mcp")).toBe("Localhost");
  });
});
