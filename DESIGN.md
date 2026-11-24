# Design

The rules for how Rei's web app looks and behaves. Follow them when adding or changing UI. Where a rule has a longer home, it links there: motion is in [docs/motion.md](docs/motion.md) and the words used in the app are in [GLOSSARY.md](GLOSSARY.md).

## Engawa · 縁側

Engawa is Rei's visual language. Give conversation and long-form reading a warm, quiet canvas. Use tonal steps to set the navigation, content and Inspector apart. Give cards space and reserve elevation for floating elements. Use Rei’s monochrome cut-paper portrait with the wordmark in navigation and sign-in.

### Sumi & Warm Taupe

| Role | Light | Dark |
| --- | --- | --- |
| Canvas | `#f7f5f1` | `#1c1a19` |
| Sidebar and inset surfaces | `#eeeae5` | `#242120` |
| Cards and panels | `#fffefc` | `#302c29` |
| Primary text | `#292725` | `#eee9e2` |
| Supporting text | `#716b65` | `#b3aaa1` |
| Selected background | `#ded7cf` | `#544b45` |
| Primary accent and focus | `#736052` | `#ae9680` |
| Waiting and approval | `#927147` | `#c3a57b` |
| Borders and dividers | `#dcd6ce` | `#49423d` |
| Error and destructive actions | `#a93636` | `#ed998f` |

Keep the main surfaces neutral and use taupe sparingly for actions and focus. Give selected rows the selected background and a visible outline. Mark completed work with a neutral checkmark. Use ochre for work that needs attention. Use the stronger supporting color on inset and selected surfaces, and use `attention-text` for readable ochre labels. Reserve low-contrast borders for separators and use `control-border` for fields, checkboxes, radio buttons and switches.

Keep 16 px for conversation and reading, 12–14 px for metadata and 24–32 px for workspace titles. Use the system sans stack with CJK fallbacks. Apply tabular figures to counts, durations and numeric data. Use subtle separators for grouping and the stronger control border where an editable field needs a visible edge.

## Principles

- **Simple by default, inspectable on demand.** Simple mode is clean and quiet. Detail mode shows everything needed to trace what an agent did and why. Never make the simple view carry detail-mode clutter.
- **Less friction, not fewer features.** Cut steps, clicks, prompts and setup. Do not remove a capability to make the screen look simpler; move it, default it, or put it one level down.
- **Show state, don't hide it.** Loading, waiting for you, failed and empty each get a visible, plain-language state.

## Buttons

- **Prefer an icon to text.** A button is an icon button (`size="icon-sm"`, `variant="ghost"`) unless an icon cannot say it clearly. Use a text label only for a primary call to action, a dialog confirm (for example "Fork into a new chat"), or an action whose icon would be ambiguous.
- **Every icon button has a name and a tooltip.** Give it an `aria-label` and wrap it in `Tip`. The accessible name stays the full word ("Download", "Move to Trash") so screen readers and tests find it the same way as a text button.
- **Icons come from `components/Icon.tsx`.** Add a new name to that map instead of importing an icon library in a component.
- **Toggles show their state.** A toggle icon button sets `aria-expanded` or `aria-pressed` and changes variant when on.
- **One placement per action.** Do not repeat the same action on every card or row. Put per-item actions in the item's detail view or menu, and keep list items quiet. The Library file modal is the example: info, history, download and delete are icons in its header; the cards carry none of them.
- **Destructive means recoverable first.** The default delete moves the item to Trash. Permanent deletion needs a confirmation that says what will be lost and that it cannot be undone.

## Controls and layout

- **Reuse the primitives** in `apps/web/src/components/primitives/` (button, input, select, dialog, sheet, switch, tabs and the rest). Use `NativeSelect` for dropdowns. Do not hand-style a raw `<select>`, `<input>` or `<button>`.
- **Keep related controls on one row.** A search box, its filters and the page's main action share one aligned row at one height (`h-8` in page headers). Do not stack a small control above an input. Filters sit beside the search they filter, with active filters shown as removable chips next to them.
- **Wrap, don't overflow.** Rows of controls wrap on narrow screens. Nothing scrolls the page sideways, and tap targets stay usable on a phone.
- **Corners.** Cards and panels are rounded (`rounded-2xl`); pills, inputs and selects are fully rounded (`rounded-3xl`). Do not mix square corners in.
- **Spacing is consistent inside a group.** Items in a stack or toolbar use the same gap (`gap-2` for blocks of content, `gap-1.5` for tight control rows). A heading sits close to what it labels and further from the section above.

## Conversation

- **Messages sit in containers.** Your messages are right-aligned in a `bg-secondary` bubble. The assistant's replies are left-aligned in a `bg-muted` bubble. This holds in the full chat and in the expanded floating assistant; the compact peek card is the only place a reply appears without one.
- **The last paragraph in a bubble has no bottom margin.**
- **Tool activity is a quiet row, not a wall of text.** Detail shows the call. The simple view shows one line that says what was done.
- Blocks of code and tool calls stack with a visible gap and keep their own scroll.
- **Place each surface inline with its reply.** It sits inline where the agent placed it, changes in place, and shows a state label only when it is not idle. Its revisions and actions belong in Full mode's Inspector. See [docs/surfaces.md](docs/surfaces.md).

## Approvals and Inspect

- Give real permission requests an ochre edge and the heading “Approval needed.” Show the requesting agent, operation, destination when known and available scopes. Start with a one-time scope and explain when a broader grant can permit future actions. Make irreversible consequences explicit.
- **Show details** is available in Chat options and Settings. **Inspect** sits beside the chat on wide screens and opens as a sheet on phones. Keep the same run, surface and session labels at both widths.
- Keep ordinary Surfaces neutral. Put units and source context near the data, and preserve a text representation of charts. Wide tables scroll within their own region.

## Color, type and theme

- **Use theme tokens only** (`background`, `foreground`, `muted`, `secondary`, `primary`, `border`, `destructive`, `attention`, and the rest defined in `apps/web/src/index.css`). No hard-coded colors.
- **Dark mode follows `data-scheme` on `<html>`.** Never use a `.dark` class. Check any new UI in both schemes.
- `attention` marks something waiting for the user. `destructive` is for destructive actions and errors only.
- One sans family and one mono family. Mono is for code, tool calls, IDs and file contents.

## Motion

Follow [docs/motion.md](docs/motion.md). In short: motion says what happened, never delays information, never changes layout, and respects `prefers-reduced-motion`. Add an arrival with `data-enter`, never with ad-hoc durations.

## Accessibility

- Every control is reachable and operable by keyboard, with a visible focus ring.
- Icon-only controls have accessible names (see Buttons). Regions and dialogs have labels.
- Status changes that need attention use `role="status"` or `role="alert"`.
- Pair status colors with readable labels or accessible names. Check text at 4.5:1 and meaningful control edges and focus indicators at 3:1. Aim for 44 px targets for primary touch controls.

## Copy

- Plain words. Say what will happen ("The original stays as it is."), not what the system does.
- Use the terms in the glossary and keep each one identical everywhere (for example Knowledge, Memory review). The navigation names are Library, Knowledge and Background Activity; the recoverable bin is Trash.
- Empty states say what goes here and how it gets filled.

## Before calling UI work done

- Reuse an existing primitive or pattern before writing a new one.
- Add or update a focused test that finds the control by its accessible name.
- Look at it in a live browser, light and dark, wide and phone width, and record anything you could not check.
- Run `npm run verify` (see [AGENTS.md](AGENTS.md)).
