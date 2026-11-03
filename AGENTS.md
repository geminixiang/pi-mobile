# pi mobile

Android app (Capacitor + React) running a pi-durable agent on the phone. See docs/architecture.md for the layout of the code.

- `npm run check` (tsc, Stylelint, no-comments, code rules, tool interface, contracts, just-bash patches) must pass before a commit.
- Before changing CSS, animations, or overlays, read `.pi/skills/css/SKILL.md`. No `!important`.
- Before designing or changing a screen, read `DESIGN.md`: the design language taken from the left drawer.
- UI copy is Traditional Chinese (zh-TW); model prompts are English.
- Code carries no comments, in any language: a comment marks a design flaw or a hidden bug. Make names, types, and
  structure say it; a reason that still needs words goes in `docs/`. The one exception is a constraint the code cannot
  express and the reader cannot guess (an OS quirk, a wire format, a measured limit), written as `// why: …` in one or
  two lines; `npm run check` fails on any other comment and counts the `why:` ones.
- Look before you leap (LBYL): check the precondition (it exists, is permitted, is available, parses) before acting.
  A failure no check can foresee (network, native I/O) surfaces to the user or becomes a named outcome; never
  swallow it with `catch(() => undefined)`.
- Validate an unknown value once, at the boundary that owns it (`src/agent/parse.ts`), and pass typed values inward; do not re-check what a type or schema already guarantees. No `any`; `as` only for `as const` and a narrowing TypeScript cannot express otherwise, never in place of validation; `as unknown as` only where a library's nominal type forces it, in one named function with its `why:`. `test/code-rules.ts` fails on `any`, `!`, `<T>` casts, `.catch(() => undefined)` and any `as` (other than `as const`) without a `// why:` line right above it.
- Split code by responsibility, not by size. Do not extract a helper used once; inline a value used once. A function reads as its happy path, with early returns instead of `else` and `const` instead of reassignment; supporting details go in named helpers below it only when they name a real concept.
- Write it inline first and compress later: code that repeats becomes shared on its third occurrence, not its second.
- Functional by default: pure functions and data pipelines (`filter`, `map`), side effects at the edges. Mutation inside a function (`push`, `Map.set`, a `for` loop) is fine when the function is pure from outside. A class only for something with a lifetime (a connection, a WebView).
- Errors are values: an outcome the caller should handle (not found, denied, unreachable) is a returned union such as `{ ok: false; reason: "denied" }`, not a `throw`. Throw only for a broken invariant, or where a library's contract expects it (a pi tool's `execute`, pi-env's `ExecutionEnv`).
- Make illegal states unrepresentable: a discriminated union (`{ state: "open"; socket } | { state: "closed"; reason }`), not booleans plus optional fields that must agree. React state with more than one moving part goes through `useReducer` over such a union, with pure transitions.
- Few regular expressions: reach for string methods (`startsWith`, `includes`, `split`, `slice`) or a real parser first. A regex is for a genuine pattern, kept short and held in a named constant; a long or stacked one is a sign the input wants parsing.
- Names are complete but not wordy: one precise word (`save`, not `saveFileToDiskAndNotify`), with types and placement carrying the rest.
- Code is grouped by feature: one folder holds a feature's UI, logic, plugin wrapper and tool (`src/browser/`). New features start that way; an existing feature moves into its folder when it is refactored.
- Android code is Kotlin from here on: new native files are Kotlin, and a Java file becomes Kotlin when it is refactored.
- Models to read like: the pi packages (`@earendil-works/*`), the Go standard library, and type-driven Elm/Rust code.
- Store a value once: what can be computed from state, props, or a store is computed where it is used, not kept in its own `useState`, ref, or field (keep the selected id, derive the selected item from the list).
- Before adding code for a speculative race, edge case, or security concern, state the concrete failure, how likely it is, and what the code costs, and get the user's buy-in; over-design is itself a mistake.
- Tests run the real implementation through the `Platform` seam: no mocks, no logic copied into the test. The only globals a test touches are `fetch` (made to throw: tests run offline) and `console` (captured to read log lines). A fix comes with a test that fails on the old code.
- Branch names are at most three words joined by hyphens, no slashes or type prefixes (`helpers`, `fix-scroll-state`). Commits are `type(scope): summary` with `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `style`.
- UI design: avoid unnecessary secondary labels and descriptions; let the layout do the explaining. No toasts: a result or an error shows where the action happened (the button's own label, under its section, in the composer); one with no place of its own goes at the end of the transcript, like a model error.
- A change to the transcript, scrolling, streaming, or an animation is measured on the S24 (120 Hz) with `test/perf/run.ts` (docs/development.md § 效能量測), before and after: only the scenes it touches, 3 runs. Code that runs every frame (the streaming render, scroll and gesture handlers, animations, how the transcript mounts rows) gets all scenes at 5 runs, and so does a release when anything since the last measured release changed what the screen does (`src/app/`, CSS, the WebView or native views); a release that changed none of it skips perf and says so in its commit. Virtualizing the transcript (react-virtuoso) was reverted for this: rows mounting while scrolling up dropped frames.
- Before a new tool or toolset goes in, measure it as `docs/tools.md` describes (`test/device/tool-cost.sh` on the S24, before and after, and natural questions in a temporary bot), choose always or on demand there, and update its table and log.
- Tools follow `docs/tools.md` § 介面規範: define them with `defineAppTool` (`src/agent/tools/common.ts`), install built-ins only through `src/agent/catalog.ts`, and list every tool in its tool list. `npm run check` enforces this and compares the interface with `test/tools.snapshot.json`; change a tool's name, parameters, or structured output only on purpose, then run `node --import ./test/vite-imports.js test/tools-node.ts --update` and say why in the log. Name an extension by `docs/tools.md` § 名稱 and keep it: per-bot toolset choices are stored by its name, so a rename also goes into `RENAMED` (`src/agent/toolsets.ts`).

## Structure

Finishing the task is half the job; the other half is leaving the design better for the next change. Every contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles, so the repo's shape decides what gets copied.

- Before adding to an existing design, ask: if this requirement had been there from day one, what would we build? Aim the change at that, delivered in small steps; do not bolt a special case onto the nearest function.
- Check what you touch and what you add for these red flags, and remove the ones you add:
  - one task done two ways (a check in TS and again in each native plugin, two ways to open a screen);
  - a module's internals used from outside it (another plugin reading `PhoneScreenService`);
  - a list kept in sync by hand (names repeated in code, docs, and tests);
  - one state or decision owned by more than one place;
  - a rule that lives only in prose when a check could enforce it.
- A change that touches structure (a new tool, plugin method, extension, or a shared helper) ends its report with 對未來的影響: the red flags it removes or adds, and what it leaves for later.
- A mistake that happens twice is fixed at the highest level that works: architecture (one owner, one way, unreachable internals), then types, then a check in `npm run check` whose error names the fix, then a test; prose last, and only for judgment calls. Add it to the table below.
- Skills for this (`.pi/skills/`, adapted from pstack): `architect` before a non-trivial shape, `blast-radius` before committing a change to something shared or stored, `correct` when the user corrects the same kind of mistake again.
- Say how you know: a claim in a report or a doc says whether it was run (a script or the app), read at `file:line`, or only assumed. A design doc counts and lists from the code (`grep`), not from memory.

| Rule | Enforced by |
|---|---|
| No comments except `// why:` | `test/no-comments.ts` |
| No `any`, `!`, casts, swallowed catches | `test/code-rules.ts` |
| Tools defined with `defineAppTool`, in the catalog, a toolset, the tool list, the snapshot | `test/tools-node.ts` |
| Every extension has a toolset or is in `ALWAYS_ON`, and `ALWAYS_ON` lists nothing stale | `test/tools-node.ts` |
| A tool that acts as the user is `*_as_user`, loaded on demand, in a `*_as_user` extension | `test/tools-node.ts` |
| docs/tools.md 工具總圖 matches the code | `test/tools-node.ts` |
| Tool names the UI branches on (`src/app`, every `.tsx`: `===`, `switch`, `includes`, `*TOOL*` lists and maps) are tools that exist | `test/tools-node.ts` |
| Native methods match their contract on Android and iOS | `test/plugins-node.ts` |
| Every step action and key the phone screen and the browser declare is read by their Kotlin side | `test/plugins-node.ts` |
| Every native plugin class is registered (`MainActivity`, `MainViewController`) | `test/plugins-node.ts` |
| Every schedule kind and activity in `src/triggers/plugin.ts` is read by the Android side (`Schedule.kt`, `ActivityTrigger.kt`) | `test/plugins-node.ts` |
| Every native call in a tool file is in its tools' `needs` or checked with `native.implements` first | `test/tools-node.ts` |
| A tool that needs a native method marked `opens: "screen"` declares `effect: "screen"`, and only the catalog calls `openScreen` | `test/tools-node.ts`, `test/code-rules.ts` |
| Only the phone screen code reaches the accessibility service; only `openScreen` and `keepAlive.ts` read `App.getState` | `test/code-rules.ts` |
| JSON is parsed only through `src/agent/parse.ts` | `test/code-rules.ts` |
| Only `src/agent/bots.ts` and the runtime touch the bot index (`BotIndex`); others read live bots with `botsIn` or `runtime.bots()` | `test/code-rules.ts` |
| Only `src/triggers/` touches the schedules (`TriggerDoc`; others use `triggersOf`, `editTriggers`), only `src/items/` and the trigger runner touch the items (`ItemDoc`) | `test/code-rules.ts` |
| A JSX `style` sets only `--custom-properties`; a `transition` never names a layout property | `test/code-rules.ts`, Stylelint (`stylelint/transition-no-layout.js`) |
| New Android files are Kotlin; the Java files left only shrink (`JAVA_LEFT`) | `test/code-rules.ts` |
| A renamed extension keeps each bot's choices: a shipped name that disappears must be in `RENAMED`, and opening the runtime applies it | `test/tools-node.ts` (`test/extensions.snapshot.json`), `test/contracts/bots.ts`, `test/toolsets.ts` |
| Which toolsets a bot on the phone or a computer gets, and which tools its prompt names, come from `where` in `toolsets.ts` (`isAt`, `offeredAt`) | `test/contracts/computers.ts`, `test/contracts/where.ts` |
| Every setting says whether it applies in place or restarts the runtime (`APPLY` in `runtime.ts`) | `tsc` |
| Every test file runs: contracts are found by `test/contracts/run.ts`, other test files are in the check script | `test/contracts/run.ts`, `test/registered.ts` |
| Device and perf scripts call only members `AgentRuntime` has | `test/device-api.ts` |
| LBYL, errors as values, store a value once, rule of three, one way to do a task | review only |
| A fix comes with a test that fails on the old code | review only |
| Structure red flags, 對未來的影響 | review only |
