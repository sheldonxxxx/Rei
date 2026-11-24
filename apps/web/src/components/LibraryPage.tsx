import type { Attachment, LibraryFile, LibraryList } from "@rei/protocol";
import { filePreview } from "@rei/protocol";
import { createPositioner } from "masonic";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/primitives/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/primitives/dropdown-menu.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/primitives/empty.tsx";
import { Field } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Label } from "@/components/primitives/label.tsx";
import { NativeSelect } from "@/components/primitives/native-select.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/primitives/popover.tsx";
import { ToggleGroup, ToggleGroupItem } from "@/components/primitives/toggle-group.tsx";
import { cn } from "@/lib/utils.ts";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import { fileBytes, fileContentUrl, libraryAttachment } from "../lib/library.ts";
import { ConfirmDialog, DialogError } from "./dialogParts.tsx";
import { FilePreview } from "./FilePreview.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { Tip } from "./Tip.tsx";

export function LibraryPage({
  api,
  initialFileId,
  onBack,
}: {
  api: Api;
  initialFileId?: string | null;
  /** Phones only: back to the list of chats, where the sidebar is its own screen. */
  onBack?: (() => void) | undefined;
}) {
  const [data, setData] = useState<LibraryList>({ files: [], folders: [], nextCursor: null });
  const [q, setQ] = useState(""),
    [type, setType] = useState(""),
    [origin, setOrigin] = useState(""),
    [sort, setSort] = useState("recent");
  const [tab, setTab] = useState<"all" | "favorites" | "trash">("all"),
    [folder, setFolder] = useState("");
  const [layout, setLayout] = useState("grid"),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState<string[]>([]),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [dialog, setDialog] = useState<{
    kind: "folder" | "folderRename" | "purge";
    id?: string;
    value?: string;
  } | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const query = {
    q,
    type,
    origin,
    sort,
    ...(folder ? { folder } : {}),
    ...(tab === "trash" ? { trash: "1" } : {}),
    ...(tab === "favorites" ? { favorite: "1" } : {}),
  };
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSelected([]);
    const timer = window.setTimeout(() => {
      void api
        .listFiles(query)
        .then(
          (r) => {
            if (!cancelled) {
              setData(r);
              setError("");
              setLoadFailed(false);
            }
          },
          (e) => {
            if (!cancelled) {
              setError(describeError(e));
              setLoadFailed(true);
            }
          },
        )
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, q, type, origin, sort, tab, folder, revision]);
  useEffect(() => {
    let cancelled = false;
    if (initialFileId)
      void api.getFile(initialFileId).then(
        (r) => {
          if (!cancelled) setPreview(libraryAttachment(r.file));
        },
        (e) => {
          if (!cancelled) setError(describeError(e));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [api, initialFileId]);
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      setRevision((n) => n + 1);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  const each = (patch: Parameters<Api["patchFile"]>[1]) =>
    act(async () => {
      for (const id of selected) await api.patchFile(id, patch);
    });
  const currentFolder = data.folders.find((f) => f.id === folder);
  const filtered = Boolean(q || type || origin);
  function clearFilters() {
    setQ("");
    setType("");
    setOrigin("");
  }
  const itemsFor = (file: LibraryFile) => ({
    file,
    selected: selected.includes(file.id),
    onSelect: (checked: boolean) =>
      setSelected((old) => (checked ? [...old, file.id] : old.filter((id) => id !== file.id))),
    onOpen: () => setPreview(libraryAttachment(file)),
  });
  return (
    <section
      className="library-page flex h-full min-w-0 flex-col gap-5 overflow-auto p-6 max-md:gap-4 max-md:p-3.5"
      aria-label="File library"
      data-enter="fade"
    >
      <header className="library-header flex flex-wrap items-center gap-3">
        {onBack && (
          <Tip label="Back">
            <Button size="icon-sm" variant="ghost" type="button" className="size-11" aria-label="Back" onClick={onBack}>
              <Icon name="back" />
            </Button>
          </Tip>
        )}
        <h1 className="mr-auto min-w-0 text-3xl font-semibold tracking-tight max-md:text-2xl">Library</h1>
      </header>
      <div className="library-toolbar flex flex-wrap items-center gap-2">
        <div className="library-search relative min-w-32 max-w-md flex-1">
          <Icon
            name="search"
            size={16}
            className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search library"
            placeholder="Search library"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-9 pl-9"
          />
        </div>
        <div className="library-view-controls flex items-center gap-1">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                type="button"
                aria-label="Filters"
                title="Filters"
                className="relative"
              >
                <Icon name="filter" />
                {Boolean(type || origin) && (
                  <span aria-hidden="true" className="absolute top-2 right-2 size-1.5 rounded-full bg-primary" />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 gap-3">
              <div className="grid gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Type</span>
                <NativeSelect aria-label="Filter by type" value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="">All types</option>
                  {["image", "office", "pdf", "html", "markdown", "text", "csv", "audio", "video"].map((v) => (
                    <option key={v} value={v}>
                      {v.toUpperCase()}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="grid gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Origin</span>
                <NativeSelect aria-label="Filter by origin" value={origin} onChange={(e) => setOrigin(e.target.value)}>
                  <option value="">All origins</option>
                  <option value="upload">Uploaded</option>
                  <option value="agent">Agent-created</option>
                </NativeSelect>
              </div>
              {filtered && (
                <Button variant="outline" type="button" onClick={clearFilters}>
                  Reset filters
                </Button>
              )}
            </PopoverContent>
          </Popover>
          {/* No Tip around these: Tooltip's trigger overwrites the toggle's data-state, so the pressed style never shows. */}
          <ToggleGroup
            type="single"
            spacing={1}
            value={layout}
            onValueChange={(value) => value && setLayout(value)}
            aria-label="Library layout"
          >
            <ToggleGroupItem value="grid" aria-label="Grid" className="px-2.5">
              <Icon name="grid" size={18} />
            </ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="List" className="px-2.5">
              <Icon name="list" size={18} />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="library-actions flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" disabled={busy} className="rounded-full px-4">
                New
                <Icon name="chevron" size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => upload.current?.click()}>
                <Icon name="upload" size={16} />
                Upload files
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog({ kind: "folder" })}>
                <Icon name="folder" size={16} />
                New folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" type="button" aria-label="View options" title="View options">
                <Icon name="sliders" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
                <DropdownMenuRadioItem value="recent">Recently updated</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="oldest">Oldest updated</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setRevision((n) => n + 1)}>
                <Icon name="reload" size={16} />
                Refresh
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <input
          ref={upload}
          type="file"
          multiple
          hidden
          aria-label="Upload to Library"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void act(async () => {
              for (const file of files) await api.uploadLibraryFile(file, { folderId: folder || undefined });
            });
          }}
        />
      </div>
      <nav className="library-tabs flex flex-wrap items-center gap-2" aria-label="Library views">
        <ToggleGroup
          type="single"
          spacing={1}
          value={tab}
          onValueChange={(value) => {
            if (value) {
              setTab(value as typeof tab);
              setFolder("");
            }
          }}
        >
          {(["all", "favorites", "trash"] as const).map((name) => (
            <ToggleGroupItem key={name} value={name}>
              {name === "all" ? "All files" : name === "favorites" ? "Favorites" : "Trash"}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </nav>
      {data.folders.length > 0 && (
        <nav
          className="library-folders flex flex-wrap items-center gap-1.5 [overflow-wrap:anywhere]"
          aria-label="Folders"
        >
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className="nav-selection rounded-full aria-[current=page]:bg-accent"
            aria-current={!folder ? "page" : undefined}
            onClick={() => setFolder("")}
          >
            All folders
          </Button>
          {data.folders.map((f) => (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              key={f.id}
              className="nav-selection rounded-full aria-[current=page]:bg-accent"
              aria-current={folder === f.id ? "page" : undefined}
              onClick={() => setFolder(f.id)}
            >
              <Icon name="folder" size={16} />
              {f.parentId ? `${data.folders.find((p) => p.id === f.parentId)?.name ?? ""} / ` : ""}
              {f.name}
            </Button>
          ))}
          {currentFolder && (
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => setDialog({ kind: "folderRename", id: folder, value: currentFolder.name })}
              >
                Rename folder
              </Button>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api.deleteLibraryFolder(folder);
                    setFolder("");
                  })
                }
              >
                Remove folder (keep files)
              </Button>
            </div>
          )}
        </nav>
      )}
      <div className="library-content flex min-w-0 flex-col gap-4">
        {error && (
          <p
            role="alert"
            className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
          >
            {error}
          </p>
        )}
        {busy && <p role="status">Saving changes…</p>}
        {!!selected.length && (
          <div
            role="toolbar"
            className="library-selection flex flex-wrap items-center gap-2 rounded-2xl border bg-muted/40 p-3 [&>strong]:text-sm"
            aria-label="Selected file actions"
          >
            <strong>{selected.length} selected</strong>
            <Button variant="outline" type="button" onClick={() => setSelected([])}>
              Clear
            </Button>
            {tab === "trash" ? (
              <>
                <Button variant="outline" type="button" disabled={busy} onClick={() => void each({ trashed: false })}>
                  Restore
                </Button>
                <Button
                  variant="destructive"
                  type="button"
                  disabled={busy}
                  onClick={() => setDialog({ kind: "purge" })}
                >
                  Delete permanently
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" type="button" disabled={busy} onClick={() => void each({ favorite: true })}>
                  Favorite
                </Button>
                <Button variant="outline" type="button" disabled={busy} onClick={() => void each({ favorite: false })}>
                  Unfavorite
                </Button>
                <NativeSelect
                  aria-label="Move selected files"
                  value=""
                  disabled={busy}
                  onChange={(e) => {
                    if (e.target.value) void each({ folderId: e.target.value === "root" ? null : e.target.value });
                  }}
                >
                  <option value="">Move to…</option>
                  <option value="root">Library root</option>
                  {data.folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </NativeSelect>
                <Button variant="outline" type="button" disabled={busy} onClick={() => void each({ trashed: true })}>
                  Move to Trash
                </Button>
              </>
            )}
          </div>
        )}
        {loading ? (
          <p role="status">Loading library…</p>
        ) : !data.files.length ? (
          <Empty className="library-empty border py-12">
            <EmptyHeader>
              <Icon name={filtered ? "search" : "library"} size={32} />
              <EmptyTitle>
                <h2>
                  {loadFailed
                    ? "Couldn’t load files"
                    : filtered
                      ? "No matching files"
                      : tab === "trash"
                        ? "Trash is empty"
                        : tab === "favorites"
                          ? "No favorites yet"
                          : "No files here yet"}
                </h2>
              </EmptyTitle>
              <EmptyDescription>
                {loadFailed
                  ? "Try loading your files again."
                  : filtered
                    ? "Try another search or clear your filters."
                    : tab === "trash"
                      ? "Files in Trash are kept for 30 days."
                      : tab === "favorites"
                        ? "Favorite files to find them here."
                        : "Upload files or save them from a chat."}
              </EmptyDescription>
            </EmptyHeader>
            {loadFailed ? (
              <Button variant="outline" type="button" onClick={() => setRevision((n) => n + 1)}>
                Try again
              </Button>
            ) : filtered ? (
              <Button variant="outline" type="button" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : tab === "all" ? (
              <Button type="button" disabled={busy} onClick={() => upload.current?.click()}>
                <Icon name="upload" size={16} /> Upload files
              </Button>
            ) : null}
          </Empty>
        ) : (
          <>
            <label className="library-select-all flex items-center gap-2 text-sm [&_input]:size-4 [&_input]:accent-primary">
              <input
                type="checkbox"
                checked={selected.length === data.files.length}
                onChange={(e) => setSelected(e.target.checked ? data.files.map((f) => f.id) : [])}
              />{" "}
              Select this page
            </label>
            {layout === "list" ? (
              <ul className="library-files is-list m-0 flex list-none flex-col gap-2 p-0">
                {data.files.map((file) => (
                  <LibraryRow key={file.id} {...itemsFor(file)} />
                ))}
              </ul>
            ) : (
              <LibraryMasonry files={data.files} itemsFor={itemsFor} />
            )}
            {data.nextCursor && (
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void api
                    .listFiles({ ...query, cursor: data.nextCursor! })
                    .then(
                      (next) => setData((old) => ({ ...next, files: [...old.files, ...next.files] })),
                      (e) => setError(describeError(e)),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Load more
              </Button>
            )}
          </>
        )}
      </div>
      {preview && (
        <FilePreview
          key={`${preview.fileId}:${preview.versionId}`}
          file={preview}
          onClose={() => {
            setPreview(null);
            setRevision((n) => n + 1);
          }}
        />
      )}
      {dialog && (
        <LibraryDialog
          title={
            dialog.kind === "purge"
              ? "Delete selected files permanently?"
              : dialog.kind === "folder"
                ? "New folder"
                : "Rename"
          }
          initialValue={dialog.value}
          danger={dialog.kind === "purge"}
          usage={dialog.kind === "purge" ? { api, fileIds: selected } : undefined}
          onClose={() => setDialog(null)}
          onSave={async (value) => {
            if (dialog.kind === "purge") {
              for (const id of selected) await api.purgeFile(id);
            } else
              await api.saveLibraryFolder(
                value,
                dialog.kind === "folder" ? folder || null : (currentFolder?.parentId ?? null),
                dialog.id,
              );
            setRevision((n) => n + 1);
          }}
        />
      )}
    </section>
  );
}

type FileItem = {
  file: LibraryFile;
  selected: boolean;
  onSelect: (checked: boolean) => void;
  onOpen: () => void;
};

function LibraryMasonry({ files, itemsFor }: { files: LibraryFile[]; itemsFor: (file: LibraryFile) => FileItem }) {
  const gridRef = useRef<HTMLUListElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Observe the current card elements when the file results change.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const cards = Array.from(grid.querySelectorAll<HTMLLIElement>(":scope > li"));
    const mobile = window.matchMedia("(width < 48rem)");

    // Keep every loaded card in DOM order for keyboard navigation and selection.
    const arrange = () => {
      const width = grid.clientWidth;
      const gap = Number.parseFloat(getComputedStyle(grid).columnGap) || 0;
      const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const minColumnWidth = 13.75 * rootFontSize;
      const columns = mobile.matches ? 2 : Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)));
      const columnWidth = Math.max(0, (width - gap * (columns - 1)) / columns);
      const positioner = createPositioner(columns, columnWidth, gap);

      for (const card of cards) card.style.width = `${columnWidth}px`;
      const measured = cards.map((card) => ({ card, height: card.getBoundingClientRect().height }));
      for (const [index, { card, height }] of measured.entries()) {
        positioner.set(index, height);
        const position = positioner.get(index);
        if (!position) continue;
        card.style.top = `${position.top}px`;
        card.style.insetInlineStart = `${position.left}px`;
      }
      grid.style.height = `${positioner.estimateHeight(cards.length, 0) - gap}px`;
    };

    arrange();
    const observer = new ResizeObserver(arrange);
    observer.observe(grid);
    for (const card of cards) observer.observe(card, { box: "border-box" });
    mobile.addEventListener("change", arrange);
    return () => {
      observer.disconnect();
      mobile.removeEventListener("change", arrange);
    };
  }, [files]);

  return (
    <ul ref={gridRef} className="library-files is-grid relative m-0 list-none gap-4 p-0 max-md:gap-2.5">
      {files.map((file) => (
        <LibraryCard key={file.id} {...itemsFor(file)} />
      ))}
    </ul>
  );
}

