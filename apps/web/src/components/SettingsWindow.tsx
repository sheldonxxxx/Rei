import type { Agent, Companion, Session } from "@rei/protocol";
import type { MouseEvent } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/primitives/dialog.tsx";
import { Field, FieldContent, FieldDescription, FieldTitle } from "@/components/primitives/field.tsx";
import { Sheet, SheetContent, SheetTitle } from "@/components/primitives/sheet.tsx";
import { Switch } from "@/components/primitives/switch.tsx";
import { ToggleGroup, ToggleGroupItem } from "@/components/primitives/toggle-group.tsx";
import type { Api } from "../api/client.ts";
import { useFullMode } from "../lib/fullMode.tsx";
import type { SettingsRoute, SettingsSection } from "../lib/route.ts";
import {
  currentRoute,
  isCapabilityView,
  navigate,
  SETTINGS_PATH,
  SETTINGS_SECTIONS,
  settingsHref,
  TRIGGERS_PATH,
} from "../lib/route.ts";
import { MODES, parseMode, useTheme } from "../lib/theme.tsx";
import { UnsavedChangesProvider, useAnyUnsaved } from "../lib/unsaved.tsx";
import type { MemoryRev, PageRev } from "../stream/hooks.ts";
import { AccountSecurity } from "./AccountSecurity.tsx";
import { CapabilitiesPage } from "./CapabilitiesPage.tsx";
import { CompanionSetting } from "./CompanionSetting.tsx";
import { DevicesSettings } from "./DevicesSettings.tsx";
import type { IconName } from "./Icon.tsx";
import { Icon } from "./Icon.tsx";
import { MemoryPage } from "./MemoryPage.tsx";
import { ModelSettingsPage } from "./ModelSettingsPage.tsx";
import { NotificationSettings } from "./NotificationSettings.tsx";
import { PageShell } from "./PageShell.tsx";
import { PasskeySettings } from "./PasskeySettings.tsx";
import { PermissionsPage } from "./PermissionsPage.tsx";
import { ProviderSettingsPage } from "./ProviderSettingsPage.tsx";
import { RuntimeSettingsPage } from "./RuntimeSettingsPage.tsx";
import { TimeZoneSetting } from "./TimeZoneSetting.tsx";
import { Tip } from "./Tip.tsx";
import { TitleSettings } from "./TitleSettings.tsx";
import { TriggersPage } from "./TriggersPage.tsx";
import { UsagePage } from "./UsagePage.tsx";

const SECTIONS: Record<SettingsSection, { label: string; icon: IconName }> = {
  general: { label: "General", icon: "sliders" },
  usage: { label: "Usage", icon: "usage" },
  memory: { label: "Memory", icon: "memory" },
  triggers: { label: "Triggers", icon: "clock" },
  plugins: { label: "Capabilities", icon: "puzzle" },
  skills: { label: "Skills", icon: "sparkle" },
  connectors: { label: "Connectors", icon: "globe" },
  providers: { label: "Providers", icon: "key" },
  models: { label: "Models", icon: "brain" },
  runtime: { label: "Runtime", icon: "sparkle" },
  permissions: { label: "Permissions", icon: "shield" },
};

interface Props {
  api: Api;
  agents: Agent[];
  companion: Companion | null;
  sessions: Session[];
  route: SettingsRoute;
  /** Wide screens get a centred window with the sections beside the content; a phone gets a full-screen sheet. */
  wide: boolean;
  memoryRev: MemoryRev;
  pageRev: PageRev;
  onClose: () => void;
  onLogout: () => void;
}

/** Settings: General, Memory, Triggers, Capabilities (plugins, skills, connectors) and Permissions in one window over the chat. Close it and you are back in the chat. */
export function SettingsWindow(props: Props) {
  return (
    <UnsavedChangesProvider>
      <SettingsWindowBody {...props} />
    </UnsavedChangesProvider>
  );
}

/** Where a leave was asked for while a form has unsaved edits: closing the window, or following a link to another section. */
type Leaving = { kind: "close" } | { kind: "section"; href: string } | { kind: "back" };

