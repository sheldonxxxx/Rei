import { createContext, useContext } from "react";

/** Connector names by id, so a connector tool's approval card and grant can say "Notion" rather than its id. */
export const ConnectorNamesContext = createContext<ReadonlyMap<string, string>>(new Map());

export const useConnectorNames = () => useContext(ConnectorNamesContext);

/** A connector tool's grant destination is "<connectorId>.<tool>": the app's name (when known) and the tool. */
export function mcpTarget(
  destination: string | null,
  names: ReadonlyMap<string, string>,
): { app: string; tool: string } | null {
  if (!destination) return null;
  const dot = destination.indexOf(".");
  if (dot <= 0) return null;
  return { app: names.get(destination.slice(0, dot)) ?? "A connected app", tool: destination.slice(dot + 1) };
}
