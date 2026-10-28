---
name: css
description: Rules for pi mobile's CSS (src/app/styles.css, src/app/index.css). Read before adding or changing styles, animations, gestures that move elements, or overlays, and when reviewing CSS. Covers specificity, cascade layers instead of !important, one way of moving an element, animating only opacity and transform, and how npm run check enforces it.
---

# CSS in pi mobile

The stylesheet is plain CSS: `src/app/index.css` (entry, unlayered overrides) imports `src/app/styles.css` into the
`app` cascade layer. `npm run check` runs Stylelint (`stylelint.config.js`); a change is not done until it passes.

Partly adapted from the Front-End Checklist's `specificity-management` and `styles-lint` skills (MIT,
https://github.com/thedaviddias/Front-End-Checklist), with this project's own rules from its bugs.

## 1. Never `!important`

`declaration-no-important` fails the check. `!important` wins by force, so the next rule that must win needs it too,
and soon nobody can tell which rule applies.

What to do instead, in this order:

1. **The selector is too weak?** Make it say what it styles: `.menu > .panel-memory` beats `.menu > button` because
   it is as specific and comes later. Do not add ids, repeat classes, or chain parents to win.
2. **One rule must beat every component** (the `hidden` attribute, reduced motion): put it in `index.css`, outside the
   `app` layer. Unlayered rules beat layered ones whatever their specificity. Keep that list to a handful.
3. **Two systems fight over one property** (an animation and a drag both setting `transform`): that is a design
   problem, not a specificity problem. See section 3.

## 2. Low, flat specificity

- Classes only. No id selectors (`selector-max-id: 0`); `#root` is `.root`.
- At most 4 compound selectors and specificity `0,4,2`. Long chains break when the markup moves.
- Give an element a class rather than reaching it through its parents (`.bot-count`, not `.bot-form > label > span em`).
- A condition that should add no specificity goes in `:where()`:
  `:where(.answer:has(> .steps:last-child) + .answer) > .steps:first-child`.
- One rule per selector (`no-duplicate-selectors`): a property is set in one place. Add to the existing rule.

## 3. One way of moving an element

An element's position, opacity, or size comes from one source. The side panels once moved two ways, keyframes for
opening and closing and a CSS variable for dragging, overridden with `!important` and timed against each other with
timers and effects; a frame where the timing slipped showed the panel fully open before the drag.

The side panels (`src/app/SidePanel.tsx`, gesture math in `sideGesture.ts`) are the one to copy. Like X's menu, a
panel does not slide over the app: the whole app (`.app`, the card) slides aside and the panel is already there
underneath.

- Position is one number per side, `--side-left` and `--side-right` from 0 (closed) to 1 (open) on the card, and
  `--side-reveal` on the panel, all registered with `@property` as not inherited, so a frame restyles those two
  elements and nothing inside them.
- Code owns the position the whole time: the finger while dragging, and a `requestAnimationFrame` settle of
  `SETTLE_MS` on release. A new drag or a new settle stops the running one and starts from where it is. CSS
  transitions and Web Animations were both tried and both left the iPhone showing the card halfway while the DOM
  said open or closed: WebKit's compositor kept a stale transform after an animation was taken over.
