/** Layers: local 1/2/10, panels 20, assistant 30, modal 40, popup 50, tooltip/toast 60. */
/** Shared look of the panels beside the chat (sessions, inspector, browser). On phones they become sheets over the chat. */

/** The dimmed backdrop behind a sheet; wide screens have no sheet, so no backdrop. */
export const SHEET_SCRIM = "sheet-scrim fixed inset-0 z-20 hidden bg-black/40 max-md:block";

/** A panel's header row: title on the left, icon buttons on the right. */
export const PANEL_HEAD = "panel-head flex min-h-13 items-center justify-between gap-2 py-2 pr-2 pl-4";

/** A panel's title. */
export const PANEL_TITLE = "m-0 min-w-0 text-sm font-semibold";

/** The surface of a side panel. */
export const SIDE_PANEL = "flex min-h-0 flex-col border-l bg-sidebar";

/** A phone's full-screen sheet (browser, inspector). */
export const FULL_SHEET =
  "max-md:fixed max-md:inset-0 max-md:z-20 max-md:w-auto max-md:min-w-0 max-md:max-w-none max-md:flex-none max-md:border-l-0 max-md:bg-background max-md:pt-[var(--safe-t)] max-md:animate-[sheet-up_0.2s_ease-out]";
