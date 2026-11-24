import {
  createLibraryFolderRoute,
  deleteLibraryFolderRoute,
  fileCompatibilityRoute,
  fileContentRoute,
  fileHtmlRoute,
  filePreview,
  fileRoute,
  filesRoute,
  libraryFoldersRoute,
  patchFileRoute,
  purgeFileRoute,
  restoreFileVersionRoute,
  updateLibraryFolderRoute,
  uploadFileRoute,
  uploadFileVersionRoute,
} from "@rei/protocol";
import type { Context, Hono } from "hono";
import type { AppDeps } from "../http/app.ts";
import { type ContractOptions, mountRoute } from "../http/contract.ts";
import { withUpload } from "../http/multipart.ts";
import { badRequest, HttpError } from "../util/errors.ts";

const param = (c: Context, name: string): string => c.req.param(name) ?? "";

export function libraryRoutes(app: Hono, deps: AppDeps, contract: ContractOptions) {
  const library = () => {
    const lib = deps.attachments?.library;
    if (!lib) throw new HttpError(503, "unavailable", "The file library is unavailable.");
    return lib;
  };
  mountRoute(app, filesRoute, contract, (_c, { query }) =>
    library().list({
      ...query,
      trash: query.trash === "1",
      favorite: query.favorite === "1",
    }),
  );
  mountRoute(app, uploadFileRoute, contract, async (c, { query }) => {
    const folder = library().folder(query.folder);
    return { file: await withUpload(c, (file) => library().upload(file, folder)) };
  });
  mountRoute(app, fileRoute, contract, (c) => library().detail(param(c, "id")));
  mountRoute(app, patchFileRoute, contract, (c, { body }) => ({ file: library().patch(param(c, "id"), body) }));
  mountRoute(app, purgeFileRoute, contract, async (c, { body }) => {
    if (body.confirm !== true) throw badRequest("confirmation_required", "Confirm permanent deletion.");
    await library().purge(param(c, "id"));
    return { ok: true } as const;
  });
  mountRoute(app, uploadFileVersionRoute, contract, async (c, { query }) => {
    const id = param(c, "id"),
      baseVersionId = query.baseVersionId;
    if (!baseVersionId) throw badRequest("base_version_required", "The expected base version is required.");
    library().row(id, false);
    const a = await withUpload(c, (file) => deps.attachments!.upload("", file, { fileId: id, baseVersionId }));
    return { file: library().detail(a.fileId!).file };
  });
  mountRoute(app, restoreFileVersionRoute, contract, async (c, { body }) => ({
    file: await library().restoreVersion(param(c, "id"), body.versionId, body.baseVersionId),
  }));
  mountRoute(app, fileContentRoute, contract, async (c, { query }) => {
    const a = library().resolve({ fileId: param(c, "id"), versionId: param(c, "versionId") }, false);
    const { size, body } = await deps.attachments!.open(deps.attachments!.row(a.id)!);
    // Active documents always download. Rendering happens in a controlled client viewer.
    const imageType = filePreview(a).mediaType;
    const image =
      query.thumbnail === "1" &&
      ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(imageType);
    c.header("content-type", image ? imageType : "application/octet-stream");
    c.header(
      "content-disposition",
      `${image ? "inline" : "attachment"}; filename="file"; filename*=UTF-8''${encodeURIComponent(a.name).replace(/['()*]/g, (x) => `%${x.charCodeAt(0).toString(16)}`)}`,
    );
    c.header("cache-control", "no-store");
    c.header("content-security-policy", "default-src 'none'; sandbox");
    c.header("content-length", String(size));
    return c.body(body);
  });
  mountRoute(app, fileHtmlRoute, contract, async (c) => {
    const a = library().resolve({ fileId: param(c, "id"), versionId: param(c, "versionId") }, false);
    if (!/\.html?$/i.test(a.name) && a.mediaType !== "text/html")
      throw badRequest("bad_format", "This file is not HTML.");
    if (a.size > 2 * 1024 * 1024) throw new HttpError(413, "preview_too_large", "HTML previews are limited to 2 MiB.");
    const bytes = await deps.attachments!.bytes(deps.attachments!.row(a.id)!, 2 * 1024 * 1024);
    return new Response(bytes, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy":
          "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts",
      },
    });
  });
  mountRoute(app, fileCompatibilityRoute, contract, async (c, { query }) => {
    const ref = { fileId: param(c, "id"), versionId: param(c, "versionId") };
    const bytes = await library().compatibility(ref, query.session ?? "");
    library().resolve(ref, false);
    return new Response(bytes, {
      headers: {
        "content-type": "application/pdf",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
      },
    });
  });
  mountRoute(app, libraryFoldersRoute, contract, () => ({ folders: library().folders() }));
  mountRoute(app, createLibraryFolderRoute, contract, (_c, { body }) => ({
    folder: library().saveFolder(body.name, body.parentId),
  }));
  mountRoute(app, updateLibraryFolderRoute, contract, (c, { body }) => ({
    folder: library().saveFolder(body.name, body.parentId, param(c, "id")),
  }));
  mountRoute(app, deleteLibraryFolderRoute, contract, (c) => {
    library().deleteFolder(param(c, "id"));
    return { ok: true } as const;
  });
}
