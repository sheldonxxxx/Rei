/** Curated first-party MCP endpoints. Credentials remain in the gateway's secret store. */
export const CONNECTOR_CATALOG = [
  {
    id: "notion",
    name: "Notion",
    publisher: "Notion",
    description: "Search and update pages in your workspace.",
    url: "https://mcp.notion.com/mcp",
    docsUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
    preview: false,
  },
  {
    id: "gmail",
    name: "Gmail",
    publisher: "Google",
    description: "Search email threads and create drafts.",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    docsUrl: "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server",
    preview: true,
  },
] as const;

export type CatalogConnector = (typeof CONNECTOR_CATALOG)[number];

/** Treat the optional trailing slash as the same endpoint, without trusting a matching name or host. */
export function matchesCatalogUrl(url: string, entry: CatalogConnector): boolean {
  try {
    const actual = new URL(url);
    const expected = new URL(entry.url);
    return (
      actual.origin === expected.origin &&
      actual.pathname.replace(/\/$/, "") === expected.pathname &&
      actual.search === "" &&
      actual.hash === "" &&
      actual.username === "" &&
      actual.password === ""
    );
  } catch {
    return false;
  }
}
