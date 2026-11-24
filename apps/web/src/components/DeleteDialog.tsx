import { useId, useState } from "react";
import { ConfirmDialog, NATIVE_CHECK } from "./dialogParts.tsx";

interface Props {
  title: string;
  /** Chats were branched from this one: offer to delete them too. */
  hasBranches: boolean;
  /** This chat started other sessions; they stay but stop reporting back. */
  hasSpawned: boolean;
  /** A home chat stays; deleting it clears what was said in it. */
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
      title={home ? "Delete this chat's history?" : "Delete this chat?"}
      description={
        <>
          {home ? (
            <p>Everything said in “{title}” will be deleted. The chat itself stays. This can't be undone.</p>
          ) : (
            <p>“{title}” and its messages will be removed. This can't be undone.</p>
          )}
          {hasSpawned && <p>Sessions it started stay, but they won't report back.</p>}
        </>
      }
      error={error}
      busy={busy}
      confirmLabel="Delete"
      busyLabel="Deleting…"
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
