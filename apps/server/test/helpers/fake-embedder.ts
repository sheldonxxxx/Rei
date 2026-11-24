import { OMLX_MODEL } from "../../src/memory/embedder.ts";
import type { TestServerOptions } from "./server.ts";

export const DIMS = 768;
const DOC_PREFIX = "title: none | text: ";
const QUERY_PREFIX = "task: search result | query: ";

const hash = (word: string): number => {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
  return (h >>> 0) % DIMS;
};

/** Words that mean the same thing share a dimension, so "meaning" search can be tested without a model. */
const SYNONYMS: Record<string, string> = {
  car: "vehicle",
  automobile: "vehicle",
  auto: "vehicle",
  sedan: "vehicle",
  doctor: "physician",
  dentist: "physician",
  gp: "physician",
};

/** A bag of words in 768 dimensions: texts that share words (or listed synonyms) are close, others are not. */
export function fakeVector(input: string, synonyms: Record<string, string> = SYNONYMS): number[] {
  const text = input.startsWith(DOC_PREFIX)
    ? input.slice(DOC_PREFIX.length)
    : input.startsWith(QUERY_PREFIX)
      ? input.slice(QUERY_PREFIX.length)
      : input;
  const v: number[] = new Array<number>(DIMS).fill(0);
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const w of words) v[hash(synonyms[w] ?? w)]! += 1;
  if (!v.some((x) => x !== 0)) v[0] = 1;
  return v;
}

/** An OpenAI-compatible embedding server in a function. Tests flip `down`, `status` and refusal behavior. */
export class FakeEmbedder {
  down = false;
  /** Answer every embeddings call with this status instead. */
  status: number | undefined;
  /** Inputs that make the server answer 400 (it "refuses" them). */
  refuse: string[] = [];
  calls: { path: string; inputs: string[] }[] = [];
  key: string | undefined;
  authorizations: (string | null)[] = [];
  readonly #synonyms: Record<string, string>;

  /** `synonyms` adds words that should count as the same meaning (on top of the built-in ones). */
  constructor(synonyms: Record<string, string> = {}) {
    this.#synonyms = { ...SYNONYMS, ...synonyms };
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (this.down) throw new TypeError("fetch failed");
    this.authorizations.push(new Headers(init?.headers).get("authorization"));
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: OMLX_MODEL }] });
    if (url.pathname === "/v1/embeddings") {
      const body = JSON.parse(String(init?.body)) as { input: string[]; model: string };
      this.calls.push({ path: url.pathname, inputs: body.input });
      if (this.status !== undefined) return new Response("no", { status: this.status });
      if (body.input.some((t) => this.refuse.some((r) => t.includes(r))))
        return new Response("too large", { status: 400 });
      // Reverse order: the client must sort by index.
      const data = body.input.map((t, index) => ({ index, embedding: fakeVector(t, this.#synonyms) })).reverse();
      return Response.json({ model: body.model, data });
    }
    return new Response("not found", { status: 404 });
  };

  /** Number of texts embedded so far. */
  get embedded(): number {
    return this.calls.reduce((n, c) => n + c.inputs.length, 0);
  }
}

/**
 * The cosine floor Knowledge meaning search uses with this fake. A bag of words scores a one-word question against a
 * whole section far lower than a real model does, so the production floor (calibrated on EmbeddingGemma) would drop
 * every fake meaning hit; this is history's floor, which the fake's tests were written against.
 */
export const FAKE_KNOWLEDGE_COSINE_FLOOR = 0.3;

/** Server options that turn the index on with a fake embedder and quick timers. */
export function withEmbedder(fake: FakeEmbedder, extra: Partial<TestServerOptions> = {}): TestServerOptions {
  return {
    ...extra,
    config: {
      embedder: { url: "http://omlx:8000", model: OMLX_MODEL, provider: "omlx", apiModel: OMLX_MODEL },
      ...extra.config,
    },
    memory: { fetch: fake.fetch, worker: { backoffBaseMs: 20, backoffMaxMs: 80 }, ...extra.memory },
  };
}
