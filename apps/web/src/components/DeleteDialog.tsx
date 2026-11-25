import { useId, useState } from "react";
import { ConfirmDialog, NATIVE_CHECK } from "./dialogParts.tsx";

interface Props {
  title: string;
  /** Chats were branched from this one: offer to delete them too. */
  hasBranches: boolean;
  /** This chat started other sessions; they stay but stop reporting back. */
  hasSpawned: boolean;
  /** Clearing a Home chat replaces it with an empty one. */
  home?: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (withForks: boolean) => void;
}

export function DeleteDialog({
  title,
  hasBranches,
  hasSpawned,
  home = false,
  busy,
  error,
  onCancel,
  onConfirm,
}: Props) {
  const [withForks, setWithForks] = useState(false);
  const forksId = useId();
  return (
    <ConfirmDialog
      title={home ? "Clear Home chat?" : "Delete this chat?"}
      description={
        <>
          {home ? (
            <p>
              The messages in “{title}” will be permanently deleted and a fresh Home chat will open. Saved memories
              stay.
            </p>
          ) : (
            <p>“{title}” and its messages will be removed. This can't be undone.</p>
          )}
          {hasSpawned && <p>Sessions it started stay, but they won't report back.</p>}
        </>
      }
      error={error}
      busy={busy}
      confirmLabel={home ? "Clear Home chat" : "Delete"}
      busyLabel={home ? "Clearing…" : "Deleting…"}
      onCancel={onCancel}
      onConfirm={() => onConfirm(hasBranches && withForks)}
    >
      {hasBranches && (
        <label htmlFor={forksId} className="flex min-h-9 cursor-pointer items-center gap-2.5 text-sm">
          <input
            id={forksId}
            type="checkbox"
            className={NATIVE_CHECK}
            checked={withForks}
            disabled={busy}
            onChange={(e) => setWithForks(e.target.checked)}
          />
          Also delete its branches
        </label>
      )}
    </ConfirmDialog>
  );
}
