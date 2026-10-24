# pi mobile

Android app (Capacitor + React) running a pi-durable agent on the phone. See docs/architecture.md for the layout of the code.

- `npm run check` (tsc, Stylelint, no-comments, tool interface, contracts, just-bash patches) must pass before a commit.
- Before changing CSS, animations, or overlays, read `.agents/skills/css/SKILL.md`. No `!important`.
- UI copy is Traditional Chinese (zh-TW); model prompts are English.
- Code carries no comments, in any language: a comment marks a design flaw or a hidden bug. Make names, types, and
  structure say it; a reason that still needs words goes in `docs/`. The one exception is a constraint the code cannot
  express and the reader cannot guess (an OS quirk, a wire format, a measured limit), written as `// why: …` in one or
  two lines; `npm run check` fails on any other comment and counts the `why:` ones.
- Look before you leap (LBYL): check the precondition (it exists, is permitted, is available, parses) before acting.
  A failure no check can foresee (network, native I/O) surfaces to the user or becomes a named outcome; never
  swallow it with `catch(() => undefined)`.
- Validate an unknown value once, at the boundary that owns it (`src/agent/parse.ts`), and pass typed values inward; do not re-check what a type or schema already guarantees. No `any`; `as` only for `as const` and a narrowing TypeScript cannot express otherwise, never in place of validation; `as unknown as` only where a library's nominal type forces it, in one named function with its `why:`.
- Split code by responsibility, not by size. Do not extract a helper used once; inline a value used once. A function reads as its happy path, with early returns instead of `else` and `const` instead of reassignment; supporting details go in named helpers below it only when they name a real concept.
- Before adding code for a speculative race, edge case, or security concern, state the concrete failure, how likely it is, and what the code costs, and get the user's buy-in; over-design is itself a mistake.
- Tests run the real implementation through the `Platform` seam: no mocks, no logic copied into the test. The only globals a test touches are `fetch` (made to throw: tests run offline) and `console` (captured to read log lines). A fix comes with a test that fails on the old code.
- Branch names are at most three words joined by hyphens, no slashes or type prefixes (`helpers`, `fix-scroll-state`). Commits are `type(scope): summary` with `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `style`.
- UI design: avoid unnecessary secondary labels and descriptions; let the layout do the explaining. No toasts: a result or an error shows where the action happened (the button's own label, under its section, in the composer); one with no place of its own goes at the end of the transcript, like a model error.
- A change to the transcript, scrolling, streaming, or an animation is measured on the S24 (120 Hz) with `test/perf/run.ts` (docs/development.md § 效能量測), before and after. Virtualizing the transcript (react-virtuoso) was reverted for this: rows mounting while scrolling up dropped frames.
- Before a new tool or toolset goes in, measure it as `docs/tools.md` describes (`test/tool-cost.sh` on the S24, before and after, and natural questions in a temporary bot), choose always or on demand there, and update its table and log.
- Tools follow `docs/tools.md` § 介面規範: define them with `defineAppTool` (`src/agent/tools/common.ts`), install built-ins only through `src/agent/catalog.ts`, and list every tool in its tool list. `npm run check` enforces this and compares the interface with `test/tools.snapshot.json`; change a tool's name, parameters, or structured output only on purpose, then run `node --import ./test/vite-imports.js test/tools-node.ts --update` and say why in the log. Never rename an extension: per-bot toolset choices are stored by its name.
