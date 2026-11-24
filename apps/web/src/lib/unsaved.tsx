import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState } from "react";

// Settings forms report whether they hold edits the server does not have yet. The Settings window reads the
// combined answer to ask before it closes or switches section, and to warn before the page unloads.

interface UnsavedState {
  anyDirty: boolean;
  report: (id: string, dirty: boolean) => void;
}

const UnsavedContext = createContext<UnsavedState>({ anyDirty: false, report: () => {} });

/** Holds the set of forms that currently have unsaved edits. */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(() => new Set());
  const report = useCallback((id: string, dirty: boolean) => {
    setDirtyIds((previous) => {
      if (previous.has(id) === dirty) return previous;
      const next = new Set(previous);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const anyDirty = dirtyIds.size > 0;

  useEffect(() => {
    if (!anyDirty) return;
    // The browser shows its own generic prompt; the page only has to ask for it.
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [anyDirty]);

  const value = useMemo(() => ({ anyDirty, report }), [anyDirty, report]);
  return <UnsavedContext.Provider value={value}>{children}</UnsavedContext.Provider>;
}

/** True while any form under the provider has unsaved edits. */
export function useAnyUnsaved(): boolean {
  return useContext(UnsavedContext).anyDirty;
}

/** Reports this form's dirty state to the nearest provider, and clears it when the form unmounts. */
export function useReportUnsaved(dirty: boolean): void {
  const { report } = useContext(UnsavedContext);
  const id = useId();
  useEffect(() => {
    report(id, dirty);
  }, [report, id, dirty]);
  useEffect(() => () => report(id, false), [report, id]);
}

/**
 * Whether `value` differs from the last saved snapshot. Call `markSaved` with the same shape whenever the server
 * has the values (after loading them and after a save). Nothing is dirty until the first snapshot is taken.
 */
export function useDirtyBaseline(value: unknown): { dirty: boolean; markSaved: (saved: unknown) => void } {
  const [baseline, setBaseline] = useState<string | null>(null);
  const markSaved = useCallback((saved: unknown) => setBaseline(JSON.stringify(saved)), []);
  return { dirty: baseline !== null && baseline !== JSON.stringify(value), markSaved };
}
