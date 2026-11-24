import type { MemorySetupSettings } from "@rei/protocol";
import { useEffect, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { NativeSelect } from "@/components/primitives/native-select.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import { SearchProviderSettings } from "./SearchProviderSettings.tsx";

export function SetupServices(props: { api: Api; kind: "memory" | "search"; onSaved: () => void }) {
  return props.kind === "search" ? (
    <SearchProviderSettings api={props.api} onSaved={props.onSaved} />
  ) : (
    <MemorySetupServices api={props.api} onSaved={props.onSaved} />
  );
}
function MemorySetupServices({ api, onSaved }: { api: Api; onSaved: () => void }) {
  const [memory, setMemory] = useState<MemorySetupSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    void api
      .getMemorySetup()
      .then((value) => {
        if (active) setMemory(value);
      })
      .catch((cause) => {
        if (active) setError(describeError(cause));
      });
    return () => {
      active = false;
    };
  }, [api]);
  return (
    <form
      className="grid gap-3 border-t pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!memory) return;
        setBusy(true);
        setError(null);
        setSaved(false);
        void api
          .saveMemorySetup(memory.enabled)
          .then((value) => {
            setMemory(value);
            setSaved(true);
            onSaved();
          })
          .catch((cause) => setError(describeError(cause)))
          .finally(() => setBusy(false));
      }}
    >
      {memory && (
        <>
          <label htmlFor="setup-memory-mode" className="grid gap-2 text-sm font-medium">
            Search conversations
            <NativeSelect
              id="setup-memory-mode"
              value={memory.enabled ? "meaning" : "keyword"}
              onChange={(event) => {
                setMemory({ ...memory, enabled: event.target.value === "meaning" });
                setSaved(false);
              }}
            >
              <option value="keyword">Keyword search</option>
              <option value="meaning" disabled={!memory.available}>
                Meaning + keyword search
              </option>
            </NativeSelect>
          </label>
          <p className="m-0 text-xs text-muted-foreground">
            {memory.available
              ? `Embedding model: ${memory.model}`
              : "Keyword search is ready. No embedding service is installed."}
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="m-0 text-sm text-primary">
          Saved
        </p>
      )}
      <Button type="submit" variant="outline" size="sm" disabled={busy || !memory}>
        {busy ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
