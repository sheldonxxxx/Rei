# Browser refs identify a frame document

Status: accepted (2026-11-18).

Playwright restarts ref numbering in each document and resolves `aria-ref` against the latest accessibility snapshot. After navigation, a number the agent saved can identify a different control. Rei assigns each frame document a generation from a counter shared by its window and prefixes every exposed ref with it. A main-frame navigation retires every generation in the window. An iframe navigation retires the generations of the documents it replaces, so refs in the main page and unaffected sibling frames still work.

The driver checks document generations around each snapshot and retries once if they change. It checks the owning document again when resolving a ref and pins the target for the action. If an element is replaced in the same document, Rei can retry once when the role and name are unique in both snapshots. The replacement goes through the action's original checks.

Agent Chromium disables the back-forward cache. Playwright 1.64.1 can report `Invalid frame in aria-ref selector` for a ref from a fresh snapshot after a cache restore. A restore would also revive a document whose generation Rei retired. Back follows history and loads a fresh document. Keep the cache disabled until both restoration issues are handled.
