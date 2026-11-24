import type { Attachment } from "@rei/protocol";
import { useEffect, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { cn } from "@/lib/utils.ts";
import { isPreviewImage } from "../lib/composer.ts";
import type { DraftFile } from "../lib/composerDraft.ts";
import { decodePreview, previewRows } from "../lib/filePreview.ts";
import { fileContentUrl } from "../lib/library.ts";
import { Icon } from "./Icon.tsx";
import { Tip } from "./Tip.tsx";

interface Props {
  files: DraftFile[];
  onPreview: (file: Attachment) => void;
  onRemove: (key: string) => void;
  onRetry: (file: DraftFile) => void;
  onInsert: (file: DraftFile) => void;
}

export function DraftAttachments({ files, onPreview, onRemove, onRetry, onInsert }: Props) {
  // Keep the last row visible during collapse, but remove it from interaction immediately.
  const [retained, setRetained] = useState(files);
  useEffect(() => {
    if (files.length) {
      setRetained(files);
      return;
    }
    const timer = window.setTimeout(() => setRetained([]), 300);
    return () => window.clearTimeout(timer);
  }, [files]);
  const visible = files.length > 0;
  return (
    <div
      className={cn(
        "draft-attachment-tray col-span-full row-start-1 grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-[280ms,180ms] ease-[cubic-bezier(.22,1,.36,1),ease] motion-reduce:transition-none",
        visible && "is-open grid-rows-[1fr] opacity-100",
      )}
      aria-hidden={!visible}
      inert={!visible}
    >
      <div className="draft-attachment-clip min-h-0 overflow-hidden">
        <ul
          className="draft-attachments m-0 flex list-none flex-nowrap gap-3 overflow-x-auto overscroll-x-contain p-1 pb-3.5 [scrollbar-width:thin]"
          aria-label="Attachments"
        >
          {(visible ? files : retained).map((f) => (
            <li
              key={f.key}
              className={cn(
                `draft-file is-${f.status}`,
                "relative w-40 min-w-0 flex-none animate-[draft-file-enter_240ms_cubic-bezier(.22,1,.36,1)_both] self-start overflow-hidden rounded-2xl border bg-muted motion-reduce:animate-none",
                (f.status === "failed" || f.status === "rejected") && "border-destructive",
              )}
            >
              <button
                type="button"
                className="draft-file-preview block w-full cursor-pointer rounded-2xl border-0 bg-transparent p-0 text-start text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
                disabled={!f.attachment}
                aria-label={`Preview ${f.file.name}`}
                onClick={() => {
                  if (f.attachment) onPreview(f.attachment);
                }}
              >
                {f.library ? (
                  <span className={thumbnailClass(true, true)} aria-hidden="true">
                    {f.attachment?.fileId && f.attachment.versionId && isPreviewImage(f.attachment.mediaType) ? (
                      <img
                        className={IMAGE_CLASS}
                        src={`${fileContentUrl({ fileId: f.attachment.fileId, versionId: f.attachment.versionId })}?thumbnail=1`}
                        alt=""
                      />
                    ) : (
                      <span className={FILE_TYPE_CLASS}>
                        <Icon name="library" size={32} />
                        <span>LIBRARY</span>
                      </span>
                    )}
                  </span>
                ) : (
                  <DraftThumbnail file={f.file} />
                )}
                <span className="draft-file-caption flex items-center gap-[7px] p-2.5 [&>.icon]:shrink-0 [&>.icon]:text-muted-foreground">
                  <Icon name="memory" size={17} />
                  <Tip label={f.file.name}>
                    <strong className="min-w-0 truncate text-sm font-medium">{f.file.name}</strong>
                  </Tip>
                </span>
              </button>
              <Tip label="Remove">
                <Button
                  type="button"
                  variant="secondary"
                  size="icon-xs"
                  className="draft-file-remove absolute right-1.5 top-1.5 z-2 size-7 shadow-sm"
                  aria-label={`Remove ${f.file.name}`}
                  onClick={() => onRemove(f.key)}
                >
                  <Icon name="close" size={14} />
                </Button>
              </Tip>
              {(f.status !== "ready" || f.pastedText !== undefined) && (
                <div className="draft-file-details absolute inset-x-0 bottom-[38px] flex min-h-[26px] flex-wrap items-center gap-x-2 gap-y-1 bg-muted px-2.5 py-1">
                  <small role="status" className="text-[.7rem] text-muted-foreground">
                    {f.status === "uploading"
                      ? "Uploading…"
                      : `${((f.attachment?.size ?? f.file.size) / 1024).toFixed(1)} KiB`}
                  </small>
                  {f.status === "uploading" && (
                    <>
                      <progress className="sr-only" aria-label={`Uploading ${f.file.name}`} />
                      <span
                        className="draft-upload-track absolute bottom-0 left-0 h-[3px] w-full overflow-hidden bg-border"
                        aria-hidden="true"
                      >
                        <span className="block h-full w-2/5 animate-[draft-upload_1.15s_ease-in-out_infinite_alternate] rounded-[3px] bg-primary motion-reduce:animate-none" />
                      </span>
                    </>
                  )}
                  {f.error && (
                    <span role="alert" className="basis-full break-words text-xs text-destructive">
                      {f.error}
                    </span>
                  )}
                  {(f.status === "failed" || f.status === "rejected") && (
                    <Button
                      type="button"
                      variant="link"
                      size="xs"
                      className="h-auto p-0 text-[.7rem] text-foreground"
                      onClick={() => onRetry(f)}
                    >
                      Retry upload
                    </Button>
                  )}
                  {f.pastedText !== undefined && f.status !== "uploading" && (
                    <Button
                      type="button"
                      variant="link"
                      size="xs"
                      className="h-auto p-0 text-[.7rem] text-foreground"
                      onClick={() => onInsert(f)}
                    >
                      Insert as text
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const IMAGE_CLASS =
  "block size-full scale-[1.025] object-cover opacity-0 transition-[opacity,transform] duration-[240ms,350ms] ease-[ease] group-[.is-loaded]/thumb:scale-100 group-[.is-loaded]/thumb:opacity-100 motion-reduce:transition-none";
const FILE_TYPE_CLASS =
  "draft-file-type flex h-full flex-col items-center justify-center gap-2 text-[.65rem] tracking-[.08em] text-muted-foreground";
/** The picture area; a pulse covers it until the preview has loaded (or there is nothing to load). */
const thumbnailClass = (still: boolean, loaded = false) =>
  cn(
    "draft-thumbnail group/thumb relative block h-[90px] overflow-hidden bg-card after:pointer-events-none after:absolute after:inset-0 after:animate-[draft-preview-pulse_1.4s_ease-in-out_infinite_alternate] after:bg-muted-foreground after:opacity-[.08] after:transition-opacity after:duration-200 after:content-[''] motion-reduce:after:animate-none",
    (still || loaded) && "after:animate-none after:opacity-0",
    loaded && "is-loaded",
    still && "is-generic",
  );

function DraftThumbnail({ file }: { file: File }) {
  const [image, setImage] = useState("");
  const [text, setText] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const tabular = /\.(csv|tsv)$/i.test(file.name);
  const readable = tabular || file.type.startsWith("text/") || /\.(txt|md|json|log)$/i.test(file.name);
  const visual = isPreviewImage(file.type);
  useEffect(() => {
    let cancelled = false;
    if (visual) {
      const url = URL.createObjectURL(file);
      setImage(url);
      return () => URL.revokeObjectURL(url);
    }
    if (readable) {
      // Thumbnail work is bounded even for large uploads; content is always rendered as text.
      void file
        .slice(0, 12_000)
        .arrayBuffer()
        .then(
          (bytes) => {
            if (!cancelled) {
              setText(decodePreview(bytes));
              setLoaded(true);
            }
          },
          () => {
            if (!cancelled) setFailed(true);
          },
        );
    }
    return () => {
      cancelled = true;
    };
  }, [file, visual, readable]);
  const rows = tabular && text !== null ? previewRows(text, /\.tsv$/i.test(file.name) ? "\t" : ",", 8, 6).rows : null;
  const generic = (!visual && !readable) || failed;
  return (
    <span className={cn(thumbnailClass(generic, loaded), "draft-thumbnail")} aria-hidden="true">
      {visual && image && !failed && (
        <img
          className={IMAGE_CLASS}
          src={image}
          alt=""
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
      {rows ? (
        <span className={CONTENT_CLASS}>
          <table>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </span>
      ) : text !== null ? (
        <span className={CONTENT_CLASS}>
          <pre>{text.slice(0, 1800)}</pre>
        </span>
      ) : (
        generic && (
          <span className={FILE_TYPE_CLASS}>
            <Icon name="memory" size={32} />
            <span>{file.name.split(".").pop()?.slice(0, 8).toUpperCase() || "FILE"}</span>
          </span>
        )
      )}
    </span>
  );
}

/** A page of text or a table, drawn small like a paper sheet whatever the colour scheme. */
const CONTENT_CLASS =
  "draft-thumbnail-content block h-full overflow-hidden bg-white text-[#222] opacity-0 transition-opacity duration-[240ms] group-[.is-loaded]/thumb:opacity-100 motion-reduce:transition-none [&_pre]:m-0 [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:p-2.5 [&_pre]:font-mono [&_pre]:text-[7px] [&_pre]:leading-[1.5] [&_table]:w-full [&_table]:table-fixed [&_table]:border-collapse [&_table]:font-sans [&_table]:text-[8px] [&_table]:leading-[1.6] [&_td]:max-w-16 [&_td]:overflow-hidden [&_td]:whitespace-nowrap [&_td]:border [&_td]:border-[#ddd] [&_td]:px-[3px] [&_td]:py-0.5";
