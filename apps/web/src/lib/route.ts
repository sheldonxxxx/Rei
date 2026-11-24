import { useCallback, useEffect, useState } from "react";

/**
 * Path routes: "/s/<sessionId>" is a chat, "/s/<sessionId>?m=<messageId>" the same chat opened at one message (it scrolls
 * there and highlights it briefly), anything else is the list. A route is a path with its query ("/s/abc?m=x"). The old
 * hash form ("#/s/abc?m=x") still parses, and `redirectHashRoute` moves the address to the path form.
 */
export function parseRoute(route: string): string | null {
  return parseChatRoute(route).sessionId;
}

/** The path form of a route; an old hash route ("#/s/x") loses its "#". */
const pathOf = (route: string): string => (route.startsWith("#/") ? route.slice(1) : route);

export function parseChatRoute(route: string): { sessionId: string | null; messageId: string | null } {
  const m = /^\/s\/([^?]+)(?:\?(.*))?$/.exec(pathOf(route));
  if (!m?.[1]) return { sessionId: null, messageId: null };
  try {
    return { sessionId: decodeURIComponent(m[1]), messageId: new URLSearchParams(m[2] ?? "").get("m") || null };
  } catch {
    return { sessionId: null, messageId: null };
  }
}

/** The link to a chat, or to one message in it. */
export function sessionHref(sessionId: string, messageId?: string | null): string {
  return `/s/${encodeURIComponent(sessionId)}${messageId ? `?m=${encodeURIComponent(messageId)}` : ""}`;
}

export type SettingsSection =
  | "general"
  | "usage"
  | "memory"
  | "triggers"
  | "plugins"
  | "skills"
  | "connectors"
  | "models"
  | "runtime"
  | "providers"
  | "permissions";
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  "general",
  "providers",
  "models",
  "runtime",
  "memory",
  "plugins",
  "triggers",
  "permissions",
  "usage",
];

export const SETTINGS_PATH = "/settings";
export const PERMISSIONS_PATH = `${SETTINGS_PATH}/permissions`;
export const MEMORY_PATH = `${SETTINGS_PATH}/memory`;
export const TRIGGERS_PATH = `${SETTINGS_PATH}/triggers`;
export const CONNECTORS_PATH = `${SETTINGS_PATH}/connectors`;
export const SKILLS_PATH = `${SETTINGS_PATH}/skills`;
export const PLUGINS_PATH = `${SETTINGS_PATH}/plugins`;

/** The link to a Settings section, or to one trigger or skill in it. */
export const settingsHref = (section: SettingsSection, id?: string | null) =>
  `${SETTINGS_PATH}/${section}${id ? `/${encodeURIComponent(id)}` : ""}`;
export const triggerHref = (id: string) => settingsHref("triggers", id);
export const skillHref = (id: string) => settingsHref("skills", id);
export const connectorHref = (id: string) => settingsHref("connectors", id);
export const pluginHref = (id: string) => settingsHref("plugins", id);
/** The three views of Settings → Capabilities, each its own section in the address. */
export const CAPABILITY_VIEWS = ["plugins", "skills", "connectors"] as const;
export type CapabilityView = (typeof CAPABILITY_VIEWS)[number];
export const isCapabilityView = (s: SettingsSection | null): s is CapabilityView =>
  s === "plugins" || s === "skills" || s === "connectors";

export interface SettingsRoute {
  /** Null for "/settings" alone: General on a wide screen, the list of sections on a phone. */
  section: SettingsSection | null;
  /** The open trigger, skill, connector or provider tab; null on a section's list. */
  id: string | null;
}

/** Parses the Settings window and optional detail selection. */
export function parseSettingsRoute(route: string): SettingsRoute | null {
  const m = /^\/(settings)(?:\/([^?]*))?(?:\?.*)?$/.exec(pathOf(route));
  if (!m) return null;
  const rest = (m[2] ?? "").split("/");
  const [name, raw] = [rest[0] ?? "", rest.length === 2 ? rest[1] : ""];
  if (name === "embedding" || name === "search") return { section: "providers", id: name };
  const section =
    name === "skills" || name === "connectors" ? name : (SETTINGS_SECTIONS.find((s) => s === name) ?? null);
  if (!section) return { section: null, id: null };
  if (section === "providers")
    return { section, id: raw === "embedding" || raw === "search" || raw === "images" ? raw : null };
  if (section !== "triggers" && section !== "plugins" && section !== "skills" && section !== "connectors")
    return { section, id: null };
  try {
    return { section, id: raw ? decodeURIComponent(raw) : null };
  } catch {
    return { section, id: null };
  }
}

export const KNOWLEDGE_PATH = "/knowledge";
/** The link to a Knowledge page, or to the overview (null). */
export const knowledgeHref = (pageId?: string | null) =>
  pageId ? `${KNOWLEDGE_PATH}/${encodeURIComponent(pageId)}` : KNOWLEDGE_PATH;

/** "/knowledge" is the overview; "/knowledge/trash" the Trash; "/knowledge/<id>" a page. */
export function parseKnowledgeRoute(route: string): { knowledge: boolean; knowledgePageId: string | null } {
  const m = /^\/knowledge(?:\/([^?]*))?(?:\?.*)?$/.exec(pathOf(route));
  if (!m) return { knowledge: false, knowledgePageId: null };
  try {
    return { knowledge: true, knowledgePageId: m[1] ? decodeURIComponent(m[1]) : null };
  } catch {
    return { knowledge: true, knowledgePageId: null };
  }
}

