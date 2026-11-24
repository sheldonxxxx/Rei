import { Button } from "@/components/primitives/button.tsx";
import { Icon } from "./Icon.tsx";
import { Tip } from "./Tip.tsx";

export function InfoTip({ label, children }: { label: string; children: string }) {
  return (
    <Tip label={children}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-muted-foreground"
        aria-label={label}
      >
        <Icon name="info" size={14} />
      </Button>
    </Tip>
  );
}
