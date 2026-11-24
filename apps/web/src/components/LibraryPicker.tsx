import type { Attachment, LibraryFile } from "@rei/protocol";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/primitives/dialog.tsx";
import { Input } from "@/components/primitives/input.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import { fileBytes, libraryAttachment } from "../lib/library.ts";
import { DialogError, NATIVE_CHECK, OPTION_CARD } from "./dialogParts.tsx";
export function LibraryPicker({
  api,
  onClose,
  onChoose,
  excluded = [],
}: {
  api: Api;
  onClose: () => void;
  onChoose: (files: Attachment[]) => void;
  excluded?: string[];
}) {
  const [files, setFiles] = useState<LibraryFile[]>([]),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api.listFiles({ q: query }).then(
        (r) => {
          if (!cancelled) {
            setFiles(r.files);
            setError("");
          }
        },
        (e) => {
          if (!cancelled) setError(describeError(e));
        },
      );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, query]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        size="lg"
        showCloseButton={false}
        aria-describedby={undefined}
        className="library-picker"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          input.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Choose library files</DialogTitle>
        </DialogHeader>
        <Input
          ref={input}
          aria-label="Search saved files"
          placeholder="Search saved files"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected([]);
          }}
        />
        {error && <DialogError>{error}</DialogError>}
        <ul className="m-0 flex max-h-[min(24rem,50dvh)] list-none flex-col overflow-y-auto p-0">
          {files.map((file) => (
            <li key={file.id}>
              <label className={`${OPTION_CARD} border-transparent`}>
                <input
                  type="checkbox"
                  className={`${NATIVE_CHECK} mt-0.5`}
                  disabled={
                    excluded.includes(file.current.attachmentId) ||
                    (!selected.includes(file.id) && selected.length + excluded.length >= 10)
                  }
                  checked={selected.includes(file.id)}
                  onChange={(e) =>
                    setSelected((s) => (e.target.checked ? [...s, file.id] : s.filter((id) => id !== file.id)))
                  }
                />
                <span className="flex min-w-0 flex-col">
                  <strong className="text-sm font-medium [overflow-wrap:anywhere]">{file.name}</strong>
                  <small className="text-xs text-muted-foreground">
                    v{file.current.number} · {fileBytes(file.current.size)}
                  </small>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!selected.length}
            onClick={() => {
              onChoose(files.filter((f) => selected.includes(f.id)).map(libraryAttachment));
            }}
          >
            Attach selected versions
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