/** "/library" is the file library; "/library/<fileId>" one file in it. */
export function parseLibraryRoute(route: string): { library: boolean; libraryFileId: string | null } {
  const m = /^\/library(?:\/([^?]*))?(?:\?.*)?$/.exec(pathOf(route));
  if (!m) return { library: false, libraryFileId: null };
  try {
    return { library: true, libraryFileId: m[1] ? decodeURIComponent(m[1]) : null };
  } catch {
    return { library: true, libraryFileId: null };
  }
}

/** The event `navigate` sends, so every `useLocation` sees an address change that pushState does not announce. */
const ROUTE_EVENT = "rei:route";

/** The current route: the address's path and query. */
export const currentRoute = (): string => window.location.pathname + window.location.search;

/** Moves the app to a route ("/s/abc", "/settings/memory") without reloading, as a new history entry unless `replace`. */
export function navigate(route: string, options: { replace?: boolean } = {}): void {
  const to = pathOf(route);
  if (to === currentRoute() && !window.location.hash) return;
  if (options.replace) window.history.replaceState(window.history.state, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

/**
 * An old hash link ("/#/s/abc?m=x", from a bookmark or a cached service worker) becomes its path
 * ("/s/abc?m=x") in place. Any other hash (an in-page anchor) is left alone. Answers whether it moved.
 */
export function redirectHashRoute(): boolean {
  const hash = window.location.hash;
  if (!hash.startsWith("#/")) return false;
  window.history.replaceState(window.history.state, "", hash.slice(1));
  window.dispatchEvent(new Event(ROUTE_EVENT));
  return true;
}

/** Whether a click on a link should stay in the app: a plain left click on a same-origin app route, with no target. */
function appLink(event: MouseEvent): HTMLAnchorElement | null {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return null;
  const a = (event.target as Element | null)?.closest?.("a");
  if (!a || !(a instanceof HTMLAnchorElement)) return null;
  if ((a.target && a.target !== "_self") || a.hasAttribute("download")) return null;
  const href = a.getAttribute("href") ?? "";
  if (!href.startsWith("/") || href.startsWith("//") || href.startsWith("/api/") || href === "/api") return null;
  return a;
}

/** Listeners on window and document, installed once however many components read the route. */
let listeners = 0;
const onLinkClick = (event: MouseEvent): void => {
  const a = appLink(event);
  if (!a) return;
  event.preventDefault();
  navigate(a.getAttribute("href")!);
};

/** The current route, kept in step with back/forward, `navigate`, app links and old hash links. */
export function useLocation(): string {
  const [route, setRoute] = useState(() => {
    redirectHashRoute();
    return currentRoute();
  });
  useEffect(() => {
    const on = () => {
      if (window.location.hash.startsWith("#/")) redirectHashRoute();
      setRoute(currentRoute());
    };
    if (listeners++ === 0) document.addEventListener("click", onLinkClick);
    window.addEventListener(ROUTE_EVENT, on);
    window.addEventListener("popstate", on);
    window.addEventListener("hashchange", on);
    on();
    return () => {
      if (--listeners === 0) document.removeEventListener("click", onLinkClick);
      window.removeEventListener(ROUTE_EVENT, on);
      window.removeEventListener("popstate", on);
      window.removeEventListener("hashchange", on);
    };
  }, []);
  return route;
}

/**
 * The address's fragment (an in-page anchor, still percent-encoded) and a count that grows with every move, so following
 * the same anchor link twice can scroll twice.
 */
export function useHash(): { hash: string; moves: number } {
  const [state, setState] = useState(() => ({ hash: window.location.hash, moves: 0 }));
  useEffect(() => {
    const on = () => setState((s) => ({ hash: window.location.hash, moves: s.moves + 1 }));
    window.addEventListener(ROUTE_EVENT, on);
    window.addEventListener("popstate", on);
    window.addEventListener("hashchange", on);
    return () => {
      window.removeEventListener(ROUTE_EVENT, on);
      window.removeEventListener("popstate", on);
      window.removeEventListener("hashchange", on);
    };
  }, []);
  return state;
}

/** The open chat's id (null: the list) and the message it was opened at, and the Settings window's section while it is open. */
export function useRoute(): {
  sessionId: string | null;
  messageId: string | null;
  settings: SettingsRoute | null;
  library: boolean;
  libraryFileId: string | null;
  /** "/knowledge" (the overview) or "/knowledge/<pageId>". */
  knowledge: boolean;
  knowledgePageId: string | null;
  background: boolean;
  backgroundRoute: string;
  go: (id: string | null) => void;
} {
  const route = useLocation();
  const go = useCallback((next: string | null) => navigate(next ? sessionHref(next) : "/"), []);
  return {
    ...parseChatRoute(route),
    settings: parseSettingsRoute(route),
    ...parseLibraryRoute(route),
    ...parseKnowledgeRoute(route),
    background: /^\/background(?:\/|\?|$)/.test(route),
    backgroundRoute: route,
    go,
  };
}

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}
