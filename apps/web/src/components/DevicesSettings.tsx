import type { Device } from "@rei/protocol";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Input } from "@/components/primitives/input.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import { ago } from "../lib/time.ts";

const CHANNEL_NAMES: Record<string, string> = {
  webpush: "Browser notifications",
  apns: "Apple notifications",
  fcm: "Android notifications",
};

/** Every sign-in, newest use first: rename one, or sign it out. Signing this device out signs you out here. */
export function DevicesSettings({
  api,
  onLogout,
}: {
  api: Pick<Api, "getDevices" | "renameDevice" | "revokeDevice">;
  onLogout: () => void;
}) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setDevices((await api.getDevices()).devices);
    } catch (e) {
      setError(describeError(e));
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  const rename = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editing) return;
    void run(async () => {
      await api.renameDevice(editing.id, editing.label.trim());
      setEditing(null);
    });
  };
  const revoke = (device: Device) =>
    void run(async () => {
      await api.revokeDevice(device.id);
      setConfirming(null);
      if (device.current) onLogout();
    });

  return (
    <section className="border-t py-5 space-y-3" aria-label="Devices">
      <h3 className="text-sm font-medium">Devices</h3>
      <p className="text-sm text-muted-foreground">
        Every browser and app signed in to Rei. Notifications wait while you are using any of them.
      </p>
      {devices === null && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      {devices && (
        <ul className="divide-y rounded-md border">
          {devices.map((device) => (
            <li key={device.id} className="flex flex-wrap items-start justify-between gap-3 p-3">
              {editing?.id === device.id ? (
                <form onSubmit={rename} className="flex w-full flex-wrap gap-2">
                  <Input
                    aria-label="Device name"
                    className="max-w-xs"
                    value={editing.label}
                    maxLength={60}
                    autoFocus
                    onChange={(e) => setEditing({ id: device.id, label: e.target.value })}
                  />
                  <Button type="submit" size="sm" disabled={busy || editing.label.trim() === ""}>
                    Save
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{device.label || "Unnamed device"}</span>
                      {device.current && <Badge variant="secondary">This device</Badge>}
                      {device.active && !device.current && <Badge variant="outline">In use</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Last used {ago(device.lastSeenAt)}
                      {device.channels.length > 0 &&
                        ` · ${device.channels
                          .map(
                            (c) =>
                              `${CHANNEL_NAMES[c.kind] ?? c.kind}${c.state === "not_configured" ? " (not set up on this server)" : c.state === "failing" ? " (failing)" : ""}`,
                          )
                          .join(", ")}`}
                    </p>
                  </div>
                  {confirming === device.id ? (
                    <div className="flex gap-2">
                      <Button size="sm" variant="destructive" disabled={busy} onClick={() => revoke(device)}>
                        {device.current ? "Sign out here" : "Sign out device"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing({ id: device.id, label: device.label })}
                        aria-label={`Rename ${device.label || "device"}`}
                      >
                        Rename
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirming(device.id)}
                        aria-label={`Sign out ${device.label || "device"}`}
                      >
                        Sign out
                      </Button>
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
