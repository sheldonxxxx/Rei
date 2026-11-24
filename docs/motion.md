# Motion

How things arrive in the app. Tokens and keyframes live in `apps/web/src/styles/motion.css`; the React seam is `apps/web/src/lib/motion.ts`. The decision behind the shape is [ADR 0007](./adr/0007-motion-is-a-css-token-layer.md); the words are in `GLOSSARY.md`.

## The grammar

Four kinds, and the kind says what happened. Pick by meaning, never by taste.

| `data-enter` | Used for                                                                                                             | Budget                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `rise`       | Content a run produced is now present: an answer, a tool-activity row, a memory chip, a background result card       | 180ms, 4px up           |
| `card`       | An overlay asking you to act: approval, browser takeover                                                             | 200ms, 6px up           |
| `fade`       | Punctuation and status, not content: notices, markers, status flips, loaded rows, the toast, a page's content region | 180ms, no travel        |
| `scale`      | A surface taking the screen: dialogs, alert dialogs, sheets                                                          | 260ms, 0.98 scale + 6px |

What gets **no** arrival: your own message (you just typed it, so motion would read as lag), items already present when a region first painted, deleted items (an exit there would imply it can come back), and streaming text (see below).

## Adding an arrival

Add `data-enter="<kind>"` to the element that mounts. That is the whole API: no durations, no delays, no `useEffect`.

- **Siblings in sequence**: `style={enterIndex(i)}`. The CSS stagger step and its cap do the rest; never compute a delay in JS.
- **A region whose first paint must not replay**: wrap it in `<MotionRegion live={useRegionLive(key)}>` and pass a key that changes when the region becomes a different region — another chat, or the moment its first page of history lands. Rows inside a closed region get no `data-enter` at all, and the decision is taken at mount: a region that opens two frames later cannot start a late animation on content that was already there.
- **Delayed exits**: dialogs, sheets, menus, popovers and tooltips animate through `tw-animate-css`; they take their durations from the same tokens (`duration-(--motion-slow)`, `data-closed:duration-(--motion-exit)`). A new overlay primitive must do the same.

## Rules the tokens keep

1. Motion never delays information. No element waits behind another element's animation.
2. Motion never blocks input. Only `opacity` and `transform`; never `pointer-events`, never size, never a placeholder that swallows a click.
3. Motion never changes layout. A reveal that reflows fights the transcript's scroll anchoring, so a page region fades rather than rises (a `transform` on a full-height container would also reparent any fixed-position child for the duration).
4. Nothing exceeds `--motion-ceiling` (300ms), and leaving is faster than arriving.
5. Nothing animates that was already on screen: a chunk of loaded history arrives, it does not replay.
6. `prefers-reduced-motion: reduce` arrives instantly: `app.css` already ends every animation and transition app-wide, the tokens go to zero on top of that, the caret stops blinking, and JS-driven scrolling asks `prefersReducedMotion()` before easing.
7. `--motion-scale` is the one dial (`0.5` calmer, `0` none). `data-motion="flat"` on any ancestor sets it to zero for a whole subtree.

## Centred surfaces must not grow while they open

A dialog is sized by its content and centred with `top: 50%` + `translate: -50% -50%`, so any content that lands _after_ it paints moves the whole box: the open reads as a slide from below, not a surface taking the screen. A surface that fetches must therefore reserve the space it will fill — render the field, disabled, while its text is on the way (`AgentSettingsDialog`'s Instructions field does this) rather than adding the block when the request resolves. If a section cannot be reserved, hide the box until it has settled instead of letting it grow in place.

## Streaming

Streaming text is not animated token by token or block by block — a reveal fights a stream that already arrives in chunks and makes a fast model feel slow. The live tail carries a quiet block caret (`.md.streaming > p:last-child::after`), which stops the moment the run ends. Auto-follow scrolls instantly while a run is streaming and eases (`scrollTo({ behavior: "smooth" })`) once content is settled; both are suppressed while the user is scrolled up, and the easing is skipped under reduced motion. **Opening** a chat never eases: the transcript is still arriving page by page, so the first follow is an instant jump to the newest message (`opening` ref in `ChatView`).
