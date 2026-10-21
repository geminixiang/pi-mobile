# pi mobile

Android app (Capacitor + React) running a pi-durable agent on the phone. See docs/architecture.md for the layout of the code.

- `npm run check` (TypeScript and Stylelint) must pass before a commit.
- Before changing CSS, animations, or overlays, read `.agents/skills/css/SKILL.md`. No `!important`.
- UI copy is Traditional Chinese (zh-TW); code comments and model prompts are English.
- A change to the transcript or scrolling is measured on the S24 (120 Hz) with `test/jank.sh`, before and after. Virtualizing the transcript (react-virtuoso) was reverted for this: rows mounting while scrolling up dropped frames.
- Before a new tool or toolset goes in, measure it as `docs/tools.md` describes (`test/tool-cost.sh` on the S24, before and after, and natural questions in a temporary bot), choose always or on demand there, and update its table and log.
- Tools follow `docs/tools.md` § 介面規範: define them with `defineAppTool` (`src/agent/tools/common.ts`), install built-ins only through `src/agent/catalog.ts`, and list every tool in its tool list. `npm run check` enforces this and compares the interface with `test/tools.snapshot.json`; change a tool's name, parameters, or structured output only on purpose, then run `node --import ./test/vite-imports.mjs test/tools-node.ts --update` and say why in the log. Never rename an extension: per-bot toolset choices are stored by its name.