- A drag counts from where it was recognized as sideways, not from where the finger went down: counting from
  touch-down made the card jump by the slop on its first frame (15 to 25 px at the iPhone's 60 Hz). Ionic and
  Telegram re-anchor the same way. It stops at the edges.
- `[data-side-shown]` on the card (rounded corners, shadow) and `[data-open]` on the panel's viewport are on from
  the first frame of a drag or an open until a close has settled. Corners kept on all the time showed above the
  keyboard. The shield that takes taps and drags over the card is rendered only while React has the panel open, so it
  is gone as soon as a close starts and the conversation takes a tap or a scroll right after.
- The panels stay mounted under the card, `inert` when closed. Their content keeps `--side-inset` from the outer
  edge, so it is on screen from the reveal's first frame.
- Nothing on the card is painted by the card itself. The drafting grid is `.app::before`: as the card's own
  background, Chrome re-rasterized it on every frame the card moved (366 tiles over 31 frames on the emulator; 4
  with the pseudo-element). Check a change here with a trace that counts `Paint` and `RasterTask` per frame.
- `.root` clips its overflow. Without it the card pushed aside widened the page, and Android WebView grew the layout
  viewport to 767 px and kept it after the close, moving every fixed element and every touch a test computed from
  `innerHeight`.
- Measured on the iPhone 12 Pro in a 5,000-node conversation: no frame over 50 ms opening or closing, and a drag
  under 24 ms a frame (before the grid moved off the card).

Base UI's Drawer moved them before. Its swipe area ignores swipes that start on a button, link, or field, and it set
`pointer-events: none` on the wrapped content while open, which restyled the whole conversation: 11 ms at full speed,
50 to 70 ms per open or close on an idle iPhone. Base UI still runs the dialogs and the bottom sheet
(`src/app/Sheet.tsx`); before adopting another part of it for something the user drags, check what it does to the
content around it.

Before adding an animation to something that already moves, find what moves it and use that.

## 4. Animate opacity and transform

Animations run every frame, so what they change decides what they cost. `opacity` and `transform` are moved by the
compositor without repainting the element or laying out the page. Everything else costs a repaint (`filter`,
`box-shadow`, colors) or a layout (`width`, `height`, `margin`, `padding`, `top`, `left`, ...) on every frame.

- An animation that runs often or on many elements at once (list rows, anything during scrolling or streaming) uses
  only `opacity` and `transform`, and still costs something per element: the browser does not give each inline
  element its own layer, so it repaints them. Streamed words used to fade in, each in its own `<span>` with an
  `opacity` animation; on the S24 at 120 Hz that missed 61% of frames while streaming, and without it 9%.
  Streamed text is not animated.
- No `filter` in an animation, blur included.
- No `backdrop-filter` (Stylelint refuses it). The bar and the composer were frosted glass over the transcript;
  the blur was recomputed on the GPU every frame the text under them moved. Without it, streaming while scrolling
  on the S24 missed 12% of frames instead of 19%. Overlays are opaque: mix a tint into `--bg`, not into
  `transparent`. The bar and the composer fade the text out instead: a static gradient from `--bg` to
  transparent, `--edge-fade` deep, which the GPU only blends; measured on the S24, it costs no frames.
- A one-off highlight (the dial's jump flash) may animate `box-shadow` or a color; a tint is an inset shadow
  (`inset 0 0 0 999px rgb(255 255 255 / 0.1)`), not `filter: brightness()`.
- Measure a new animation on the S24 before and after with `test/perf/run.ts` (docs/development.md § 效能量測),
  and change one thing at a time: two changes measured together cannot tell which one helped. A style can be tried
  without a build: inject it into the page, as `INJECT_CSS` experiments in the perf commits did.

`pi-mobile/keyframes-compositor-only` (`stylelint/keyframes-compositor-only.js`) enforces the `@keyframes` part in
`npm run check`: opacity and transform, plus `box-shadow`, `background-color`, `color`, and `visibility`.

## 5. Other rules

- Colors, lines, spacing, and motion curves come from the custom properties at the top of `styles.css` (`--bg`,
  `--line`, `--accent`, `--ease`, ...). No new raw colors.
- Type sizes are roles, not values: `--fs-meta` (11, mono labels, times, counts), `--fs-code` (12.5, code and tool
  output), `--fs-small` (13, hints, chips, buttons), `--fs-body` (14, secondary text, tables), `--fs-ui` (15, rows,
  titles, the user's prompt), `--fs-prose` (16.5, answers and the composer), `--fs-heading`, `--fs-title`,
  `--fs-display`. Pick the role; a new size is a new role and needs a reason. Two sizes half a pixel apart read as a
  mistake, not a hierarchy.
- No `letter-spacing` on text that can be Chinese: tracking spreads CJK glyphs apart. Only Latin-only labels (a
  code block's language, the pairing code) keep it.
- Structural spacing steps by 4 (8, 12, 16, 20, 24), so content edges land on the drafting grid; `--space` (20) is
  the page inset and sits on a major grid line. 2, 6, and 10 are for optical spacing inside a component only.
- `opacity` on a parent fades its children. To dim a backdrop behind a panel, make the backdrop a sibling of the
  panel, or change only its background color.
- No inline styles except custom properties that carry state; everything else is a class.
- pi.dev's design language: evening blue (or moonstone paper), a faint drafting grid (4px minor, 20px major, a + at
  every major crossing, fading toward the bottom), square edges, hairline panels with monospace header strips, serif
  prose. Color comes only from the pi mark (coral, blue, yellow) and one accent blue; tool, message, thinking, and
  code block colors follow pi's theme rules: a code block is a full-width band like a tool row, on `toolPendingBg`,
  with `mdCodeBlock` text. The dark values are pi's `dark.json`. The light values are what pi's `system` theme
  (`generateSystemThemeColors` in pi-coding-agent's `system-theme.ts`) computes for this app's own colors as the
  terminal's: `--bg` as background, `--text` as foreground, and a palette of `--error` (red), `--ok` (green),
  `--yellow`, `--accent` (blue), `--custom-label` (magenta), `--blue` (cyan), and `--faint` (bright black). pi's
  `light.json` is made for a white terminal and looks cold on the paper `--bg`. Recompute rather than pick a value by
  hand; the thinking colors stay pi's. No rounded cards, shadows, or gradients beyond the page grid, with one exception: while a side panel pushes it aside, the app itself is a card with `--card-radius` corners and a soft `--card-shadow` (X's look; an edge line read as a frame).

## 6. Layout and copy

- **Optical alignment over arithmetic alignment.** Icons, text, and controls in one row share a visual centre, not
  the same box edge: an icon with visual weight on one side gets nudged; a 40px tap target holds a 16px glyph at its
  optical centre; text baselines line up across the row. Check at 2x on the device, not in the DOM inspector.
- **Nested shapes share one geometry.** The app is square-edged; a square inside a square stays square. If a shape
  ever gets a radius, the shape nested inside it uses the same centre with the radius reduced by the padding
  (concentric), never the same radius.
- **No explanatory copy.** No sentences telling the user what a screen is for, what will happen, or what to do next;
  the layout, the labels, and the empty state's one noun phrase do that. A hint is allowed only when it carries a
  fact the user cannot see (a count, a date, a limit). Error text says what failed, not why it might have.
- **No eyebrows.** No small uppercase label above a heading that repeats or decorates it; a strip label is a
  section's own title, not a caption over one. Hierarchy comes from size, weight, spacing, and whitespace. The
  only label above a title is one that adds a category or context the title does not say.
- **Few decisions, placed where the user already is deciding.** Do not open a choice the user did not come for.
  When a choice is unavoidable, put it in the control the user is already operating (the picker, the row's own
  action), with the common case as the default. Before adding an element, rank what is on the screen by what the
  user came for; the first thing the eye lands on must be the most important, and anything below the fold must be
  less important than everything above it.

## Check

```sh
npm run check                # tsc and stylelint
npx stylelint "src/**/*.css" --fix
```

A visual change is checked on a device (`./test/ui.sh`, screenshots), not only by the linter.
