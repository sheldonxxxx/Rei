import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  knowledgeHref,
  navigate,
  parseChatRoute,
  parseKnowledgeRoute,
  parseLibraryRoute,
  parseSettingsRoute,
  redirectHashRoute,
  sessionHref,
  settingsHref,
  skillHref,
  triggerHref,
  useRoute,
} from "./route.ts";

afterEach(() => window.history.replaceState(null, "", "/"));

describe("chat, knowledge and library routes", () => {
  it("reads a chat and the message it opens at, in the path form and the old hash form", () => {
    for (const prefix of ["", "#"]) {
      expect(parseChatRoute(`${prefix}/s/ses_1`)).toEqual({ sessionId: "ses_1", messageId: null });
      expect(parseChatRoute(`${prefix}/s/ses%201?m=a%3Arun_1`)).toEqual({ sessionId: "ses 1", messageId: "a:run_1" });
      expect(parseKnowledgeRoute(`${prefix}/knowledge/pg_1`)).toEqual({ knowledge: true, knowledgePageId: "pg_1" });
      expect(parseLibraryRoute(`${prefix}/library/fil_1`)).toEqual({ library: true, libraryFileId: "fil_1" });
      expect(parseSettingsRoute(`${prefix}/settings/memory`)).toEqual({ section: "memory", id: null });
    }
    expect(parseChatRoute("/")).toEqual({ sessionId: null, messageId: null });
    expect(parseChatRoute("/s/%E0%A4%A")).toEqual({ sessionId: null, messageId: null });
    expect(parseKnowledgeRoute("/knowledge")).toEqual({ knowledge: true, knowledgePageId: null });
    expect(parseLibraryRoute("/library")).toEqual({ library: true, libraryFileId: null });
    expect(parseLibraryRoute("/libraryx")).toEqual({ library: false, libraryFileId: null });
  });

  it("builds path links that parse back", () => {
    expect(sessionHref("a b", "a:1")).toBe("/s/a%20b?m=a%3A1");
    expect(parseChatRoute(sessionHref("a b", "a:1"))).toEqual({ sessionId: "a b", messageId: "a:1" });
    expect(knowledgeHref("pg 1")).toBe("/knowledge/pg%201");
    expect(knowledgeHref(null)).toBe("/knowledge");
  });
});

