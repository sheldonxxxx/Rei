import { describe, expect, it } from "vitest";
import { parseComposeVersion, parseInspect, parsePs } from "../src/compose.ts";
import { parseDotenv, removeFromList, setDotenv } from "../src/dotenv.ts";
import { LineReader } from "../src/prompt.ts";
import { appAddress, parsePublish } from "../src/validate.ts";
import { FakeStack } from "./fakes.ts";

const ROW = {
  Service: "edge",
  ID: "93f93ce29d06",
  State: "running",
  Health: "healthy",
  ExitCode: 0,
  Publishers: [
    { URL: "127.0.0.1", TargetPort: 8787, PublishedPort: 8787, Protocol: "tcp" },
    { URL: "", TargetPort: 9, PublishedPort: 0, Protocol: "tcp" },
  ],
};
const ONE = { Service: "exec-keys", ID: "b7920ad46a04", State: "exited", Health: "", ExitCode: 0, Publishers: [] };

describe("compose ps", () => {
  const expected = [
    {
      service: "edge",
      id: "93f93ce29d06",
      state: "running",
      health: "healthy",
      exitCode: 0,
      publishers: [{ host: "127.0.0.1", port: 8787, target: 8787 }],
    },
    { service: "exec-keys", id: "b7920ad46a04", state: "exited", health: "", exitCode: 0, publishers: [] },
  ];
  it("parses JSON lines (compose 2.21 and later)", () => {
    expect(parsePs(`${JSON.stringify(ROW)}\n${JSON.stringify(ONE)}\n`)).toEqual(expected);
  });
  it("parses one array (older compose), and nothing", () => {
    expect(parsePs(JSON.stringify([ROW, ONE]))).toEqual(expected);
    expect(parsePs("")).toEqual([]);
    expect(parsePs("\n")).toEqual([]);
  });
  it("parses docker inspect: aliases, DNS names, restart count", () => {
    const [c] = parseInspect(
      JSON.stringify([
        {
          Id: "abc",
          RestartCount: 2,
          NetworkSettings: { Networks: { n: { Aliases: null, DNSNames: ["gateway"] }, none: {} } },
        },
      ]),
    );
    expect(c).toEqual({
      id: "abc",
      restartCount: 2,
      networks: { n: { aliases: [], dnsNames: ["gateway"] }, none: { aliases: [], dnsNames: [] } },
    });
  });
});

describe("compose version", () => {
  it("reads 2.29.1, v2.20.0 and 5.6.1", () => {
    expect(parseComposeVersion("2.29.1\n")).toEqual([2, 29, 1]);
    expect(parseComposeVersion("v2.20.0")).toEqual([2, 20, 0]);
    expect(parseComposeVersion("Docker Compose version v5.6.1")).toEqual([5, 6, 1]);
    expect(parseComposeVersion("not a version")).toBeNull();
  });
});

describe("the publish address", () => {
  it("parses host:port, a bare port and [v6]:port", () => {
    expect(parsePublish("127.0.0.1:8787")).toEqual({ host: "127.0.0.1", port: 8787 });
    expect(parsePublish("0.0.0.0:9000")).toEqual({ host: "0.0.0.0", port: 9000 });
    expect(parsePublish("8787")).toEqual({ host: "", port: 8787 });
    expect(parsePublish("[::1]:8787")).toEqual({ host: "::1", port: 8787 });
    for (const bad of ["", "host", "host:", "1.2.3.4:99999", ":0", "a:b:c"]) expect(parsePublish(bad), bad).toBeNull();
  });
  it("shows localhost for loopback and wildcard hosts, connects to loopback for a wildcard", () => {
    expect(appAddress({ host: "127.0.0.1", port: 8787 })).toEqual({
      url: "http://localhost:8787",
      fetchBase: "http://127.0.0.1:8787",
    });
    expect(appAddress({ host: "0.0.0.0", port: 80 })).toEqual({
      url: "http://localhost:80",
      fetchBase: "http://127.0.0.1:80",
    });
    expect(appAddress({ host: "", port: 8787 }).url).toBe("http://localhost:8787");
    expect(appAddress({ host: "192.168.1.5", port: 8787 })).toEqual({
      url: "http://192.168.1.5:8787",
      fetchBase: "http://192.168.1.5:8787",
    });
    expect(appAddress({ host: "fd00::5", port: 8787 }).url).toBe("http://[fd00::5]:8787");
  });
});