/** A masonry tile: title bar on top, preview in the body, metadata and actions underneath. */
function LibraryCard({ file, selected, onSelect, onOpen }: FileItem) {
  return (
    <li
      className={cn(
        "library-card absolute overflow-hidden rounded-2xl border bg-card",
        selected && "ring-2 ring-primary",
      )}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <SelectBox file={file} checked={selected} onChange={onSelect} />
        <Icon name={fileIconName(file)} size={16} className="shrink-0 text-muted-foreground" />
        <Tip label={file.name}>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {file.favorite ? "★ " : ""}
            {file.name}
          </span>
        </Tip>
      </div>
      <button type="button" aria-label={`Preview ${file.name}`} className="block w-full" onClick={onOpen}>
        <LibraryThumbnail file={file} />
      </button>
      <div className="flex flex-col gap-0.5 border-t px-3 py-2.5 text-xs text-muted-foreground">
        <span className="truncate">{fileMeta(file)}</span>
        <span className="truncate">{new Date(file.updatedAt).toLocaleString()}</span>
      </div>
    </li>
  );
}

/** The same file as a single line, for the list layout. */
function LibraryRow({ file, selected, onSelect, onOpen }: FileItem) {
  return (
    <li
      className={cn(
        "library-row flex items-center gap-3 rounded-2xl border bg-card px-3 py-2",
        selected && "ring-2 ring-primary",
      )}
    >
      <SelectBox file={file} checked={selected} onChange={onSelect} />
      <Icon name={fileIconName(file)} size={18} className="shrink-0 text-muted-foreground" />
      <button
        type="button"
        aria-label={`Preview ${file.name}`}
        className="min-w-0 flex-1 truncate text-left text-sm font-medium"
        onClick={onOpen}
      >
        {file.favorite ? "★ " : ""}
        {file.name}
      </button>
      <span className="hidden shrink-0 text-xs text-muted-foreground md:block">{fileMeta(file)}</span>
      <span className="hidden shrink-0 text-xs text-muted-foreground lg:block">
        {new Date(file.updatedAt).toLocaleString()}
      </span>
    </li>
  );
}

