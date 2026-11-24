import { Badge } from "@/components/primitives/badge.tsx";
import type { ConnectionStatus } from "../stream/connection.ts";
import { Tip } from "./Tip.tsx";

/** Quiet while connected (screen readers still get the state); a small pill while connecting or reconnecting. */
export function ConnectionBadge({ status, name }: { status: ConnectionStatus; name: string }) {
  const text = status === "connected" ? "Connected" : status === "connecting" ? "Connecting…" : "Reconnecting…";
  if (status === "connected") return <span className="sr-only">{`${name}: ${text}`}</span>;
  return (
    <Tip label={`${name}: ${text}`}>
      <Badge variant="secondary" className={`conn conn-${status} text-muted-foreground`} role="status">
        <span className="conn-dot size-1.5 animate-pulse rounded-full bg-warning" aria-hidden="true" />
        {text}
      </Badge>
    </Tip>
  );
}
