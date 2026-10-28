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

The side panels now use Base UI's Drawer (`src/app/SidePanel.tsx`), which follows the same pattern, and it is the
one to copy:

- Position comes from one variable Base UI sets on the element (`--drawer-swipe-movement-x`, 0 when settled).
- The settled position is plain CSS; a `transition` moves between them, turned off while `[data-swiping]`.
- Entry and exit use `[data-starting-style]` and `[data-ending-style]` (or CSS `@starting-style` for elements Base UI
  does not manage), not keyframes and not a "mount, then flip a class next frame" trick.
- Base UI decides when to unmount, after the transition.

For a new overlay, sheet, or gesture, look for the Base UI part first (`@base-ui/react`, already a dependency) before
writing gesture or presence code.

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
  hand; the thinking colors stay pi's. No rounded cards, shadows, or gradients beyond the page grid.

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
