# pi mobile

Android app (Capacitor + React) running a pi-durable agent on the phone. See README.md for the layout of the code.

- `npm run check` (TypeScript and Stylelint) must pass before a commit.
- Before changing CSS, animations, or overlays, read `.agents/skills/css/SKILL.md`. No `!important`.
- UI copy is Traditional Chinese (zh-TW); code comments and model prompts are English.
- A change to the transcript or scrolling is measured on the S24 (120 Hz) with `test/jank.sh`, before and after. Virtualizing the transcript (react-virtuoso) was reverted for this: rows mounting while scrolling up dropped frames.
