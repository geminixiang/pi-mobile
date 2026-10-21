---
name: css
description: Rules for pi mobile's CSS (src/app/styles.css, src/app/index.css). Read before adding or changing styles, animations, gestures that move elements, or overlays, and when reviewing CSS. Covers specificity, cascade layers instead of !important, one way of moving an element, and how npm run check enforces it.
---

# CSS in pi mobile

The stylesheet is plain CSS: `src/app/index.css` (entry, unlayered overrides) imports `src/app/styles.css` into the
`app` cascade layer. `npm run check` runs Stylelint (`stylelint.config.mjs`); a change is not done until it passes.

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

## 4. Other rules

- Colors, lines, spacing, and motion curves come from the custom properties at the top of `styles.css` (`--bg`,
  `--line`, `--accent`, `--ease`, ...). No new raw colors.
- `opacity` on a parent fades its children. To dim a backdrop behind a panel, make the backdrop a sibling of the
  panel, or change only its background color.
- No inline styles except custom properties that carry state; everything else is a class.
- Square edges, hairlines, monospace labels: follow the existing components (see the comment at the top of
  `styles.css`). No rounded cards, shadows, or gradients beyond pi.dev's page grid.

## Check

```sh
npm run check                # tsc and stylelint
npx stylelint "src/**/*.css" --fix
```

A visual change is checked on a device (`./test/ui.sh`, screenshots), not only by the linter.