describe(".env editing", () => {
  const text = '# comment\nCOMPOSE_PROFILES=searxng\nREI_PUBLISH=127.0.0.1:8788  # mine\n\nOTHER="x y"\n';
  it("reads like compose: quotes and trailing comments", () => {
    expect([...parseDotenv(text)]).toEqual([
      ["COMPOSE_PROFILES", "searxng"],
      ["REI_PUBLISH", "127.0.0.1:8788"],
      ["OTHER", "x y"],
    ]);
  });
  it("sets a key in place, appends a missing one, drops duplicates, keeps every other line", () => {
    expect(setDotenv(text, "REI_PUBLISH", "0.0.0.0:1")).toBe(
      text.replace("REI_PUBLISH=127.0.0.1:8788  # mine", "REI_PUBLISH=0.0.0.0:1"),
    );
    expect(setDotenv(text, "GATEWAY_SEARXNG_URL", "https://s.example/")).toBe(
      `${text}GATEWAY_SEARXNG_URL=https://s.example/\n`,
    );
    expect(setDotenv("A=1", "B", "2")).toBe("A=1\nB=2\n");
    expect(setDotenv("", "B", "2")).toBe("B=2\n");
    expect(setDotenv("A=1\nB=2\nA=3\n", "A", "9")).toBe("A=9\nB=2\n");
  });
  it("removes searxng from a comma list, leaves an empty COMPOSE_PROFILES=, and changes nothing when it is not there", () => {
    expect(removeFromList(text, "COMPOSE_PROFILES", "searxng")).toBe(
      text.replace("COMPOSE_PROFILES=searxng", "COMPOSE_PROFILES="),
    );
    expect(removeFromList("COMPOSE_PROFILES=a,searxng,b\n", "COMPOSE_PROFILES", "searxng")).toBe(
      "COMPOSE_PROFILES=a,b\n",
    );
    expect(removeFromList("COMPOSE_PROFILES=a\n", "COMPOSE_PROFILES", "searxng")).toBe("COMPOSE_PROFILES=a\n");
    expect(removeFromList("OTHER=1\n", "COMPOSE_PROFILES", "searxng")).toBe("OTHER=1\n");
    expect(removeFromList("COMPOSE_PROFILES=\n", "COMPOSE_PROFILES", "searxng")).toBe("COMPOSE_PROFILES=\n");
  });
});

describe("hidden line input", () => {
  it("echoes nothing when hidden, handles backspace, arrow keys, a paste and Enter", () => {
    const r = new LineReader(false);
    expect(r.feed("abc\x7fd\x1b[A")).toEqual({ echo: "", done: false, cancelled: false });
    expect(r.feed("ef\r")).toEqual({ echo: "", done: true, cancelled: false });
    expect(r.value).toBe("abdef");
  });
  it("echoes when visible, and cancels on Ctrl-C", () => {
    const r = new LineReader(true);
    expect(r.feed("ab\x7f").echo).toBe("ab\b \b");
    expect(r.feed("\x03").cancelled).toBe(true);
  });
  it("strips bracketed-paste markers", () => {
    const r = new LineReader(false);
    r.feed("\x1b[200~secret-key-1234\x1b[201~\n");
    expect(r.value).toBe("secret-key-1234");
  });
});

describe("fake command handlers", () => {
  it("stop at the first handler that returns a result", async () => {
    const stack = new FakeStack();
    const seen: string[] = [];
    stack.handlers.push(
      () => undefined,
      () => {
        seen.push("second");
        return { code: 0, stdout: "second", stderr: "" };
      },
      () => {
        seen.push("third");
        return { code: 0, stdout: "third", stderr: "" };
      },
    );
    const result = await stack.run("helper", ["--version"]);
    expect(result.stdout).toBe("second");
    expect(seen).toEqual(["second"]);
    expect(stack.execs).toEqual([{ cmd: "helper", args: ["--version"] }]);
  });
});