describe("address", () => {
  it("moves an old hash link to its path, keeping the message, and leaves other hashes alone", () => {
    window.history.replaceState(null, "", "/#/s/ses_1?m=a%3Ax");
    expect(redirectHashRoute()).toBe(true);
    expect(window.location.pathname + window.location.search).toBe("/s/ses_1?m=a%3Ax");
    expect(window.location.hash).toBe("");
    window.history.replaceState(null, "", "/s/ses_1#top");
    expect(redirectHashRoute()).toBe(false);
    expect(window.location.hash).toBe("#top");
  });

  it("follows navigate, back, old hash links and clicks on app links", async () => {
    const { result } = renderHook(() => useRoute());
    expect(result.current.sessionId).toBeNull();
    act(() => navigate("/s/ses_1?m=a%3Ax"));
    expect(result.current).toMatchObject({ sessionId: "ses_1", messageId: "a:x" });
    act(() => result.current.go(null));
    expect(window.location.pathname).toBe("/");
    expect(result.current.sessionId).toBeNull();

    act(() => {
      window.location.hash = "#/settings/memory";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(window.location.pathname).toBe("/settings/memory");
    expect(result.current.settings).toEqual({ section: "memory", id: null });

    const link = document.createElement("a");
    link.href = "/knowledge/pg_1";
    link.textContent = "page";
    document.body.append(link);
    act(() => link.click());
    expect(window.location.pathname).toBe("/knowledge/pg_1");
    expect(result.current.knowledgePageId).toBe("pg_1");

    // A link to somewhere else, or opened in a new tab, is left to the browser.
    const outside = document.createElement("a");
    outside.href = "https://example.com/";
    outside.addEventListener("click", (e) => e.preventDefault());
    document.body.append(outside);
    act(() => outside.click());
    expect(window.location.pathname).toBe("/knowledge/pg_1");
    link.remove();
    outside.remove();
  });
});

describe("parseSettingsRoute", () => {
  it("knows each section, and /settings alone", () => {
    expect(parseSettingsRoute("/settings")).toEqual({ section: null, id: null });
    expect(parseSettingsRoute("/settings/")).toEqual({ section: null, id: null });
    expect(parseSettingsRoute("/settings/general")).toEqual({ section: "general", id: null });
    expect(parseSettingsRoute("/settings/notifications")).toEqual({ section: "notifications", id: null });
    expect(parseSettingsRoute("/settings/usage")).toEqual({ section: "usage", id: null });
    expect(parseSettingsRoute("/settings/memory")).toEqual({ section: "memory", id: null });
    expect(parseSettingsRoute("/settings/permissions")).toEqual({ section: "permissions", id: null });
    expect(parseSettingsRoute("/settings/mcp")).toEqual({ section: "mcp", id: null });
    expect(parseSettingsRoute("/settings/triggers")).toEqual({ section: "triggers", id: null });
    expect(parseSettingsRoute("/settings/skills")).toEqual({ section: "skills", id: null });
  });

  it("opens provider tabs and preserves old embedding and search links", () => {
    expect(parseSettingsRoute("/settings/providers")).toEqual({ section: "providers", id: null });
    for (const tab of ["embedding", "search"]) {
      expect(parseSettingsRoute(settingsHref("providers", tab))).toEqual({ section: "providers", id: tab });
      expect(parseSettingsRoute("/settings/" + tab)).toEqual({ section: "providers", id: tab });
    }
    expect(parseSettingsRoute(settingsHref("providers", "images"))).toEqual({ section: "providers", id: "images" });
    expect(parseSettingsRoute("/settings/providers/nope")).toEqual({ section: "providers", id: null });
  });

  it("reads a trigger or skill id", () => {
    expect(parseSettingsRoute("/settings/triggers/trg%201")).toEqual({ section: "triggers", id: "trg 1" });
    expect(parseSettingsRoute("/settings/skills/skl1")).toEqual({ section: "skills", id: "skl1" });
  });

  it("requires the settings route prefix", () => {
    for (const route of ["/memory", "/triggers", "/triggers/trg1", "/skills", "/skills/skl1"])
      expect(parseSettingsRoute(route)).toBeNull();
  });

  it("is null elsewhere, and falls back to the list for a bad section or id", () => {
    expect(parseSettingsRoute("")).toBeNull();
    expect(parseSettingsRoute("/")).toBeNull();
    expect(parseSettingsRoute("/s/abc")).toBeNull();
    expect(parseSettingsRoute("/triggersx")).toBeNull();
    expect(parseSettingsRoute("/settingsx")).toBeNull();
    expect(parseSettingsRoute("/settings/nope")).toEqual({ section: null, id: null });
    expect(parseSettingsRoute("/settings/triggers/%E0%A4%A")).toEqual({ section: "triggers", id: null });
    expect(parseSettingsRoute("/settings/triggers/a/b")).toEqual({ section: "triggers", id: null });
    expect(parseSettingsRoute("/triggers/a/b")).toBeNull();
    expect(parseSettingsRoute("/settings/memory/x")).toEqual({ section: "memory", id: null });
  });

  it("builds links that parse back", () => {
    expect(triggerHref("a b/c")).toBe("/settings/triggers/a%20b%2Fc");
    expect(parseSettingsRoute(triggerHref("a b/c"))).toEqual({ section: "triggers", id: "a b/c" });
    expect(parseSettingsRoute(skillHref("x"))).toEqual({ section: "skills", id: "x" });
    expect(parseSettingsRoute(settingsHref("general"))).toEqual({ section: "general", id: null });
  });
});
