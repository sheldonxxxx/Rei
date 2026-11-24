import { describe, expect, it } from "vitest";
import { clearing, minCoverage, queryTerms, rank, tokenize } from "../src/capabilities/rank.ts";

const names = (query: string, docs: Parameters<typeof rank>[1]) => rank(query, docs).map((r) => r.name);

describe("tokenize", () => {
  it("splits identifiers, drops stop words, plurals and common suffixes", () => {
    expect(tokenize("browser_takeover getFileContents github__list_issues")).toEqual([
      "brows",
      "takeov",
      "get",
      "file",
      "content",
      "getfilecontent",
      "github",
      "list",
      "issu",
    ]);
    expect(tokenize("open the page in a browser")).toEqual(["open", "page", "brows"]);
    // Query and description forms meet.
    expect(tokenize("reminder scheduled")).toEqual(tokenize("remind schedule"));
  });

  it("segments Chinese into words", () => {
    const words = tokenize("打開網頁並截圖");
    expect(words.length).toBeGreaterThan(1);
    expect(words.join("")).toBe("打開網頁並截圖");
  });
});

describe("rank", () => {
  const tools = [
    { name: "github__create_issue", text: "Create a new issue in a repository.", namespaceText: "GitHub" },
    {
      name: "github__get_file_contents",
      text: "Read the contents of a file in a repository.",
      namespaceText: "GitHub",
    },
    { name: "github__list_issues", text: "List issues of a repository.", namespaceText: "GitHub" },
    { name: "browser_screenshot", text: "Take a screenshot of the browser window." },
    { name: "notion__search", text: "Search pages in the workspace.", namespaceText: "Notion" },
  ];

  it("ranks the tool that covers more query terms first, whatever the scores", () => {
    expect(names("read file github repository", tools)[0]).toBe("github__get_file_contents");
  });

  it("puts a name match above text mentions", () => {
    expect(names("issues", tools).slice(0, 2)).toEqual(["github__list_issues", "github__create_issue"]);
  });

  it("puts an exact name, or the local name after __, first", () => {
    expect(names("github__create_issue", tools)[0]).toBe("github__create_issue");
    expect(names("search", tools)[0]).toBe("notion__search");
  });

  it("leaves out documents that match nothing and returns nothing for an empty query", () => {
    expect(names("calendar", tools)).toEqual([]);
    expect(rank("  ", tools)).toEqual([]);
  });

  it("tells a namespace-only match from a match in the tool's own name or text", () => {
    const github = rank("github", tools).filter((r) => r.name.startsWith("github__"));
    expect(github).toHaveLength(3);
    expect(github.every((r) => r.ownTerms === 0 && r.coverage === 1)).toBe(true);
    const read = rank("github read", tools).find((r) => r.name === "github__get_file_contents");
    expect(read?.ownTerms).toBe(1);
  });

  it("finds Chinese text by a Chinese query", () => {
    const docs = [
      { name: "browser_screenshot", text: "截取瀏覽器視窗的截圖" },
      { name: "memory_add", text: "記住一件事" },
    ];
    expect(names("截圖", docs)[0]).toBe("browser_screenshot");
  });

  it("returns scores and coverage", () => {
    const [top] = rank("screenshot", tools);
    expect(top).toMatchObject({ name: "browser_screenshot", coverage: 1 });
    expect(top!.score).toBeGreaterThan(0);
  });
});

describe("synonyms", () => {
  it("gives a query term its alternatives, the term first", () => {
    expect(queryTerms("read repo")).toEqual([
      ["read", "get", "fetch", "content"],
      ["repo", "repository"],
    ]);
  });

  it("finds a description that says it differently, and a Chinese query reaches English text", () => {
    const docs = [
      { name: "get_file_contents", text: "Get the contents of a file in a repository." },
      { name: "delete_file", text: "Delete a file." },
      { name: "browser_screenshot", text: "Take a screenshot of the page." },
    ];
    expect(names("read a file in the repo", docs)[0]).toBe("get_file_contents");
    expect(names("截圖", docs)[0]).toBe("browser_screenshot");
  });
});

describe("clearing", () => {
  it("keeps the leading results at the best coverage within the ratio of the best score", () => {
    const ranked = [
      { name: "a", coverage: 2, ownTerms: 2, score: 10 },
      { name: "b", coverage: 2, ownTerms: 2, score: 6 },
      { name: "c", coverage: 2, ownTerms: 2, score: 4 },
      { name: "d", coverage: 1, ownTerms: 1, score: 20 },
    ];
    expect(clearing(ranked, 0.5).map((r) => r.name)).toEqual(["a", "b"]);
    expect(clearing([], 0.5)).toEqual([]);
  });

  it("clears nothing when the best result covers fewer terms than the minimum", () => {
    expect(minCoverage("order a pizza")).toBe(2);
    expect(minCoverage("github")).toBe(1);
    expect(clearing([{ name: "a", coverage: 1, ownTerms: 1, score: 9 }], 0.5, 2)).toEqual([]);
  });
});
