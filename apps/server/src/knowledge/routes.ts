// Knowledge over HTTP, for the web app. Every route uses the existing authentication and CSRF protection. The user
// writes as "user"; permanent deletion needs `confirm: true` (the UI asks first).
import {
  createKnowledgePageRoute,
  knowledgeFileUsageRoute,
  knowledgeMarkdownRoute,
  knowledgeOverviewRoute,
  knowledgePageRoute,
  knowledgeRevisionRoute,
  knowledgeSearchRoute,
  knowledgeSectionRoute,
  knowledgeTagsRoute,
  knowledgeTrashRoute,
  knowledgeTreeRoute,
  patchKnowledgePageRoute,
  purgeKnowledgePageRoute,
  restoreKnowledgePageRoute,
  restoreKnowledgeRevisionRoute,
  saveKnowledgePageRoute,
  trashKnowledgePageRoute,
} from "@rei/protocol";
import { serializeKnowledgeSource } from "@rei/protocol/knowledge-source";
import type { Context, Hono } from "hono";
import type { AppDeps } from "../http/app.ts";
import { type ContractOptions, mountRoute } from "../http/contract.ts";
import { badRequest, HttpError } from "../util/errors.ts";
import { findSection, sectionText } from "./markdown.ts";
import { KnowledgeConflict, type KnowledgeService } from "./service.ts";

const USER = { actor: "user" } as const;

const param = (c: Context, name: string): string => c.req.param(name) ?? "";

export function knowledgeRoutes(app: Hono, deps: AppDeps, contract: ContractOptions) {
  const knowledge = (): KnowledgeService => {
    if (!deps.knowledge) throw new HttpError(503, "unavailable", "Knowledge is unavailable.");
    return deps.knowledge;
  };
  /** A stale base revision answers 409 with the revision and text it lost to, beside the error. */
  const guarded = <T>(c: Context, run: () => T): T | Response => {
    try {
      return run();
    } catch (error) {
      if (error instanceof KnowledgeConflict)
        return c.json(
          { error: { code: "conflict", message: error.message }, revision: error.revision, current: error.current },
          409,
        );
      throw error;
    }
  };

  mountRoute(app, knowledgeTagsRoute, contract, () => ({ tags: knowledge().tagSuggestions() }));
  mountRoute(app, knowledgeTreeRoute, contract, () => ({ pages: knowledge().tree() }));
  mountRoute(app, knowledgeOverviewRoute, contract, () => knowledge().overview(deps.clock.now()));
  mountRoute(app, knowledgeTrashRoute, contract, () => ({ pages: knowledge().trash() }));
  mountRoute(app, knowledgeSearchRoute, contract, async (_c, { query }) => ({
    hits: await knowledge().find(query.q ?? "", {
      ...(query.under ? { under: query.under } : {}),
      ...(query.tags !== undefined ? { tags: parseTags(query.tags) } : {}),
      limit: query.limit === undefined ? 20 : parseLimit(query.limit),
    }),
  }));
  /** Live pages that link to a Library file (the Library's "Used in N pages"). */
  mountRoute(app, knowledgeFileUsageRoute, contract, (c) => ({
    pages: knowledge()
      .pagesUsingFile(param(c, "fileId"))
      .map((p) => ({ id: p.id, title: p.title, path: knowledge().path(p.id) })),
  }));

  mountRoute(app, createKnowledgePageRoute, contract, (_c, { body }) => {
    const page = knowledge().create({ ...body, parentId: body.parentId ?? null }, USER);
    return knowledge().detail(page.id);
  });
  mountRoute(app, knowledgePageRoute, contract, (c) => knowledge().detail(param(c, "id")));
  mountRoute(app, knowledgeRevisionRoute, contract, (c) =>
    knowledge().revisionDetail(param(c, "id"), Number(param(c, "revision"))),
  );
  /** The editor's save: title/description/body as a whole, against the revision it opened. */
  mountRoute(app, saveKnowledgePageRoute, contract, (c, { body }) =>
    guarded(c, () => {
      const page = knowledge().replace(param(c, "id"), body, body.baseRevision, USER);
      return knowledge().detail(page.id);
    }),
  );
  /** Small changes from the reader: tick a task, move, lock, pin. */
  mountRoute(app, patchKnowledgePageRoute, contract, (c, { body: b }) =>
    guarded(c, () => {
      const id = param(c, "id");
      const k = knowledge();
      if (b.task !== undefined) k.edit(id, [{ op: "set_task", index: b.task.index, done: b.task.done }], USER);
      if (b.parentId !== undefined) k.move(id, b.parentId, USER);
      if (b.locked !== undefined || b.pinned !== undefined)
        k.setFlags(id, {
          ...(b.locked !== undefined ? { locked: b.locked } : {}),
          ...(b.pinned !== undefined ? { pinned: b.pinned } : {}),
        });
      return k.detail(id);
    }),
  );
  mountRoute(app, restoreKnowledgeRevisionRoute, contract, (c, { body }) =>
    guarded(c, () => {
      const page = knowledge().restoreRevision(param(c, "id"), body.revision, body.baseRevision, USER);
      return knowledge().detail(page.id);
    }),
  );
  mountRoute(app, trashKnowledgePageRoute, contract, (c) => ({ trashed: knowledge().trashPage(param(c, "id"), USER) }));
  mountRoute(app, restoreKnowledgePageRoute, contract, (c) =>
    knowledge().detail(knowledge().restorePage(param(c, "id")).id),
  );
  mountRoute(app, purgeKnowledgePageRoute, contract, (c, { body }) => {
    if (body.confirm !== true) throw badRequest("confirmation_required", "Permanent deletion needs confirm: true.");
    return { deleted: knowledge().purge(param(c, "id")) };
  });
  /** Canonical Markdown source: retain page/file references for lossless re-import. */
  mountRoute(app, knowledgeMarkdownRoute, contract, (c) => {
    const k = knowledge();
    const detail = k.detail(param(c, "id"));
    const slug = (title: string) =>
      title
        .replace(/[\\/:*?"<>|]+/g, " ")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 80) || "page";
    const out = serializeKnowledgeSource(detail.page, detail.body);
    return new Response(out, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${slug(detail.page.title)}.md`)}`,
      },
    });
  });
  /** One section's text, for the editor's conflict view. */
  mountRoute(app, knowledgeSectionRoute, contract, (c, { query }) => {
    const page = knowledge().live(param(c, "id"));
    const s = findSection(page.body, query.ref ?? "top");
    return { revision: page.revision, text: sectionText(page.body, s) };
  });
}

function parseTags(value: string): string[] {
  try {
    const tags: unknown = JSON.parse(value);
    if (Array.isArray(tags) && tags.every((t) => typeof t === "string")) return tags;
  } catch {
    /* structured error below */
  }
  throw badRequest("bad_tags", "tags must be a JSON array of strings.");
}
function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw badRequest("bad_limit", "limit must be an integer from 1 to 20.");
  return limit;
}
