import type { ReactNode } from "react";
import { TabsContent, TabsList, Tabs as TabsRoot, TabsTrigger } from "@/components/primitives/tabs.tsx";

export interface TabDef<T extends string> {
  id: T;
  label: string;
}

/**
 * A tab list with one panel (the active one is `children`). Radix gives the ARIA wiring and Left/Right/Home/End.
 * A plain click also selects: Radix selects on mouse-down and focus, which a screen reader's "activate" doesn't send.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  children,
  label,
}: {
  tabs: TabDef<T>[];
  value: T;
  onChange: (id: T) => void;
  children: ReactNode;
  label: string;
}) {
  return (
    <TabsRoot value={value} onValueChange={(v) => onChange(v as T)} className="tabs gap-2.5">
      <TabsList
        variant="line"
        aria-label={label}
        className="tab-list sticky top-0 z-2 w-full justify-start border-b bg-sidebar px-0 max-md:bg-background"
      >
        {tabs.map((t) => (
          <TabsTrigger
            key={t.id}
            value={t.id}
            className="tab flex-none max-md:min-h-11 data-active:text-primary"
            onClick={() => onChange(t.id)}
          >
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={value} className="tab-panel min-w-0">
        {children}
      </TabsContent>
    </TabsRoot>
  );
}