function SelectBox({
  file,
  checked,
  onChange,
}: {
  file: LibraryFile;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      className="size-4 shrink-0 accent-primary"
      aria-label={`Select ${file.name}`}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function fileMeta(file: LibraryFile) {
  return `${fileBytes(file.current.size)} · v${file.current.number} · ${file.origin === "upload" ? "Uploaded" : file.creator}`;
}

function fileIconName(file: LibraryFile): IconName {
  const format = filePreview({ name: file.name, mediaType: file.current.mediaType });
  if (/\.(xls[xmb]?|xltx?|ods|csv|tsv)$/i.test(file.name)) return "spreadsheet";
  if (/\.(pptx?|ppsx?|odp)$/i.test(file.name)) return "presentation";
  if (format.kind === "image") return "image";
  return ["html", "text"].includes(format.kind) ? "terminal" : "file";
}

export function LibraryThumbnail({ file }: { file: LibraryFile }) {
  const format = filePreview({ name: file.name, mediaType: file.current.mediaType });
  if (
    format.kind === "image" &&
    ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(format.mediaType)
  )
    return (
      // Images keep their own proportions, so tiles with pictures come out at different heights.
      <span className="block min-h-28 bg-muted/50">
        <img
          src={`${fileContentUrl(file.current)}?thumbnail=1`}
          alt=""
          loading="lazy"
          className="block h-auto max-h-80 w-full object-contain"
        />
      </span>
    );
  return (
    <span className="flex aspect-[4/5] w-full flex-col items-center justify-center gap-3 bg-muted/50 text-muted-foreground">
      <Icon name={fileIconName(file)} size={40} />
      <span className="text-xs font-medium">{file.name.split(".").pop()?.slice(0, 8).toUpperCase() || "FILE"}</span>
    </span>
  );
}
export function LibraryDialog({
  title,
  initialValue = "",
  danger,
  usage,
  onClose,
  onSave,
}: {
  title: string;
  initialValue?: string;
  danger?: boolean;
  /** Before a permanent delete: the Knowledge pages that link to these files. */
  usage?: { api: Api; fileIds: string[] } | undefined;
  onClose: () => void;
  onSave: (value: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState(initialValue),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null),
    nameId = useId();
  const [pages, setPages] = useState<{ id: string; title: string }[]>([]);
  const usageApi = usage?.api;
  const usageKey = usage?.fileIds.join(",") ?? "";
  useEffect(() => {
    if (!usageApi || !usageKey) return;
    let cancelled = false;
    Promise.all(usageKey.split(",").map((id) => usageApi.knowledgeFileUsage(id).catch(() => ({ pages: [] }))))
      .then((all) => {
        if (cancelled) return;
        const seen = new Map<string, { id: string; title: string }>();
        for (const r of all) for (const p of r.pages) seen.set(p.id, p);
        setPages([...seen.values()]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [usageApi, usageKey]);
  const save = () => {
    setBusy(true);
    void onSave(value).then(onClose, (e) => {
      setError(describeError(e));
      setBusy(false);
    });
  };
  if (danger)
    return (
      <ConfirmDialog
        title={title}
        description={
          <>
            <p>
              This removes the files from Library. This action cannot be undone. Historical chat references retain their
              pinned bytes.
            </p>
            {pages.length > 0 && (
              <p>
                Used in {pages.length} Knowledge page{pages.length === 1 ? "" : "s"} (
                {pages
                  .slice(0, 3)
                  .map((p) => `“${p.title}”`)
                  .join(", ")}
                {pages.length > 3 ? ", …" : ""}). Their links will show “File removed”.
              </p>
            )}
          </>
        }
        error={error}
        busy={busy}
        confirmLabel="Delete permanently"
        busyLabel="Saving…"
        onCancel={onClose}
        onConfirm={save}
      />
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          input.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim() && !busy) save();
          }}
        >
          <Field className="gap-2">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              ref={input}
              id={nameId}
              disabled={busy}
              value={value}
              maxLength={240}
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
          {error && <DialogError>{error}</DialogError>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !value.trim()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