/** A history move the window started itself, so its popstate is not read as the user's back button. */
type Pending = { kind: "drop" } | { kind: "back" } | { kind: "close" } | { kind: "href"; href: string };

const GUARD_STATE = "reiSettingsGuard";

function SettingsWindowBody({
  api,
  agents,
  companion,
  sessions,
  route,
  wide,
  memoryRev,
  pageRev,
  onClose,
  onLogout,
}: Props) {
  const root = useRef<HTMLDivElement>(null);
  const dirty = useAnyUnsaved();
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const requestClose = () => (dirty ? setLeaving({ kind: "close" }) : onClose());
  // A link to another section (the nav, or Back) asks first while a form is dirty.
  const guardLinks = (event: MouseEvent<HTMLElement>) => {
    if (!dirty || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element).closest?.("a[href^='/']");
    if (!(link instanceof HTMLAnchorElement)) return;
    const href = link.getAttribute("href") ?? "";
    if (href === currentRoute()) return;
    event.preventDefault();
    event.stopPropagation();
    setLeaving({ kind: "section", href });
  };

  // The browser's back button. While a form is dirty there is one extra history entry on top of the page, the guard.
  // Back pops the guard; the page puts it back and asks. Leaving then steps back past the guard (and the page) itself.
  const dirtyRef = useRef(dirty);
  const onCloseRef = useRef(onClose);
  const guardOnTop = useRef(false);
  const pending = useRef<Pending | null>(null);
  const backTimer = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    dirtyRef.current = dirty;
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (dirty && !guardOnTop.current) {
      window.history.pushState({ [GUARD_STATE]: true }, "", window.location.href);
      guardOnTop.current = true;
    } else if (!dirty && guardOnTop.current && !pending.current) {
      // Saved: drop the guard quietly so Back goes where it would have gone anyway.
      guardOnTop.current = false;
      pending.current = { kind: "drop" };
      window.history.back();
    }
  }, [dirty]);
  useEffect(() => {
    const onPop = () => {
      const next = pending.current;
      if (next) {
        pending.current = null;
        window.clearTimeout(backTimer.current);
        if (next.kind === "href") navigate(next.href);
        else if (next.kind === "close") onCloseRef.current();
        return;
      }
      if (!guardOnTop.current) return;
      guardOnTop.current = false;
      if (!dirtyRef.current) return;
      window.history.pushState({ [GUARD_STATE]: true }, "", window.location.href);
      guardOnTop.current = true;
      setLeaving({ kind: "back" });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const leave = () => {
    const target = leaving;
    setLeaving(null);
    if (!target) return;
    if (!guardOnTop.current) {
      // No guard entry on top (it was never placed or already dropped): leave directly.
      if (target.kind === "close") onCloseRef.current();
      else if (target.kind === "section") navigate(target.href);
      else window.history.back();
      return;
    }
    guardOnTop.current = false;
    if (target.kind === "back") {
      // Past the guard and the settings page, to where Settings was opened from.
      pending.current = { kind: "back" };
      window.history.go(-2);
      // With nothing earlier in the history, go(-2) does nothing; close the window instead.
      backTimer.current = window.setTimeout(() => {
        if (pending.current?.kind !== "back") return;
        pending.current = null;
        onCloseRef.current();
      }, 300);
    } else {
      pending.current = target.kind === "close" ? { kind: "close" } : { kind: "href", href: target.href };
      window.history.go(-1);
    }
  };
  // "/settings" alone: General beside the sections on a wide screen, the list of sections on a phone.
  const section = route.section ?? (wide ? "general" : null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset scroll on section or detail navigation, even though neither value is read by the effect.
  useLayoutEffect(() => {
    const body = root.current?.querySelector<HTMLElement>(".settings-body");
    if (body) body.scrollTop = 0;
  }, [section, route.id]);

  const focusContents = (event: Event) => {
    event.preventDefault();
    const el = root.current;
    (
      el?.querySelector<HTMLElement>('.settings-nav [aria-current="page"], .settings-head .back, .settings-list a') ??
      el?.querySelector<HTMLElement>(".settings-close")
    )?.focus();
  };
  const closeBtn = (
    <Tip label="Close" shortcut="Esc">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="settings-close text-muted-foreground"
        aria-label="Close settings"
        onClick={requestClose}
      >
        <Icon name="close" />
      </Button>
    </Tip>
  );
  const navLink =
    "row flex min-h-10 w-full items-center gap-2.5 rounded-xl px-3 text-sm text-foreground no-underline outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30 aria-[current=page]:bg-accent aria-[current=page]:font-medium";
  const content =
    section === "general" ? (
      <GeneralSettings api={api} agents={agents} companion={companion} onLogout={onLogout} />
    ) : section === "usage" ? (
      <UsagePage api={api} />
    ) : section === "memory" ? (
      <MemoryPage api={api} agents={agents} rev={memoryRev} />
    ) : section === "triggers" ? (
      <TriggersPage
        api={api}
        agents={agents}
        id={route.id}
        rev={pageRev.triggers}
        onClosed={() => navigate(TRIGGERS_PATH)}
      />
    ) : isCapabilityView(section) ? (
      <CapabilitiesPage api={api} agents={agents} view={section} id={route.id} rev={pageRev.skills} />
    ) : section === "providers" ? (
      <ProviderSettingsPage api={api} tab={route.id} />
    ) : section === "models" ? (
      <ModelSettingsPage api={api} />
    ) : section === "runtime" ? (
      <RuntimeSettingsPage api={api} />
    ) : section === "permissions" ? (
      <PermissionsPage api={api} agents={agents} sessions={sessions} />
    ) : null;

  const shell = wide ? (
    <Dialog open onOpenChange={(open) => !open && requestClose()}>
      <DialogContent
        ref={root}
        size="xl"
        showCloseButton={false}
        aria-describedby={undefined}
        onOpenAutoFocus={focusContents}
        onClickCapture={guardLinks}
        className="settings grid h-[min(46rem,88dvh)] grid-cols-[12rem_minmax(0,1fr)] gap-0 overflow-hidden p-0 md:max-w-[min(60rem,92vw)]"
      >
        <nav
          className="settings-nav flex min-h-0 flex-col gap-5 overflow-y-auto border-r bg-sidebar px-3 py-6"
          aria-label="Settings sections"
        >
          <DialogTitle className="px-3 text-lg">Settings</DialogTitle>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {SETTINGS_SECTIONS.map((s) => (
              <li key={s}>
                <a
                  href={settingsHref(s)}
                  className={navLink}
                  aria-current={section === s || (s === "plugins" && isCapabilityView(section)) ? "page" : undefined}
                >
                  <Icon name={SECTIONS[s].icon} size={18} />
                  <span className="row-title truncate">{SECTIONS[s].label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="settings-body min-h-0 min-w-0 overflow-y-auto p-8 pt-10">{content}</div>
        <div className="absolute top-3 right-3">{closeBtn}</div>
      </DialogContent>
    </Dialog>
  ) : (
    <Sheet open onOpenChange={(open) => !open && requestClose()}>
      <SheetContent
        ref={root}
        side="bottom"
        showCloseButton={false}
        aria-modal="true"
        aria-describedby={undefined}
        onOpenAutoFocus={focusContents}
        onClickCapture={guardLinks}
        className="settings sheet inset-0 h-dvh w-full border-0 pt-[var(--safe-t)] data-[side=bottom]:h-dvh"
      >
        <header className="settings-head flex min-h-14 shrink-0 items-center gap-2 border-b px-3 py-2">
          {section && (section === "providers" || !route.id) ? (
            <Tip label="Back to Settings">
              <Button asChild variant="ghost" size="icon-sm">
                <a className="back" href={SETTINGS_PATH} aria-label="Back to Settings">
                  <Icon name="back" />
                </a>
              </Button>
            </Tip>
          ) : (
            <span className="w-8 shrink-0" aria-hidden="true" />
          )}
          <SheetTitle className="flex-1 text-center">Settings</SheetTitle>
          {closeBtn}
        </header>
        <div className="settings-body min-h-0 min-w-0 flex-1 overflow-y-auto px-5 pt-6 pb-[calc(2rem+var(--safe-b))]">
          {section ? (
            content
          ) : (
            <nav aria-label="Settings sections">
              <ul className="settings-list m-0 flex list-none flex-col gap-1 p-0">
                {SETTINGS_SECTIONS.map((s) => (
                  <li key={s}>
                    <a href={settingsHref(s)} className={` ${navLink} min-h-13 text-base`}>
                      <Icon name={SECTIONS[s].icon} size={18} />
                      <span className="row-title flex-1">{SECTIONS[s].label}</span>
                      <Icon name="forward" size={16} />
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
  return (
    <>
      {shell}
      <Dialog open={leaving !== null} onOpenChange={(open) => !open && setLeaving(null)}>
        <DialogContent size="default" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>These edits haven't been saved and will be lost if you leave now.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" autoFocus onClick={() => setLeaving(null)}>
              Keep editing
            </Button>
            <Button type="button" variant="destructive" onClick={leave}>
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Mode (Auto, Light, Dark), kept on this device. It applies at once. */
function AppearanceSettings() {
  const { mode, setMode } = useTheme();
  const modeId = useId();
  return (
    <Field className="setting-row min-w-0 justify-between gap-5 py-5 [&+[data-slot=field]]:border-t setting-stack items-stretch py-5">
      <div className="setting-text min-w-0">
        <span id={`${modeId}-label`} className="setting-label text-sm font-medium">
          Mode
        </span>
        <FieldDescription>Auto follows your device</FieldDescription>
      </div>
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={0}
        value={mode}
        onValueChange={(v) => v && setMode(parseMode(v))}
        aria-labelledby={`${modeId}-label`}
      >
        {/* No Tip around Auto: Tooltip's trigger overwrites the toggle's data-state, so the pressed style never shows. */}
        {MODES.map((m) => (
          <ToggleGroupItem key={m.id} value={m.id} className="min-w-20">
            {m.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Field>
  );
}

/** Appearance, then Full mode: it shows each step, Inspect and Fork from a step. Kept on this device. */
function GeneralSettings({
  api,
  agents,
  companion,
  onLogout,
}: {
  api: Api;
  agents: Agent[];
  companion: Companion | null;
  onLogout: () => void;
}) {
  const { full, setFull } = useFullMode();
  const labelId = useId();
  const helpId = useId();
  return (
    <PageShell title="General" className="[&>.page-col]:gap-0 [&>.page-col>*+*]:border-t">
      <AppearanceSettings />
      <Field
        orientation="horizontal"
        className="setting-row min-w-0 justify-between gap-5 py-5 [&+[data-slot=field]]:border-t items-center justify-between border-t py-5"
      >
        <FieldContent className="setting-text min-w-0">
          <FieldTitle id={labelId} className="setting-label text-sm font-medium">
            Show details
          </FieldTitle>
          <FieldDescription id={helpId}>Steps, Inspect and Fork</FieldDescription>
        </FieldContent>
        <Switch checked={full} aria-labelledby={labelId} aria-describedby={helpId} onCheckedChange={setFull} />
      </Field>
      <PasskeySettings api={api} />
      <AccountSecurity api={api} />
      <DevicesSettings api={api} onLogout={onLogout} />
      <CompanionSetting api={api} agents={agents} companion={companion} />
      <TimeZoneSetting api={api} />
      <TitleSettings api={api} />
      <NotificationSettings api={api} />
      <Field className="setting-row min-w-0 justify-between gap-5 py-5 [&+[data-slot=field]]:border-t border-t py-5">
        <Button type="button" variant="outline" className="w-fit" onClick={onLogout}>
          <Icon name="logout" size={18} />
          Log out
        </Button>
      </Field>
    </PageShell>
  );
}
