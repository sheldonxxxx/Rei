import type { Attachment, FileReference, LibraryDetail } from "@rei/protocol";
import { filePreview, TEXT_PREVIEW_MAX_BYTES } from "@rei/protocol";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Dialog, DialogContent, DialogTitle } from "@/components/primitives/dialog.tsx";
import { NativeSelect } from "@/components/primitives/native-select.tsx";
import { describeError } from "../api/client.ts";
import { attachmentUrl } from "../lib/composer.ts";
import { decodePreview, htmlPreviewDocument, previewRows } from "../lib/filePreview.ts";
import { fileBytes, fileContentUrl, versionAttachment } from "../lib/library.ts";
import { Icon } from "./Icon.tsx";
import { useLibrary } from "./LibraryContext.tsx";
import { Markdown } from "./Markdown.tsx";
import { Tip } from "./Tip.tsx";

/** The largest file previewed in the browser, which holds it whole in memory. Larger files download. */
const PREVIEW_MAX_BYTES = 100 * 1024 * 1024;

const NativeDocument = lazy(() => import("./NativeDocument.tsx").then((m) => ({ default: m.NativeDocument })));
type Loaded = { text: string } | { url: string } | { bytes: ArrayBuffer };
export function FilePreview({
  file: original,
  sessionId,
  onClose,
}: {
  file: Attachment;
  sessionId?: string;
  onClose: () => void;
}) {
  const library = useLibrary();
  const [file, setFile] = useState(original),
    [detail, setDetail] = useState<LibraryDetail | null>(null),
    [metadataError, setMetadataError] = useState("");
  const format = filePreview(file),
    saved = !!file.fileId && !!file.versionId;
  const [loaded, setLoaded] = useState<Loaded | null>(null),
    [error, setError] = useState("");
  const [source, setSource] = useState(false),
    [attempt, setAttempt] = useState(0),
    [compatibility, setCompatibility] = useState(false),
    [info, setInfo] = useState(false),
    [history, setHistory] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [reusing, setReusing] = useState(false),
    [chatNote, setChatNote] = useState(""),
    [agentId, setAgentId] = useState(library?.defaultAgentId ?? "");
  const [location, setLocation] = useState<FileReference["location"]>(undefined),
    [scale, setScale] = useState(1);
  const versionUpload = useRef<HTMLInputElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!saved || !library) return;
    let cancelled = false;
    const load = () =>
      library.api.getFile(file.fileId!).then(
        (r) => {
          if (!cancelled) {
            setDetail(r);
            setMetadataError("");
          }
        },
        (e) => {
          if (!cancelled) setMetadataError(describeError(e));
        },
      );
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [file.fileId, saved, library, refresh]);
  const targetSession = sessionId ?? library?.agents.find((a) => a.id === agentId)?.homeSessionId;
  // Only the compatibility conversion runs in a session. Other previews must not reload when the agent changes.
  const conversionSession = compatibility ? targetSession : undefined;
  const contentUrl = saved
    ? fileContentUrl({ fileId: file.fileId!, versionId: file.versionId! })
    : attachmentUrl(sessionId ?? "", file.id);
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setLoaded(null);
    setError("");
    setLocation(undefined);
    const textFormat = ["text", "markdown", "html", "csv", "tsv"].includes(format.kind);
    if (format.kind === "unsupported") {
      setError("No preview is available for this file type. Download the original to open it.");
      return;
    }
    if (textFormat && file.size > TEXT_PREVIEW_MAX_BYTES) {
      setError("Text previews are limited to 2 MiB. Download the original to read the whole file.");
      return;
    }
    // A preview reads the whole file into this tab's memory; a file can be up to 1 GiB, a preview cannot.
    if (!compatibility && file.size > PREVIEW_MAX_BYTES) {
      setError("This file is too large to preview (over 100 MiB). Download the original to open it.");
      return;
    }
    void (async () => {
      const path = compatibility
        ? saved
          ? contentUrl.replace(/\/content$/, `/compatibility?session=${encodeURIComponent(conversionSession ?? "")}`)
          : `${contentUrl}/preview`
        : contentUrl;
      const response = await fetch(path, { signal: controller.signal, credentials: "same-origin" });
      if (!response.ok) {
        let message = "The file could not be loaded. Try again or download the original.";
        try {
          const body = await response.json();
          if (typeof body.error?.message === "string") message = body.error.message;
        } catch {
          /* Non-JSON error. */
        }
        throw new Error(message);
      }
      const bytes = await response.arrayBuffer();
      if (controller.signal.aborted) return;
      if (textFormat) {
        if (bytes.byteLength > TEXT_PREVIEW_MAX_BYTES)
          throw new Error("Text previews are limited to 2 MiB. Download the original to read the whole file.");
        const text = decodePreview(bytes);
        if (text.includes("\0")) throw new Error("This file contains binary data. Download the original to open it.");
        setLoaded({ text });
      } else if (format.kind === "office" || format.kind === "pdf" || compatibility) setLoaded({ bytes });
      else {
        url = URL.createObjectURL(new Blob([bytes], { type: format.mediaType }));
        setLoaded({ url });
      }
    })().catch((e) => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "The preview could not be loaded.");
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [contentUrl, file.size, format.kind, format.mediaType, compatibility, attempt, conversionSession]);
  const canToggle = ["html", "markdown", "csv", "tsv"].includes(format.kind);
  const version = detail?.versions.find((v) => v.versionId === file.versionId);
  const newer = detail && detail.file.current.versionId !== file.versionId;
  const changeVersion = (id: string) => {
    const v = detail?.versions.find((v) => v.versionId === id);
    if (v) {
      setFile(versionAttachment(v));
      setCompatibility(false);
      setSource(false);
      setScale(1);
    }
  };
  const fail = (message: string) => setError(message);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        size="full"
        showCloseButton={false}
        aria-describedby={undefined}
        className="file-preview flex h-[min(850px,calc(100dvh-3rem))] max-h-none flex-col gap-0 overflow-hidden p-0 max-md:top-0 max-md:h-dvh max-md:rounded-none max-md:pb-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          if (e.target instanceof HTMLElement) e.target.focus();
        }}
      >
        <header className="file-preview-head">
          <div>
            <DialogTitle className="text-base">{detail?.file.name ?? file.name}</DialogTitle>
            <small>
              {fileBytes(file.size)}
              {version ? ` · Version ${version.number}` : ""}
              {compatibility ? " · Compatibility PDF · Layout may vary" : ""}
            </small>
          </div>
          {detail && (
            <NativeSelect
              aria-label="File version"
              value={file.versionId}
              onChange={(e) => changeVersion(e.target.value)}
            >
              {detail.versions.map((v) => (
                <option key={v.versionId} value={v.versionId}>
                  v{v.number} · {v.creator}
                </option>
              ))}
            </NativeSelect>
          )}
          {detail && (
            <Tip label="File info">
              <Button
                variant={info ? "secondary" : "ghost"}
                size="icon-sm"
                type="button"
                aria-label="File info"
                aria-expanded={info}
                onClick={() => setInfo(!info)}
              >
                <Icon name="info" size={18} />
              </Button>
            </Tip>
          )}
          {detail && (
            <Tip label="History">
              <Button
                variant={history ? "secondary" : "ghost"}
                size="icon-sm"
                type="button"
                aria-label="History"
                aria-expanded={history}
                onClick={() => setHistory(!history)}
              >
                <Icon name="history" size={18} />
              </Button>
            </Tip>
          )}
          <Tip label="Download">
            <Button asChild variant="ghost" size="icon-sm">
              <a href={contentUrl} download={file.name} aria-label="Download">
                <Icon name="download" size={18} />
              </a>
            </Button>
          </Tip>
          {detail && library && !detail.file.trashedAt && (
            <Tip label="Move to Trash">
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
                aria-label="Move to Trash"
                onClick={() =>
                  void library.api.patchFile(detail.file.id, { trashed: true }).then(
                    () => onClose(),
                    (e) => setMetadataError(describeError(e)),
                  )
                }
              >
                <Icon name="trash" size={18} />
              </Button>
            </Tip>
          )}
          <Tip label="Close" shortcut="Esc">
            <Button
              ref={close}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close preview"
              onClick={onClose}
            >
              <Icon name="close" size={18} />
            </Button>
          </Tip>
        </header>
        {newer && (
          <div className="file-preview-update" role="status">
            A newer version is available. You are viewing v{version?.number}.{" "}
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className=""
              onClick={() => changeVersion(detail.file.current.versionId)}
            >
              View latest
            </Button>
          </div>
        )}
        {(canToggle || format.kind === "image" || format.kind === "text") && (
          <div className="file-preview-tools" role="group" aria-label="Preview view">
            {canToggle && (
              <>
                <Button
                  variant="outline"
                  type="button"
                  className=""
                  aria-pressed={!source}
                  onClick={() => setSource(false)}
                >
                  Preview
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  className=""
                  aria-pressed={source}
                  onClick={() => setSource(true)}
                >
                  Source
                </Button>
              </>
            )}
            {format.kind === "html" && (
              <Button variant="outline" type="button" className="" onClick={() => setAttempt((n) => n + 1)}>
                Refresh preview
              </Button>
            )}
            {(format.kind === "image" || format.kind === "text") && (
              <>
                <Tip label="Zoom out">
                  <Button
                    variant="outline"
                    type="button"
                    className=""
                    aria-label="Zoom out"
                    onClick={() => setScale((n) => Math.max(0.25, n - 0.25))}
                  >
                    −
                  </Button>
                </Tip>
                <span>{Math.round(scale * 100)}%</span>
                <Tip label="Zoom in">
                  <Button
                    variant="outline"
                    type="button"
                    className=""
                    aria-label="Zoom in"
                    onClick={() => setScale((n) => Math.min(4, n + 0.25))}
                  >
                    +
                  </Button>
                </Tip>
                <Button variant="outline" type="button" className="" onClick={() => setScale(1)}>
                  Fit
                </Button>
              </>
            )}
          </div>
        )}
        <div className="file-preview-workspace">
          <div className="file-preview-body" aria-busy={!loaded && !error}>
            {error ? (
              <div className="file-preview-notice">
                <p role="alert">{error}</p>
                <Button variant="outline" type="button" className="" onClick={() => setAttempt((n) => n + 1)}>
                  Retry preview
                </Button>
                {format.kind === "office" && !compatibility && (
                  <Button variant="outline" type="button" className="" onClick={() => setCompatibility(true)}>
                    Compatibility preview
                  </Button>
                )}
                {compatibility && (
                  <Button variant="outline" type="button" className="" onClick={() => setCompatibility(false)}>
                    Try direct preview
                  </Button>
                )}
              </div>
            ) : !loaded ? (
              <p className="file-preview-notice" role="status">
                {compatibility ? "Preparing compatibility preview…" : "Loading preview…"}
              </p>
            ) : "text" in loaded ? (
              source || format.kind === "text" ? (
                <div style={{ fontSize: `${scale}em` }}>
                  <SourcePreview text={loaded.text} name={file.name} />
                </div>
              ) : format.kind === "html" ? (
                saved ? (
                  <iframe
                    key={attempt}
                    title={`Preview of ${file.name}`}
                    sandbox="allow-scripts"
                    referrerPolicy="no-referrer"
                    src={contentUrl.replace(/\/content$/, "/html")}
                  />
                ) : (
                  <iframe
                    title={`Preview of ${file.name}`}
                    sandbox=""
                    referrerPolicy="no-referrer"
                    srcDoc={htmlPreviewDocument(loaded.text)}
                  />
                )
              ) : format.kind === "markdown" ? (
                <div className="file-preview-document">
                  <Markdown text={loaded.text} />
                </div>
              ) : (
                <DataPreview text={loaded.text} separator={format.kind === "tsv" ? "\t" : ","} />
              )
            ) : "bytes" in loaded ? (
              <Suspense fallback={<p role="status">Loading document renderer…</p>}>
                <NativeDocument
                  bytes={loaded.bytes}
                  name={
                    compatibility
                      ? "compatibility-preview.pdf"
                      : file.name.toLowerCase().endsWith(`.${format.extension}`)
                        ? file.name
                        : `${file.name}.${format.extension}`
                  }
                  onError={fail}
                  onLocation={setLocation}
                />
              </Suspense>
            ) : format.kind === "image" ? (
              <img
                className="file-preview-image"
                style={{ transform: `scale(${scale})`, transformOrigin: "top center" }}
                src={loaded.url}
                alt={file.name}
                onError={() => fail("This image could not be displayed. Download the original to open it.")}
              />
            ) : format.kind === "audio" ? (
              <audio
                controls
                src={loaded.url}
                onError={() => fail("Your browser could not play this audio format. Download the original to open it.")}
              />
            ) : (
              <video
                controls
                playsInline
                src={loaded.url}
                onError={() => fail("Your browser could not play this video format. Download the original to open it.")}
              />
            )}
          </div>
          {(info || history) && detail && (
            <aside className="file-preview-info" aria-label={history ? "Version history" : "File information"}>
              {info && (
                <>
                  <h3>File info</h3>
                  <dl>
                    <dt>Name</dt>
                    <dd>{detail.file.name}</dd>
                    <dt>Type</dt>
                    <dd>{file.mediaType}</dd>
                    <dt>Size</dt>
                    <dd>{fileBytes(file.size)}</dd>
                    <dt>Created</dt>
                    <dd>
                      {new Date(detail.file.createdAt).toLocaleString()} · {detail.file.creator}
                    </dd>
                    <dt>Updated</dt>
                    <dd>{new Date(detail.file.updatedAt).toLocaleString()}</dd>
                    <dt>Folder</dt>
                    <dd>{detail.folder?.name ?? "Library"}</dd>
                    <dt>Origin</dt>
                    <dd>{detail.file.origin === "upload" ? "Uploaded" : "Agent-created"}</dd>
                  </dl>
                  <Button
                    variant="outline"
                    type="button"
                    className=""
                    onClick={() => {
                      void library!.api.patchFile(detail.file.id, { favorite: !detail.file.favorite }).then(
                        () => setRefresh((n) => n + 1),
                        (e) => setMetadataError(describeError(e)),
                      );
                    }}
                  >
                    {detail.file.favorite ? "Remove favorite" : "Add to favorites"}
                  </Button>
                  <h3>Related chats</h3>
                  {detail.chats.length ? (
                    detail.chats.map((c) => (
                      <a key={c.id} href={`/s/${encodeURIComponent(c.id)}`} onClick={onClose}>
                        {c.title || "Untitled chat"}
                      </a>
                    ))
                  ) : (
                    <p>No remaining related chats.</p>
                  )}
                </>
              )}
              {history && (
                <>
                  <h3>Version history</h3>
                  {!detail.file.trashedAt && (
                    <>
                      <Button
                        variant="outline"
                        type="button"
                        className=""
                        onClick={() => versionUpload.current?.click()}
                      >
                        Upload new version
                      </Button>
                      <input
                        ref={versionUpload}
                        type="file"
                        hidden
                        aria-label="Upload new file version"
                        onChange={(e) => {
                          const picked = e.target.files?.[0];
                          e.target.value = "";
                          if (picked)
                            void library!.api
                              .uploadLibraryFile(picked, {
                                fileId: detail.file.id,
                                baseVersionId: detail.file.current.versionId,
                              })
                              .then(
                                () => setRefresh((n) => n + 1),
                                (error) => setMetadataError(describeError(error)),
                              );
                        }}
                      />
                    </>
                  )}
                  {detail.versions.map((v) => (
                    <div key={v.versionId} className="file-version-row">
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        className=""
                        onClick={() => changeVersion(v.versionId)}
                      >
                        v{v.number} · {v.creator}
                      </Button>
                      <small>{new Date(v.createdAt).toLocaleString()}</small>
                      {v.versionId !== detail.file.current.versionId && !detail.file.trashedAt && (
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          className=""
                          onClick={() => {
                            void library!.api
                              .restoreFileVersion(detail.file.id, v.versionId, detail.file.current.versionId)
                              .then(
                                () => setRefresh((n) => n + 1),
                                (e) => setMetadataError(describeError(e)),
                              );
                          }}
                        >
                          Restore as new version
                        </Button>
                      )}
                    </div>
                  ))}
                </>
              )}
            </aside>
          )}
        </div>
        {metadataError && (
          <p className="file-preview-metadata-error" role="alert">
            {metadataError}
          </p>
        )}
        {saved && library && !sessionId && (
          <div className="file-preview-ask">
            <NativeSelect aria-label="Agent for file" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {library.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </NativeSelect>
            {library.reuse && (
              <Button
                variant="outline"
                type="button"
                className=""
                disabled={reusing || !!detail?.file.trashedAt}
                onClick={() => {
                  setReusing(true);
                  setChatNote("");
                  void library.reuse!({ ...file, location }, agentId)
                    .catch((e) => setChatNote(describeError(e)))
                    .finally(() => setReusing(false));
                }}
              >
                Use in chat
              </Button>
            )}
            {chatNote && (
              <small role="alert" className="file-preview-ask-note">
                {chatNote}
              </small>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
function SourcePreview({ text, name }: { text: string; name: string }) {
  const [highlighted, setHighlighted] = useState<string | null>(null),
    [copied, setCopied] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setHighlighted(null);
    void import("highlight.js/lib/common")
      .then((m) => {
        if (!cancelled) {
          const language = name.split(".").pop() ?? "";
          setHighlighted(
            m.default.getLanguage(language)
              ? m.default.highlight(text, { language }).value
              : m.default.highlightAuto(text.slice(0, 100_000)).value +
                  (text.length > 100_000
                    ? m.default.highlight(text.slice(100_000), { language: "plaintext" }).value
                    : ""),
          );
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [text, name]);
  return (
    <div className="file-source">
      <Button
        variant="outline"
        type="button"
        className=""
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => setCopied(true));
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
      {highlighted === null ? (
        <pre className="file-preview-text">{text || "(Empty file)"}</pre>
      ) : (
        <pre className="file-preview-text">
          <code dangerouslySetInnerHTML={{ __html: highlighted || "(Empty file)" }} />
        </pre>
      )}
    </div>
  );
}
function DataPreview({ text, separator }: { text: string; separator: string }) {
  const { rows, truncated } = useMemo(() => previewRows(text, separator), [text, separator]);
  return (
    <div className="file-preview-data">
      {truncated && <p role="status">Showing up to 200 rows and 50 columns. Download the original for all data.</p>}
      {rows.length ? (
        <table>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>(Empty file)</p>
      )}
    </div>
  );
}
